"""
End-to-end tests for the facility incident management API.

Grouped by concern: service routes and CloudFront-prefixed routing,
authentication, role-based access control, facility CRUD, the incident
lifecycle, note visibility, engineer capacity, and dashboard aggregates.
"""

import pytest

from conftest import PASSWORD


# --------------------------------------------------------------------------
# Service routes and routing
# --------------------------------------------------------------------------
@pytest.mark.parametrize("path", ["/health", "/api/facility-api/health"])
def test_health_is_reachable_on_both_url_shapes(client, path):
    """Direct Function URL calls and CloudFront-prefixed calls both resolve."""
    response = client.get(path)
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_workflow_graph_is_published(client):
    """The UI can fetch the state machine instead of hard-coding it."""
    body = client.get("/workflow").json()
    assert {status["id"] for status in body["statuses"]} == {
        "OPEN",
        "IN_PROGRESS",
        "BLOCKED",
        "RESOLVED",
        "CLOSED",
    }
    assert {"from": "OPEN", "to": "IN_PROGRESS"} in body["transitions"]
    assert {"from": "OPEN", "to": "CLOSED"} not in body["transitions"]


def test_openapi_schema_is_generated(client):
    """`/docs` is backed by a valid schema."""
    assert client.get("/openapi.json").status_code == 200


def test_unknown_route_uses_the_shared_error_envelope(client):
    """Framework 404s are wrapped like every other error."""
    body = client.get("/api/facility-api/nope").json()
    assert set(body["error"]) == {"status", "type", "message", "details"}


# --------------------------------------------------------------------------
# Authentication
# --------------------------------------------------------------------------
def test_registration_requires_a_corporate_address(client, world):
    """Only @acme.inc addresses may self-register."""
    response = client.post(
        "/auth/register",
        json={"email": "someone@gmail.com", "full_name": "Nope", "password": PASSWORD},
    )
    assert response.status_code == 400
    assert response.json()["error"]["type"] == "validation_error"


def test_registration_rejects_duplicates(client, world):
    """A second registration for the same address conflicts."""
    response = client.post(
        "/auth/register",
        json={"email": "dana@acme.inc", "full_name": "Dana", "password": PASSWORD},
    )
    assert response.status_code == 409


def test_second_registration_is_an_employee(client, world):
    """Only the bootstrap account gets the admin role."""
    assert world["employee"]["role"] == "employee"


def test_login_rejects_a_wrong_password(client, world):
    """Bad credentials return 401 without revealing which half was wrong."""
    response = client.post("/auth/login", json={"email": "dana@acme.inc", "password": "nope-nope"})
    assert response.status_code == 401
    assert response.json()["error"]["type"] == "invalid_credentials"


@pytest.mark.parametrize(
    "headers,expected",
    [({}, 401), ({"Authorization": "Bearer not-a-token"}, 401), ({"Authorization": "Basic x"}, 401)],
)
def test_protected_routes_require_a_valid_bearer_token(client, world, headers, expected):
    """Missing, malformed and unverifiable tokens are all rejected."""
    assert client.get("/auth/me", headers=headers).status_code == expected


def test_me_returns_the_caller(client, world):
    """The token resolves back to the account that minted it."""
    assert client.get("/auth/me", headers=world["employee_h"]).json()["email"] == "dana@acme.inc"


def test_creating_an_engineer_profile_promotes_the_account(client, world):
    """`POST /engineers` is also the role promotion."""
    assert client.get("/auth/me", headers=world["engineer_h"]).json()["role"] == "engineer"


# --------------------------------------------------------------------------
# Facilities
# --------------------------------------------------------------------------
def test_employees_cannot_create_facilities(client, world):
    """Facility CRUD is admin-only."""
    response = client.post("/buildings", json={"name": "Shadow HQ"}, headers=world["employee_h"])
    assert response.status_code == 403
    assert response.json()["error"]["type"] == "forbidden"


def test_everyone_can_read_facilities(client, world):
    """Employees need the hierarchy to report an incident against a location."""
    assert client.get("/buildings", headers=world["employee_h"]).status_code == 200
    assert client.get(f"/seats/{world['seat']['id']}", headers=world["employee_h"]).status_code == 200


