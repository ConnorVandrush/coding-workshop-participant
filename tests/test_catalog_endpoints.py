"""
Coverage for the facility and engineer catalogue endpoints.

`test_facility_api.py` concentrates on the incident workflow and on the rules
that protect a deployment. This module covers the remaining reads and the
destructive operations, which need records of their own: deleting anything the
shared `world` fixture owns would break the rest of the session.
"""

import uuid

import pytest

from conftest import PASSWORD


@pytest.fixture
def throwaway_building(client, world):
    """
    Create a building with one floor and one seat, for destructive tests.

    Yields:
        dict: ``{"building": ..., "floor": ..., "seat": ...}``.
    """
    admin_h = world["admin_h"]

    def created(response):
        """Assert a create succeeded, so a failure is not a bare KeyError later."""
        assert response.status_code == 201, response.text
        return response.json()

    # uuid4, not id(object()): CPython reuses the address of a temporary that is
    # collected immediately, so id(object()) repeats and the names collide.
    suffix = uuid.uuid4().hex[:8]
    building = created(client.post(
        "/buildings",
        json={"name": f"Scratch Tower {suffix}", "address": "1 Temporary Way"},
        headers=admin_h,
    ))
    floor = created(client.post(
        f"/buildings/{building['id']}/floors", json={"level": 7, "name": "Scratch"}, headers=admin_h
    ))
    seat = created(client.post(
        f"/floors/{floor['id']}/seats", json={"code": "S7-01", "description": "temp"}, headers=admin_h
    ))
    return {"building": building, "floor": floor, "seat": seat}


# --------------------------------------------------------------------------
# Service metadata
# --------------------------------------------------------------------------
def test_service_metadata_is_public(client):
    """The root endpoint identifies the deployment without authentication."""
    response = client.get("/")
    assert response.status_code == 200
    body = response.json()
    assert body["service"] == "facility-api"
    assert body["docs"].endswith("/docs")


# --------------------------------------------------------------------------
# Facility reads
# --------------------------------------------------------------------------
def test_floors_of_a_building_are_listed_in_order(client, world, throwaway_building):
    """Floors come back lowest level first, with their seat counts."""
    building_id = throwaway_building["building"]["id"]
    response = client.get(f"/buildings/{building_id}/floors", headers=world["employee_h"])
    assert response.status_code == 200
    floors = response.json()
    assert [floor["level"] for floor in floors] == sorted(floor["level"] for floor in floors)
    assert floors[0]["seat_count"] == 1


def test_single_floor_carries_its_parent_building(client, world, throwaway_building):
    """A floor is readable on its own and names the building it belongs to."""
    floor = throwaway_building["floor"]
    response = client.get(f"/floors/{floor['id']}", headers=world["employee_h"])
    assert response.status_code == 200
    assert response.json()["building_name"] == throwaway_building["building"]["name"]


def test_seats_of_a_floor_can_be_searched(client, world, throwaway_building):
    """Seats are listable, and the code filter narrows them."""
    floor_id = throwaway_building["floor"]["id"]
    assert len(client.get(f"/floors/{floor_id}/seats", headers=world["employee_h"]).json()) == 1
    assert client.get(f"/floors/{floor_id}/seats?q=nothing", headers=world["employee_h"]).json() == []


def test_floor_and_seat_reads_404_when_missing(client, world):
    """Unknown ids are 404, not 500."""
    assert client.get("/floors/999999", headers=world["admin_h"]).status_code == 404
    assert client.get("/seats/999999", headers=world["admin_h"]).status_code == 404
    assert client.get("/floors/999999/seats", headers=world["admin_h"]).status_code == 404
    assert client.get("/buildings/999999/floors", headers=world["admin_h"]).status_code == 404


# --------------------------------------------------------------------------
# Facility updates
# --------------------------------------------------------------------------
def test_floor_can_be_relabelled(client, world, throwaway_building):
    """A floor's level and name are editable by a facility admin."""
    floor = throwaway_building["floor"]
    response = client.put(f"/floors/{floor['id']}", json={"name": "Renamed"}, headers=world["admin_h"])
    assert response.status_code == 200
    assert response.json()["name"] == "Renamed"


