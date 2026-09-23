"""
Coverage for the equipment register and the maintenance analytics.

The analytics are rules, not a model, so they are tested the way rules should
be: build a unit with a known failure history and assert that the stated reason
comes back with it. Each test creates its own asset, because the review
rankings are global and a shared fixture would make every assertion depend on
what the other tests happened to create.
"""

import uuid
from datetime import date, timedelta

import pytest

from conftest import PASSWORD


def _unique(prefix: str) -> str:
    """
    Build a collision-proof asset code.

    Args:
        prefix: Readable prefix for the generated code.

    Returns:
        str: A unique asset tag.
    """
    return f"{prefix}-{uuid.uuid4().hex[:8].upper()}"


@pytest.fixture
def asset(client, world):
    """
    Register one projector at the shared fixture's seat.

    Returns:
        dict: The created asset.
    """
    response = client.post(
        "/assets",
        json={
            "code": _unique("AV-PROJ"),
            "name": "Ceiling projector, Meeting Room 3A",
            "asset_type": "PROJECTOR",
            "manufacturer": "Epson",
            "model": "EB-L200",
            "building_id": world["building"]["id"],
            "floor_id": world["floor"]["id"],
            "seat_id": world["seat"]["id"],
            "installed_on": "2024-01-15",
            "expected_life_months": 60,
        },
        headers=world["admin_h"],
    )
    assert response.status_code == 201, response.text
    return response.json()


def _colleague(client):
    """
    Register a throwaway employee and return its auth header.

    Returns:
        dict: A bearer ``Authorization`` header for the new account.
    """
    email = f"colleague-{uuid.uuid4().hex[:8]}@acme.inc"
    created = client.post(
        "/auth/register", json={"email": email, "full_name": "Casey Colleague", "password": PASSWORD}
    )
    assert created.status_code == 201, created.text
    login = client.post("/auth/login", json={"email": email, "password": PASSWORD})
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


