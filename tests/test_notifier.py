"""
Tests for the deferred notification fan-out.

The API records an event in an outbox; the expansion into a row per recipient
happens later. Both drains are covered: the bounded one the API performs when
someone reads their feed, and the full one the worker Lambda performs when
something can invoke it.
"""

import pathlib
import sys

import pytest

NOTIFIER_ROOT = pathlib.Path(__file__).resolve().parents[1] / "backend" / "notifier"


@pytest.fixture(scope="module")
def worker():
    """
    Import the worker Lambda with the test database settings in place.

    Returns:
        module: The imported `function` module.
    """
    sys.path.insert(0, str(NOTIFIER_ROOT))
    try:
        import importlib

        import function

        yield importlib.reload(function)
    finally:
        sys.path.remove(str(NOTIFIER_ROOT))


@pytest.fixture
def incident(client, world):
    """
    Report an incident assigned to the seeded engineer.

    Returns:
        dict: The incident.
    """
    created = client.post(
        "/incidents",
        json={"title": "Notifier subject", "description": "d", "category": "OTHER"},
        headers=world["employee_h"],
    ).json()
    client.post(
        f"/incidents/{created['id']}/assign",
        json={"engineer_id": world["engineer"]["id"]},
        headers=world["admin_h"],
    )
    return created