def test_floor_level_cannot_collide_within_a_building(client, world, throwaway_building):
    """Two floors in one building may not share a level."""
    admin_h = throwaway_building and world["admin_h"]
    building_id = throwaway_building["building"]["id"]
    other = client.post(f"/buildings/{building_id}/floors", json={"level": 8}, headers=admin_h).json()
    response = client.put(f"/floors/{other['id']}", json={"level": 7}, headers=admin_h)
    assert response.status_code == 409
    assert response.json()["error"]["type"] == "conflict"


def test_seat_can_be_relabelled(client, world, throwaway_building):
    """A seat's code and description are editable."""
    seat = throwaway_building["seat"]
    response = client.put(
        f"/seats/{seat['id']}", json={"code": "S7-02", "description": "moved"}, headers=world["admin_h"]
    )
    assert response.status_code == 200
    assert response.json()["code"] == "S7-02"


def test_seat_code_cannot_collide_within_a_floor(client, world, throwaway_building):
    """Two seats on one floor may not share a code."""
    floor_id = throwaway_building["floor"]["id"]
    admin_h = world["admin_h"]
    other = client.post(f"/floors/{floor_id}/seats", json={"code": "S7-99"}, headers=admin_h).json()
    response = client.put(f"/seats/{other['id']}", json={"code": "S7-01"}, headers=admin_h)
    assert response.status_code == 409


def test_employees_cannot_edit_the_hierarchy(client, world, throwaway_building):
    """Facility structure is admin-only, on every verb."""
    floor = throwaway_building["floor"]
    seat = throwaway_building["seat"]
    employee_h = world["employee_h"]
    assert client.put(f"/floors/{floor['id']}", json={"name": "x"}, headers=employee_h).status_code == 403
    assert client.put(f"/seats/{seat['id']}", json={"code": "x"}, headers=employee_h).status_code == 403
    assert client.delete(f"/floors/{floor['id']}", headers=employee_h).status_code == 403
    assert client.delete(f"/seats/{seat['id']}", headers=employee_h).status_code == 403


# --------------------------------------------------------------------------
# Facility deletion
# --------------------------------------------------------------------------
def test_deleting_a_seat_updates_the_floor_count(client, world, throwaway_building):
    """Removing a seat is reflected in its floor's seat count."""
    floor_id = throwaway_building["floor"]["id"]
    seat_id = throwaway_building["seat"]["id"]
    assert client.delete(f"/seats/{seat_id}", headers=world["admin_h"]).status_code == 204
    assert client.get(f"/seats/{seat_id}", headers=world["admin_h"]).status_code == 404
    assert client.get(f"/floors/{floor_id}", headers=world["admin_h"]).json()["seat_count"] == 0


def test_deleting_a_floor_takes_its_seats_with_it(client, world, throwaway_building):
    """Floors cascade to seats."""
    floor_id = throwaway_building["floor"]["id"]
    seat_id = throwaway_building["seat"]["id"]
    assert client.delete(f"/floors/{floor_id}", headers=world["admin_h"]).status_code == 204
    assert client.get(f"/floors/{floor_id}", headers=world["admin_h"]).status_code == 404
    assert client.get(f"/seats/{seat_id}", headers=world["admin_h"]).status_code == 404


def test_deleting_a_building_cascades_through_the_hierarchy(client, world, throwaway_building):
    """Buildings cascade to floors and seats."""
    building_id = throwaway_building["building"]["id"]
    floor_id = throwaway_building["floor"]["id"]
    assert client.delete(f"/buildings/{building_id}", headers=world["admin_h"]).status_code == 204
    assert client.get(f"/buildings/{building_id}", headers=world["admin_h"]).status_code == 404
    assert client.get(f"/floors/{floor_id}", headers=world["admin_h"]).status_code == 404


def test_deleting_a_missing_record_is_404(client, world):
    """Deleting something that is not there reports 404 rather than succeeding."""
    admin_h = world["admin_h"]
    assert client.delete("/buildings/999999", headers=admin_h).status_code == 404
    assert client.delete("/floors/999999", headers=admin_h).status_code == 404
    assert client.delete("/seats/999999", headers=admin_h).status_code == 404


# --------------------------------------------------------------------------
# Engineers
# --------------------------------------------------------------------------
def test_engineer_roster_reports_live_capacity(client, world):
    """The roster carries each engineer's active count and capacity flag."""
    response = client.get("/engineers", headers=world["employee_h"])
    assert response.status_code == 200
    engineer = next(e for e in response.json() if e["id"] == world["engineer"]["id"])
    assert engineer["max_active_incidents"] == 2
    assert engineer["has_capacity"] == (engineer["active_incidents"] < 2)