def _report(client, world, asset_id, title="Projector will not power on"):
    """
    File one incident against an asset and return its id.

    Args:
        client: The test client.
        world: The shared fixture.
        asset_id: The unit that failed.
        title: Incident title.

    Returns:
        int: The new incident's id.
    """
    response = client.post(
        "/incidents",
        json={
            "title": title,
            "description": "Filed by the maintenance tests.",
            "category": "AV_EQUIPMENT",
            "building_id": world["building"]["id"],
            "floor_id": world["floor"]["id"],
            "seat_id": world["seat"]["id"],
            "asset_id": asset_id,
        },
        headers=world["employee_h"],
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


# --------------------------------------------------------------------------
# Register
# --------------------------------------------------------------------------
def test_assets_are_readable_by_every_persona(client, world, asset):
    """A reporter has to be able to say which unit failed."""
    for header in ("employee_h", "engineer_h", "admin_h"):
        response = client.get("/assets", headers=world[header])
        assert response.status_code == 200
        assert any(row["id"] == asset["id"] for row in response.json())


def test_only_admins_register_equipment(client, world):
    """The register is part of the estate, so it follows the estate's rules."""
    body = {"code": _unique("X"), "name": "Rogue unit", "asset_type": "PROJECTOR"}
    assert client.post("/assets", json=body, headers=world["employee_h"]).status_code == 403
    assert client.post("/assets", json=body, headers=world["engineer_h"]).status_code == 403


def test_asset_codes_are_unique(client, world, asset):
    """An asset tag identifies one unit, so a duplicate is refused."""
    response = client.post(
        "/assets",
        json={"code": asset["code"], "name": "Another unit", "asset_type": "PROJECTOR"},
        headers=world["admin_h"],
    )
    assert response.status_code == 400
    assert "already in use" in response.json()["error"]["message"]


def test_placement_must_line_up(client, world):
    """A unit cannot sit on a floor that is not in its building."""
    other = client.post("/buildings", json={"name": _unique("Annex")}, headers=world["admin_h"]).json()
    response = client.post(
        "/assets",
        json={
            "code": _unique("AV"),
            "name": "Misplaced",
            "asset_type": "PROJECTOR",
            "building_id": other["id"],
            "floor_id": world["floor"]["id"],
        },
        headers=world["admin_h"],
    )
    assert response.status_code == 400


def test_an_incident_carries_its_asset(client, world, asset):
    """The link is visible on the incident, not just in the analytics."""
    incident_id = _report(client, world, asset["id"])
    body = client.get(f"/incidents/{incident_id}", headers=world["admin_h"]).json()
    assert body["asset"]["id"] == asset["id"]
    assert body["asset"]["code"] == asset["code"]

    listed = client.get(f"/incidents?asset_id={asset['id']}", headers=world["admin_h"]).json()
    assert incident_id in [row["id"] for row in listed["items"]]


def test_an_unknown_asset_is_refused(client, world):
    """A dangling asset reference would make every per-unit figure wrong."""
    response = client.post(
        "/incidents",
        json={
            "title": "Filed against nothing",
            "description": "There is no such unit.",
            "category": "HARDWARE",
            "asset_id": 999999,
        },
        headers=world["employee_h"],
    )
    assert response.status_code == 400


def test_deleting_an_asset_keeps_its_incidents(client, world, asset):
    """History outlives the register: the fault happened either way."""
    incident_id = _report(client, world, asset["id"])
    assert client.delete(f"/assets/{asset['id']}", headers=world["admin_h"]).status_code == 204

    body = client.get(f"/incidents/{incident_id}", headers=world["admin_h"]).json()
    assert body["asset"] is None


# --------------------------------------------------------------------------
# Analytics
# --------------------------------------------------------------------------
# --------------------------------------------------------------------------
# Servicing
# --------------------------------------------------------------------------
def test_the_first_service_is_due_from_installation(client, world):
    """A unit never serviced is measured from the day it went in, not never."""
    created = client.post(
        "/assets",
        json={
            "code": _unique("HVAC"),
            "name": "Air handling unit",
            "asset_type": "HVAC_UNIT",
            "installed_on": (date.today() - timedelta(days=200)).isoformat(),
            "service_interval_months": 6,
        },
        headers=world["admin_h"],
    ).json()
    assert created["service_status"] == "overdue"
    assert created["days_until_service"] < 0


def test_recording_a_service_restarts_the_interval(client, world):
    """The whole point of the interval: it comes round again after a visit."""
    created = client.post(
        "/assets",
        json={
            "code": _unique("HVAC"),
            "name": "Air handling unit",
            "asset_type": "HVAC_UNIT",
            "installed_on": (date.today() - timedelta(days=400)).isoformat(),
            "service_interval_months": 6,
        },
        headers=world["admin_h"],
    ).json()
    assert created["service_status"] == "overdue"

    response = client.post(
        f"/assets/{created['id']}/service",
        json={"note": "Filters replaced, belts checked"},
        headers=world["admin_h"],
    )
    assert response.status_code == 200
    body = response.json()
    assert body["service_status"] == "ok"
    assert body["last_serviced_on"] == date.today().isoformat()
    # The visit is recorded, not overwritten by the next one.
    assert "Filters replaced" in body["notes"]


def test_a_service_cannot_be_recorded_in_the_future(client, world, asset):
    """Otherwise the next due date could be pushed out indefinitely."""
    future = (date.today() + timedelta(days=5)).isoformat()
    response = client.post(
        f"/assets/{asset['id']}/service", json={"serviced_on": future}, headers=world["admin_h"]
    )
    assert response.status_code == 400


def test_only_admins_record_a_service(client, world, asset):
    """The register is the admin's to keep, as with everything else on it."""
    for header in ("employee_h", "engineer_h"):
        assert client.post(f"/assets/{asset['id']}/service", json={}, headers=world[header]).status_code == 403


def test_overdue_servicing_is_its_own_review_reason(client, world):
    """A unit can be flagged for maintenance without ever having failed."""
    created = client.post(
        "/assets",
        json={
            "code": _unique("HVAC"),
            "name": "Neglected air handling unit",
            "asset_type": "HVAC_UNIT",
            "installed_on": (date.today() - timedelta(days=900)).isoformat(),
            "service_interval_months": 12,
        },
        headers=world["admin_h"],
    ).json()

    body = client.get("/maintenance/assets/review?flagged_only=true", headers=world["admin_h"]).json()
    row = next(item for item in body["items"] if item["id"] == created["id"])
    assert row["incident_count"] == 0
    assert any(reason.startswith("service overdue by") for reason in row["reasons"])
    assert row["service_status"] == "overdue"


def test_a_unit_with_no_interval_is_counted_not_flagged(client, world, asset):
    """An unanswered question about a unit is not the same as a failing unit."""
    body = client.get("/maintenance/summary", headers=world["admin_h"]).json()
    assert body["assets_without_service_interval"] >= 1

    review = client.get("/maintenance/assets/review", headers=world["admin_h"]).json()
    row = next(item for item in review["items"] if item["id"] == asset["id"])
    assert row["service_status"] == "unknown"
    assert not any("service" in reason for reason in row["reasons"])


def test_maintenance_is_staff_only(client, world):
    """Employees have neither the need nor the visibility for these figures."""
    for path in ("/maintenance/summary", "/maintenance/assets/review", "/maintenance/types"):
        assert client.get(path, headers=world["employee_h"]).status_code == 403
        assert client.get(path, headers=world["engineer_h"]).status_code == 200


def test_repeated_failures_flag_a_unit_for_review(client, world, asset):
    """Three failures inside the window is the rule, and it names itself."""
    for index in range(3):
        _report(client, world, asset["id"], title=f"Projector failure {index}")

    body = client.get("/maintenance/assets/review?flagged_only=true", headers=world["admin_h"]).json()
    row = next(item for item in body["items"] if item["id"] == asset["id"])
    assert row["needs_review"] is True
    assert row["recent_incident_count"] == 3
    assert any("3 failures in the last 90 days" in reason for reason in row["reasons"])
    assert row["location"] == "HQ North - Level 3 - 3A-12"


def test_a_healthy_unit_is_not_flagged(client, world, asset):
    """A warning that fires on everything is a warning nobody reads."""
    _report(client, world, asset["id"])
    body = client.get("/maintenance/assets/review", headers=world["admin_h"]).json()
    row = next(item for item in body["items"] if item["id"] == asset["id"])
    assert row["needs_review"] is False
    assert row["reasons"] == []


def test_a_unit_past_its_service_life_is_flagged(client, world):
    """Age alone is a reason, and one that needs no failures to be true."""
    installed = date.today() - timedelta(days=365 * 6)
    created = client.post(
        "/assets",
        json={
            "code": _unique("AV-OLD"),
            "name": "Elderly projector",
            "asset_type": "PROJECTOR",
            "building_id": world["building"]["id"],
            "installed_on": installed.isoformat(),
            "expected_life_months": 60,
        },
        headers=world["admin_h"],
    ).json()

    body = client.get("/maintenance/assets/review?flagged_only=true", headers=world["admin_h"]).json()
    row = next(item for item in body["items"] if item["id"] == created["id"])
    assert "past its expected service life" in row["reasons"]
    assert row["age_years"] >= 5.9


def test_retired_units_leave_the_analytics(client, world, asset):
    """A unit already taken out of service is not a replacement decision."""
    client.put(
        f"/assets/{asset['id']}",
        json={"retired_on": (date.today() - timedelta(days=1)).isoformat()},
        headers=world["admin_h"],
    )
    body = client.get("/maintenance/assets/review", headers=world["admin_h"]).json()
    assert asset["id"] not in [item["id"] for item in body["items"]]


def test_summary_reports_how_much_is_actually_linked(client, world, asset):
    """Coverage is the caveat on every other number, so it is reported first."""
    _report(client, world, asset["id"])
    client.post(
        "/incidents",
        json={"title": "Unattributed fault", "description": "No unit named.", "category": "OTHER"},
        headers=world["employee_h"],
    )

    body = client.get("/maintenance/summary", headers=world["admin_h"]).json()
    assert body["assets_tracked"] >= 1
    assert body["incidents_linked"] >= 1
    assert body["incidents_total"] > body["incidents_linked"]
    assert 0 < body["linked_percent"] < 100


def test_type_reliability_aggregates_by_class(client, world, asset):
    """The purchasing question: is this class of kit any good?"""
    _report(client, world, asset["id"])
    rows = client.get("/maintenance/types", headers=world["admin_h"]).json()
    projectors = next(row for row in rows if row["asset_type"] == "PROJECTOR")
    assert projectors["asset_count"] >= 1
    assert projectors["incident_count"] >= 1
    assert projectors["incidents_per_asset"] > 0


# --------------------------------------------------------------------------
# Visibility
# --------------------------------------------------------------------------
def test_an_engineer_sees_the_history_of_a_unit_they_are_working_on(client, world, asset):
    """
    The reason the rule was widened at all.

    An engineer sent to a projector needs to know it has failed before, and
    that history is mostly other people's tickets.
    """
    admin_h, engineer_h = world["admin_h"], world["engineer_h"]
    earlier = _report(client, world, asset["id"], title="Projector failed last month")
    mine = _report(client, world, asset["id"], title="Projector will not power on today")

    # Only the second one is theirs.
    client.post(f"/incidents/{mine}/assign", json={"engineer_id": world["engineer"]["id"]}, headers=admin_h)

    assert client.get(f"/incidents/{mine}", headers=engineer_h).status_code == 200
    assert client.get(f"/incidents/{earlier}", headers=engineer_h).status_code == 200

    client.post(f"/incidents/{mine}/assign", json={"engineer_id": None}, headers=admin_h)


def test_an_engineer_cannot_see_unrelated_work(client, world, asset):
    """
    Everything else is out of scope now that engineers cannot pick work up.

    Both of these were visible before: an unassigned incident, and one against
    a unit the engineer holds no work for.
    """
    engineer_h = world["engineer_h"]
    unassigned = client.post(
        "/incidents",
        json={"title": "Nobody is on this yet", "description": "Unassigned and unattributed.", "category": "OTHER"},
        headers=world["employee_h"],
    ).json()["id"]
    other_unit = _report(client, world, asset["id"], title="A fault on a unit they do not hold")

    assert client.get(f"/incidents/{unassigned}", headers=engineer_h).status_code == 404
    assert client.get(f"/incidents/{other_unit}", headers=engineer_h).status_code == 404


def test_an_employee_sees_only_what_they_reported(client, world, asset):
    """
    Unchanged, and worth pinning: equipment does not widen this.

    The colleague is registered here rather than borrowed from the shared
    fixture, whose `other` account is deactivated and re-roled by tests
    elsewhere in the suite.
    """
    colleague = _colleague(client)
    mine = _report(client, world, asset["id"])
    created = client.post(
        "/incidents",
        json={"title": "Someone else's fault", "description": "Filed by a colleague.", "category": "OTHER"},
        headers=colleague,
    )
    assert created.status_code == 201, created.text
    theirs = created.json()["id"]

    assert client.get(f"/incidents/{mine}", headers=world["employee_h"]).status_code == 200
    # Not 403: a 403 would confirm the id exists.
    assert client.get(f"/incidents/{theirs}", headers=world["employee_h"]).status_code == 404

    listed = client.get("/incidents", headers=world["employee_h"]).json()
    assert all(item["reporter"]["id"] == world["employee"]["id"] for item in listed["items"])


def test_an_engineer_without_a_profile_sees_nothing(client, world):
    """
    A new engineer account has no assignments, so it has no queue to read.

    Before engineers lost the ability to pick work up, this account would have
    seen every unassigned incident in the estate.
    """
    email = f"fresh-{uuid.uuid4().hex[:8]}@acme.inc"
    created = client.post(
        "/auth/register", json={"email": email, "full_name": "Fresh Engineer", "password": PASSWORD}
    )
    assert created.status_code == 201, created.text
    client.patch(
        f"/users/{created.json()['id']}/role", json={"role": "engineer"}, headers=world["admin_h"]
    )

    login = client.post("/auth/login", json={"email": email, "password": PASSWORD})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    assert client.get("/incidents", headers=headers).json()["total"] == 0