def test_duplicate_building_floor_and_seat_are_rejected(client, world):
    """Uniqueness is enforced per parent, not globally."""
    admin_h, building, floor = world["admin_h"], world["building"], world["floor"]
    assert client.post("/buildings", json={"name": "HQ North"}, headers=admin_h).status_code == 409
    assert (
        client.post(f"/buildings/{building['id']}/floors", json={"level": 3}, headers=admin_h).status_code
        == 409
    )
    assert (
        client.post(f"/floors/{floor['id']}/seats", json={"code": "3A-12"}, headers=admin_h).status_code
        == 409
    )


def test_building_update_requires_at_least_one_field(client, world):
    """An empty PUT is a client error rather than a silent no-op."""
    response = client.put(f"/buildings/{world['building']['id']}", json={}, headers=world["admin_h"])
    assert response.status_code == 400


def test_missing_facility_returns_not_found(client, world):
    """Unknown ids are 404, not 500."""
    assert client.get("/buildings/999999", headers=world["admin_h"]).status_code == 404


# --------------------------------------------------------------------------
# Incidents: creation and validation
# --------------------------------------------------------------------------
@pytest.fixture
def incident(client, world):
    """
    Report a fresh incident as the employee.

    Returns:
        dict: The created incident.
    """
    response = client.post(
        "/incidents",
        json={
            "title": "Projector will not power on",
            "description": "Meeting room 3A projector is dead since Monday.",
            "category": "AV_EQUIPMENT",
            "priority": "HIGH",
            "building_id": world["building"]["id"],
            "floor_id": world["floor"]["id"],
            "seat_id": world["seat"]["id"],
        },
        headers=world["employee_h"],
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_reported_incident_starts_open_with_its_location(client, world, incident):
    """A new incident is OPEN, unassigned and carries the resolved location."""
    assert incident["status"] == "OPEN"
    assert incident["assignee"] is None
    assert incident["location"]["building_name"] == "HQ North"
    assert incident["location"]["seat_code"] == "3A-12"
    assert incident["allowed_transitions"] == ["IN_PROGRESS", "BLOCKED", "RESOLVED"]


def test_unknown_location_is_rejected(client, world):
    """Location references are verified before the incident is stored."""
    response = client.post(
        "/incidents",
        json={"title": "T", "description": "D", "category": "HVAC", "seat_id": 999999},
        headers=world["employee_h"],
    )
    assert response.status_code == 400


def test_inconsistent_location_is_rejected(client, world):
    """A seat must belong to the floor it is reported against."""
    other_floor = client.post(
        f"/buildings/{world['building']['id']}/floors", json={"level": 9}, headers=world["admin_h"]
    ).json()
    response = client.post(
        "/incidents",
        json={
            "title": "T",
            "description": "D",
            "category": "HVAC",
            "floor_id": other_floor["id"],
            "seat_id": world["seat"]["id"],
        },
        headers=world["employee_h"],
    )
    assert response.status_code == 400


def test_unknown_category_is_rejected(client, world):
    """The category taxonomy is closed."""
    response = client.post(
        "/incidents",
        json={"title": "T", "description": "D", "category": "TELEPORTER"},
        headers=world["employee_h"],
    )
    assert response.status_code == 400


# --------------------------------------------------------------------------
# Incidents: visibility and editing
# --------------------------------------------------------------------------
def test_employees_only_see_their_own_incidents(client, world, incident):
    """Another employee gets 404 rather than 403, so ids are not enumerable."""
    assert client.get(f"/incidents/{incident['id']}", headers=world["other_h"]).status_code == 404
    assert client.get("/incidents", headers=world["other_h"]).json()["total"] == 0


def test_admins_see_everything(client, world, incident):
    """Facility admins have estate-wide visibility."""
    assert client.get(f"/incidents/{incident['id']}", headers=world["admin_h"]).status_code == 200


def test_filters_and_search_narrow_the_list(client, world, incident):
    """Status, text search and sorting combine on one query."""
    page = client.get(
        "/incidents?status=OPEN&q=projector&sort=priority&order=desc&limit=5",
        headers=world["admin_h"],
    ).json()
    assert page["limit"] == 5
    assert any(item["id"] == incident["id"] for item in page["items"])


def test_reporter_may_edit_while_open_but_not_reprioritise(client, world, incident):
    """Priority changes go through escalation, not a plain edit."""
    edit = client.put(
        f"/incidents/{incident['id']}", json={"title": "Projector dead in 3A"}, headers=world["employee_h"]
    )
    assert edit.status_code == 200
    bump = client.put(
        f"/incidents/{incident['id']}", json={"priority": "CRITICAL"}, headers=world["employee_h"]
    )
    assert bump.status_code == 403


def test_only_admins_delete_incidents(client, world, incident):
    """Deletion is destructive and therefore admin-only."""
    assert client.delete(f"/incidents/{incident['id']}", headers=world["employee_h"]).status_code == 403
    assert client.delete(f"/incidents/{incident['id']}", headers=world["admin_h"]).status_code == 204
    assert client.get(f"/incidents/{incident['id']}", headers=world["admin_h"]).status_code == 404


# --------------------------------------------------------------------------
# Incidents: assignment and workflow
# --------------------------------------------------------------------------
def test_assignment_records_acknowledgement(client, world, incident):
    """Assigning stamps both `assigned_at` and the first `acknowledged_at`."""
    response = client.post(
        f"/incidents/{incident['id']}/assign",
        json={"engineer_id": world["engineer"]["id"], "note": "Sam owns AV kit on this floor"},
        headers=world["admin_h"],
    )
    assert response.status_code == 200
    body = response.json()
    assert body["assignee"]["id"] == world["engineer"]["id"]
    assert body["assigned_at"] and body["acknowledged_at"]


def test_engineers_may_only_self_assign(client, world, incident):
    """An engineer cannot hand work to a colleague."""
    response = client.post(
        f"/incidents/{incident['id']}/assign", json={"engineer_id": 999999}, headers=world["engineer_h"]
    )
    assert response.status_code == 403


def test_employees_cannot_drive_the_workflow(client, world, incident):
    """Status changes belong to the assigned engineer or an admin."""
    response = client.post(
        f"/incidents/{incident['id']}/status", json={"status": "IN_PROGRESS"}, headers=world["employee_h"]
    )
    assert response.status_code == 403


def test_illegal_transitions_are_refused_with_the_allowed_set(client, world, incident):
    """A rejected transition tells the caller what would have been legal."""
    response = client.post(
        f"/incidents/{incident['id']}/status", json={"status": "CLOSED"}, headers=world["admin_h"]
    )
    assert response.status_code == 409
    assert response.json()["error"]["details"]["allowed"] == ["IN_PROGRESS", "BLOCKED", "RESOLVED"]


def test_blocking_and_resolving_require_an_explanation(client, world, incident):
    """The ticket history always explains why it stalled or how it ended."""
    admin_h = world["admin_h"]
    assert (
        client.post(f"/incidents/{incident['id']}/status", json={"status": "BLOCKED"}, headers=admin_h).status_code
        == 400
    )
    assert (
        client.post(f"/incidents/{incident['id']}/status", json={"status": "RESOLVED"}, headers=admin_h).status_code
        == 400
    )


def test_full_lifecycle_open_to_closed(client, world, incident):
    """Walk the happy path and check the timestamps it leaves behind."""
    admin_h, employee_h, iid = world["admin_h"], world["employee_h"], incident["id"]
    client.post(f"/incidents/{iid}/assign", json={"engineer_id": world["engineer"]["id"]}, headers=admin_h)
    engineer_h = world["engineer_h"]

    assert client.post(f"/incidents/{iid}/status", json={"status": "IN_PROGRESS"}, headers=engineer_h).status_code == 200
    blocked = client.post(
        f"/incidents/{iid}/status",
        json={"status": "BLOCKED", "reason": "Replacement lamp on back-order"},
        headers=engineer_h,
    ).json()
    assert blocked["blocked_reason"] == "Replacement lamp on back-order"

    resolved = client.post(
        f"/incidents/{iid}/status",
        json={"status": "RESOLVED", "resolution": "Swapped the projector lamp"},
        headers=engineer_h,
    ).json()
    assert resolved["resolved_at"] and resolved["blocked_reason"] is None

    # The reporter confirms the fix by closing their own resolved ticket.
    closed = client.post(f"/incidents/{iid}/status", json={"status": "CLOSED"}, headers=employee_h).json()
    assert closed["status"] == "CLOSED"
    assert closed["closed_at"] and closed["resolved_at"]
    assert closed["resolution"] == "Swapped the projector lamp"


def test_engineer_capacity_is_enforced(client, world):
    """An engineer at `max_active_incidents` cannot take more work."""
    admin_h, employee_h = world["admin_h"], world["employee_h"]
    engineer_id = client.post(
        "/engineers",
        json={"user_id": world["other"]["id"], "max_active_incidents": 1},
        headers=admin_h,
    ).json()["id"]

    created = [
        client.post(
            "/incidents",
            json={"title": f"Load {n}", "description": "d", "category": "OTHER"},
            headers=employee_h,
        ).json()
        for n in range(2)
    ]
    first = client.post(
        f"/incidents/{created[0]['id']}/assign", json={"engineer_id": engineer_id}, headers=admin_h
    )
    second = client.post(
        f"/incidents/{created[1]['id']}/assign", json={"engineer_id": engineer_id}, headers=admin_h
    )
    assert first.status_code == 200
    assert second.status_code == 400
    assert second.json()["error"]["type"] == "engineer_at_capacity"


# --------------------------------------------------------------------------
# Escalation and notes
# --------------------------------------------------------------------------
def test_employee_escalation_is_a_request_not_a_priority_change(client, world, incident):
    """Employees raise the flag; only admins actually move the priority."""
    response = client.post(
        f"/incidents/{incident['id']}/escalate",
        json={"is_escalated": True, "reason": "Blocking a client demo", "priority": "CRITICAL"},
        headers=world["employee_h"],
    )
    assert response.status_code == 200
    assert response.json()["is_escalated"] is True
    assert response.json()["priority"] == "HIGH"  # unchanged
    assert "CRITICAL" in response.json()["escalation_note"]


def test_only_admins_clear_an_escalation(client, world, incident):
    """De-escalation is an admin decision."""
    client.post(
        f"/incidents/{incident['id']}/escalate", json={"is_escalated": True}, headers=world["employee_h"]
    )
    assert (
        client.post(
            f"/incidents/{incident['id']}/escalate", json={"is_escalated": False}, headers=world["employee_h"]
        ).status_code
        == 403
    )
    cleared = client.post(
        f"/incidents/{incident['id']}/escalate", json={"is_escalated": False}, headers=world["admin_h"]
    )
    assert cleared.status_code == 200 and cleared.json()["is_escalated"] is False


def test_internal_notes_are_hidden_from_employees(client, world, incident):
    """Triage chatter stays out of the reporter's view."""
    iid = incident["id"]
    assert client.post(f"/incidents/{iid}/notes", json={"body": "Facilities notified."}, headers=world["employee_h"]).status_code == 201
    assert client.post(f"/incidents/{iid}/notes", json={"body": "secret", "is_internal": True}, headers=world["employee_h"]).status_code == 403
    assert client.post(f"/incidents/{iid}/notes", json={"body": "Triage: send Sam", "is_internal": True}, headers=world["admin_h"]).status_code == 201

    employee_notes = client.get(f"/incidents/{iid}/notes", headers=world["employee_h"]).json()
    admin_notes = client.get(f"/incidents/{iid}/notes", headers=world["admin_h"]).json()
    assert all(not note["is_internal"] for note in employee_notes)
    assert len(admin_notes) == len(employee_notes) + 1


def test_notes_cannot_be_added_to_a_closed_incident(client, world, incident):
    """Closed tickets are read-only."""
    iid = incident["id"]
    client.post(f"/incidents/{iid}/assign", json={"engineer_id": world["engineer"]["id"]}, headers=world["admin_h"])
    client.post(f"/incidents/{iid}/status", json={"status": "RESOLVED", "resolution": "done"}, headers=world["admin_h"])
    client.post(f"/incidents/{iid}/status", json={"status": "CLOSED"}, headers=world["admin_h"])
    response = client.post(f"/incidents/{iid}/notes", json={"body": "one more"}, headers=world["admin_h"])
    assert response.status_code == 409


# --------------------------------------------------------------------------
# Dashboard
# --------------------------------------------------------------------------
def test_summary_is_scoped_to_the_caller(client, world, incident):
    """An employee's dashboard counts only their own tickets."""
    admin = client.get("/dashboard/summary", headers=world["admin_h"]).json()
    employee = client.get("/dashboard/summary", headers=world["employee_h"]).json()
    stranger = client.get("/dashboard/summary", headers=world["other_h"]).json()

    assert admin["scope"] == "facility_admin" and employee["scope"] == "employee"
    assert admin["total"] >= employee["total"] > stranger["total"]
    assert {bucket["key"] for bucket in admin["by_status"]} <= {
        "OPEN",
        "IN_PROGRESS",
        "BLOCKED",
        "RESOLVED",
        "CLOSED",
    }


def test_hotspots_rank_locations(client, world, incident):
    """Recurring-issue locations come back labelled and ranked."""
    body = client.get("/dashboard/hotspots?limit=3", headers=world["admin_h"]).json()
    assert body["buildings"][0]["label"] == "HQ North"
    assert body["floors"][0]["label"].startswith("HQ North - Level 3")
    assert all(bucket["count"] >= bucket["open_count"] for bucket in body["buildings"])


def test_sla_reports_durations(client, world, incident):
    """Timing averages are present once incidents exist."""
    body = client.get("/dashboard/sla", headers=world["admin_h"]).json()
    assert body["sample_size"] > 0
    assert set(body) == {
        "acknowledged_hours_avg",
        "assigned_hours_avg",
        "resolved_hours_avg",
        "closed_hours_avg",
        "resolved_count",
        "sample_size",
    }


def test_engineer_workload_is_admin_only(client, world):
    """Work distribution is management information."""
    assert client.get("/dashboard/engineers", headers=world["employee_h"]).status_code == 403
    rows = client.get("/dashboard/engineers", headers=world["admin_h"]).json()
    assert any(row["engineer_id"] == world["engineer"]["id"] for row in rows)


# --------------------------------------------------------------------------
# Account administration
# --------------------------------------------------------------------------
def test_admin_cannot_strand_the_deployment(client, world):
    """The last active admin can neither demote nor deactivate themselves."""
    admin_h, admin_id = world["admin_h"], world["admin"]["id"]
    assert client.patch(f"/users/{admin_id}/status", json={"is_active": False}, headers=admin_h).status_code == 403
    assert client.patch(f"/users/{admin_id}/role", json={"role": "employee"}, headers=admin_h).status_code == 403


def test_deactivated_accounts_cannot_use_their_token(client, world):
    """Revocation takes effect on the next request, not at token expiry."""
    victim = client.post(
        "/auth/register",
        json={"email": "temp@acme.inc", "full_name": "Temp Worker", "password": PASSWORD},
    ).json()
    headers = {
        "Authorization": "Bearer "
        + client.post("/auth/login", json={"email": "temp@acme.inc", "password": PASSWORD}).json()[
            "access_token"
        ]
    }
    assert client.get("/auth/me", headers=headers).status_code == 200
    client.patch(f"/users/{victim['id']}/status", json={"is_active": False}, headers=world["admin_h"])
    response = client.get("/auth/me", headers=headers)
    assert response.status_code == 403
    assert response.json()["error"]["type"] == "account_disabled"


def test_user_listing_is_filterable(client, world):
    """Admins can slice the roster by role and free text."""
    assert client.get("/users?role=employee", headers=world["admin_h"]).status_code == 200
    rows = client.get("/users?q=sam", headers=world["admin_h"]).json()
    assert [row["email"] for row in rows] == ["sam@acme.inc"]
    assert client.get("/users", headers=world["employee_h"]).status_code == 403