def test_engineer_roster_can_be_searched_and_filtered(client, world):
    """Name search and the availability filter both narrow the roster."""
    admin_h = world["admin_h"]
    assert len(client.get("/engineers?q=Okafor", headers=admin_h).json()) == 1
    assert client.get("/engineers?q=nobody", headers=admin_h).json() == []
    available = client.get("/engineers?available_only=true", headers=admin_h).json()
    assert all(item["has_capacity"] for item in available)


def test_single_engineer_is_readable(client, world):
    """An engineer profile is readable on its own."""
    engineer_id = world["engineer"]["id"]
    response = client.get(f"/engineers/{engineer_id}", headers=world["employee_h"])
    assert response.status_code == 200
    assert response.json()["email"] == "sam@acme.inc"
    assert client.get("/engineers/999999", headers=world["admin_h"]).status_code == 404


def test_engineer_profile_can_be_updated(client, world):
    """Specialties, availability and capacity are editable by an admin."""
    engineer_id = world["engineer"]["id"]
    response = client.put(
        f"/engineers/{engineer_id}",
        json={"specialties": ["NETWORK"], "max_active_incidents": 3},
        headers=world["admin_h"],
    )
    assert response.status_code == 200
    assert response.json()["specialties"] == ["NETWORK"]
    assert response.json()["max_active_incidents"] == 3
    # Restore, so later tests still see the capacity they expect.
    client.put(
        f"/engineers/{engineer_id}",
        json={"specialties": ["AV_EQUIPMENT", "HARDWARE"], "max_active_incidents": 2},
        headers=world["admin_h"],
    )


def test_engineer_update_rejects_an_empty_payload(client, world):
    """An update with nothing in it is a client error, not a silent no-op."""
    response = client.put(f"/engineers/{world['engineer']['id']}", json={}, headers=world["admin_h"])
    assert response.status_code == 400
    assert client.put("/engineers/999999", json={"phone": "x"}, headers=world["admin_h"]).status_code == 404


def test_employees_cannot_manage_the_roster(client, world):
    """Engineer administration is admin-only."""
    engineer_id = world["engineer"]["id"]
    assert client.put(f"/engineers/{engineer_id}", json={"phone": "x"}, headers=world["employee_h"]).status_code == 403
    assert client.delete(f"/engineers/{engineer_id}", headers=world["employee_h"]).status_code == 403


def test_removing_a_profile_unassigns_work_and_demotes_the_account(client, world):
    """
    Deleting an engineer profile must not strand their incidents.

    Their open work becomes unassigned so it can be picked up again, and the
    account drops to employee rather than keeping an engineer's permissions.
    """
    admin_h = world["admin_h"]
    user = client.post(
        "/auth/register",
        json={"email": "temp.engineer@acme.inc", "full_name": "Temp Engineer", "password": PASSWORD},
    ).json()
    profile = client.post(
        "/engineers", json={"user_id": user["id"], "max_active_incidents": 5}, headers=admin_h
    ).json()

    incident = client.post(
        "/incidents",
        json={"title": "Work for a temp engineer", "description": "d", "category": "OTHER"},
        headers=world["employee_h"],
    ).json()
    client.post(f"/incidents/{incident['id']}/assign", json={"engineer_id": profile["id"]}, headers=admin_h)

    assert client.delete(f"/engineers/{profile['id']}", headers=admin_h).status_code == 204

    reloaded = client.get(f"/incidents/{incident['id']}", headers=admin_h).json()
    assert reloaded["assignee"] is None
    assert reloaded["assigned_at"] is None
    assert client.get(f"/users/{user['id']}", headers=admin_h).json()["role"] == "employee"
    assert client.delete(f"/engineers/{profile['id']}", headers=admin_h).status_code == 404


# --------------------------------------------------------------------------
# Accounts
# --------------------------------------------------------------------------
def test_single_account_is_readable_by_an_admin(client, world):
    """An account is readable on its own, and only by a facility admin."""
    admin_h = world["admin_h"]
    response = client.get(f"/users/{world['employee']['id']}", headers=admin_h)
    assert response.status_code == 200
    assert response.json()["email"] == "dana@acme.inc"
    assert "password_hash" not in response.json()
    assert client.get("/users/999999", headers=admin_h).status_code == 404
    assert client.get(f"/users/{world['employee']['id']}", headers=world["employee_h"]).status_code == 403