def feed(client, headers):
    """
    Read a person's feed through the API, which also drains the outbox.

    Args:
        client: The test client.
        headers: That person's auth header.

    Returns:
        dict: The feed payload.
    """
    response = client.get("/notifications", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_a_workflow_change_records_an_event_without_expanding_it(client, world, incident):
    """
    The causing request does one cheap insert. Expansion is somebody else's
    problem, which is the whole point of doing it this way.
    """
    from app.database import fetch_one

    before = fetch_one("SELECT COUNT(*)::int AS n FROM notification_events WHERE processed_at IS NULL")["n"]
    client.post(
        f"/incidents/{incident['id']}/escalate",
        json={"is_escalated": True, "reason": "because"},
        headers=world["admin_h"],
    )
    after = fetch_one("SELECT COUNT(*)::int AS n FROM notification_events WHERE processed_at IS NULL")["n"]
    assert after == before + 1


def test_reading_the_feed_expands_pending_events(client, world, incident):
    """A reader drains the outbox, so the count they see is never stale."""
    before = feed(client, world["employee_h"])["unread"]
    client.post(
        f"/incidents/{incident['id']}/status",
        json={"status": "BLOCKED", "reason": "waiting on parts"},
        headers=world["admin_h"],
    )

    after = feed(client, world["employee_h"])
    assert after["unread"] == before + 1
    assert "BLOCKED" in after["items"][0]["body"]
    assert after["items"][0]["incident_id"] == incident["id"]


def test_fan_out_reaches_everyone_except_the_actor(client, world, incident):
    """
    The reporter and the assigned engineer hear about a change; the person who
    made it does not, because telling someone what they just did is noise.
    """
    client.get("/notifications", headers=world["admin_h"])  # drain anything pending
    admin_before = len(feed(client, world["admin_h"])["items"])

    client.post(
        f"/incidents/{incident['id']}/escalate",
        json={"is_escalated": True, "reason": "safety"},
        headers=world["admin_h"],
    )

    assert feed(client, world["employee_h"])["unread"] >= 1
    assert feed(client, world["engineer_h"])["unread"] >= 1
    assert len(feed(client, world["admin_h"])["items"]) == admin_before


def test_the_worker_drains_the_same_outbox(worker, client, world, incident):
    """
    Where something can invoke the worker it clears the backlog, so no reader
    has to. Both drains claim rows with SKIP LOCKED, so they cannot collide.
    """
    client.get("/notifications", headers=world["employee_h"])
    client.post(
        f"/incidents/{incident['id']}/escalate",
        json={"is_escalated": True, "reason": "worker path"},
        headers=world["admin_h"],
    )

    assert worker.handler({}) == {"processed": 1}
    # Nothing left for the next pass.
    assert worker.handler({}) == {"processed": 0}
    assert feed(client, world["employee_h"])["unread"] >= 1


def test_each_event_reads_as_a_sentence(worker, client, world, incident):
    """Every supported event produces text naming the incident."""
    from app.notifications import enqueue

    for event, expected in [
        ("assigned", "was assigned to"),
        ("escalated", "was escalated"),
        ("de_escalated", "is no longer escalated"),
        ("note_added", "has a new note from"),
    ]:
        enqueue(event, incident["id"], world["admin"]["id"])
        worker.handler({})
        latest = feed(client, world["employee_h"])["items"][0]
        assert expected in latest["body"]
        assert f"#{incident['id']}" in latest["body"]


def test_an_unknown_event_is_retired_rather_than_retried(worker, world, incident):
    """
    An event the worker cannot render will never succeed, so it is marked
    processed instead of being retried at every reader's expense.
    """
    from app.database import fetch_one
    from app.notifications import enqueue

    enqueue("teleported", incident["id"], world["admin"]["id"])
    worker.handler({})
    pending = fetch_one("SELECT COUNT(*)::int AS n FROM notification_events WHERE processed_at IS NULL")
    assert pending["n"] == 0


def test_a_deleted_incident_is_retired(worker, client, world):
    """An event whose incident has since gone produces nothing and is retired."""
    from app.database import execute, fetch_one

    created = client.post(
        "/incidents",
        json={"title": "Doomed", "description": "d", "category": "OTHER"},
        headers=world["employee_h"],
    ).json()
    from app.notifications import enqueue

    enqueue("escalated", created["id"], world["admin"]["id"])
    execute("DELETE FROM incidents WHERE id = %s", (created["id"],))

    worker.handler({})
    assert fetch_one("SELECT COUNT(*)::int AS n FROM notification_events WHERE processed_at IS NULL")["n"] == 0


def test_notifications_are_private_to_their_owner(client, world, incident):
    """One person cannot read or dismiss another's feed."""
    client.post(
        f"/incidents/{incident['id']}/escalate",
        json={"is_escalated": True, "reason": "privacy"},
        headers=world["admin_h"],
    )
    mine = feed(client, world["employee_h"])["items"][0]

    assert client.post(f"/notifications/{mine['id']}/read", headers=world["other_h"]).status_code == 404
    assert client.post("/notifications/999999/read", headers=world["employee_h"]).status_code == 404


def test_marking_read_clears_the_badge(client, world, incident):
    """Reading one, then all, brings the unread count to zero."""
    client.post(
        f"/incidents/{incident['id']}/escalate",
        json={"is_escalated": True, "reason": "badge"},
        headers=world["admin_h"],
    )
    current = feed(client, world["employee_h"])
    assert current["unread"] > 0

    one = client.post(f"/notifications/{current['items'][0]['id']}/read", headers=world["employee_h"])
    assert one.status_code == 200 and one.json()["is_read"] is True

    assert client.post("/notifications/read-all", headers=world["employee_h"]).status_code == 200
    assert feed(client, world["employee_h"])["unread"] == 0


def test_unread_only_filters_the_feed(client, world, incident):
    """The feed can be narrowed to what has not been read."""
    client.post(
        f"/incidents/{incident['id']}/escalate",
        json={"is_escalated": True, "reason": "one"},
        headers=world["admin_h"],
    )
    feed(client, world["employee_h"])
    client.post("/notifications/read-all", headers=world["employee_h"])

    client.post(
        f"/incidents/{incident['id']}/notes",
        json={"body": "a public note"},
        headers=world["admin_h"],
    )
    unread = client.get("/notifications?unread_only=true", headers=world["employee_h"]).json()
    assert len(unread["items"]) == 1
    assert unread["items"][0]["is_read"] is False


def test_internal_notes_are_not_announced(client, world, incident):
    """Employees cannot see internal notes, so they are not told about them."""
    feed(client, world["employee_h"])
    client.post("/notifications/read-all", headers=world["employee_h"])

    client.post(
        f"/incidents/{incident['id']}/notes",
        json={"body": "triage only", "is_internal": True},
        headers=world["admin_h"],
    )
    assert feed(client, world["employee_h"])["unread"] == 0


def test_the_feed_requires_authentication(client):
    """Notifications are personal, so anonymous access is rejected."""
    assert client.get("/notifications").status_code == 401
