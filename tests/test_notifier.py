"""
Tests for the notification worker.

The worker runs as its own Lambda, so it is exercised here through
``function.handler`` with the SQS payload AWS actually delivers, against the
same database the API writes to.
"""

import importlib
import json
import pathlib
import sys

import pytest

from conftest import PASSWORD

NOTIFIER_ROOT = pathlib.Path(__file__).resolve().parents[1] / "backend" / "notifier"


@pytest.fixture(scope="module")
def notifier():
    """
    Import the worker with the test database settings already in place.

    Returns:
        module: The imported `function` module.
    """
    sys.path.insert(0, str(NOTIFIER_ROOT))
    try:
        import function

        yield importlib.reload(function)
    finally:
        sys.path.remove(str(NOTIFIER_ROOT))


def sqs_event(*messages):
    """
    Build the SQS event shape Lambda delivers.

    Args:
        *messages: Message bodies to include.

    Returns:
        dict: An SQS event.
    """
    return {
        "Records": [
            {"messageId": f"m{i}", "body": json.dumps(m), "receiptHandle": f"r{i}"}
            for i, m in enumerate(messages)
        ]
    }


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


def notifications_for(client, headers):
    """
    Read a person's feed through the API.

    Args:
        client: The test client.
        headers: That person's auth header.

    Returns:
        dict: The feed payload.
    """
    response = client.get("/notifications", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def test_fan_out_reaches_everyone_except_the_actor(notifier, client, world, incident):
    """
    A change notifies the reporter, the assignee and the admins - but not the
    person who made it, because telling someone what they just did is noise.
    """
    before = notifications_for(client, world["employee_h"])["unread"]

    written = notifier.handler(
        sqs_event({
            "event": "status_changed",
            "incident_id": incident["id"],
            "actor_id": world["admin"]["id"],
            "detail": "BLOCKED",
        })
    )
    assert written["batchItemFailures"] == []

    reporter = notifications_for(client, world["employee_h"])
    assert reporter["unread"] == before + 1
    assert "BLOCKED" in reporter["items"][0]["body"]
    assert reporter["items"][0]["incident_id"] == incident["id"]

    engineer = notifications_for(client, world["engineer_h"])
    assert engineer["unread"] >= 1

    # The admin caused it, so has nothing new from this event.
    admin_bodies = [n["body"] for n in notifications_for(client, world["admin_h"])["items"]]
    assert not any("BLOCKED" in b and str(incident["id"]) in b for b in admin_bodies)


def test_each_event_reads_as_a_sentence(notifier, client, world, incident):
    """Every supported event produces text naming the incident."""
    for event, expected in [
        ("assigned", "was assigned to"),
        ("escalated", "was escalated"),
        ("de_escalated", "is no longer escalated"),
        ("note_added", "has a new note from"),
    ]:
        notifier.handler(sqs_event({
            "event": event, "incident_id": incident["id"], "actor_id": world["admin"]["id"],
        }))
        feed = notifications_for(client, world["employee_h"])
        assert expected in feed["items"][0]["body"]
        assert f"#{incident['id']}" in feed["items"][0]["body"]


def test_an_unknown_event_is_ignored_rather_than_retried(notifier, client, world, incident):
    """
    A message the worker does not understand is dropped, not failed: retrying
    it would loop until it reached the dead-letter queue for no reason.
    """
    result = notifier.handler(sqs_event({
        "event": "teleported", "incident_id": incident["id"], "actor_id": world["admin"]["id"],
    }))
    assert result["batchItemFailures"] == []


def test_a_deleted_incident_is_ignored(notifier, client, world):
    """An event for an incident that has since been deleted produces nothing."""
    result = notifier.handler(sqs_event({
        "event": "status_changed", "incident_id": 999999, "actor_id": world["admin"]["id"], "detail": "OPEN",
    }))
    assert result["batchItemFailures"] == []


def test_a_bad_record_fails_alone(notifier, client, world, incident):
    """
    One unparseable record must not lose the rest of the batch, so it is
    reported individually and SQS retries only that message.
    """
    event = sqs_event({
        "event": "escalated", "incident_id": incident["id"], "actor_id": world["admin"]["id"],
    })
    event["Records"].append({"messageId": "bad", "body": "not json", "receiptHandle": "r"})

    result = notifier.handler(event)
    assert [f["itemIdentifier"] for f in result["batchItemFailures"]] == ["bad"]
    # ...and the good record still landed.
    assert "was escalated" in notifications_for(client, world["employee_h"])["items"][0]["body"]


def test_notifications_are_private_to_their_owner(client, world, notifier, incident):
    """One person cannot read or dismiss another's feed."""
    notifier.handler(sqs_event({
        "event": "escalated", "incident_id": incident["id"], "actor_id": world["admin"]["id"],
    }))
    mine = notifications_for(client, world["employee_h"])["items"][0]

    # A different employee cannot mark it read.
    assert client.post(f"/notifications/{mine['id']}/read", headers=world["other_h"]).status_code == 404
    assert client.post("/notifications/999999/read", headers=world["employee_h"]).status_code == 404


def test_marking_read_clears_the_badge(client, world, notifier, incident):
    """Reading one, then all, brings the unread count to zero."""
    notifier.handler(sqs_event({
        "event": "escalated", "incident_id": incident["id"], "actor_id": world["admin"]["id"],
    }))
    feed = notifications_for(client, world["employee_h"])
    assert feed["unread"] > 0

    first = client.post(f"/notifications/{feed['items'][0]['id']}/read", headers=world["employee_h"])
    assert first.status_code == 200 and first.json()["is_read"] is True

    cleared = client.post("/notifications/read-all", headers=world["employee_h"])
    assert cleared.status_code == 200
    assert notifications_for(client, world["employee_h"])["unread"] == 0


def test_unread_only_filters_the_feed(client, world, notifier, incident):
    """The feed can be narrowed to what has not been read."""
    notifier.handler(sqs_event({
        "event": "escalated", "incident_id": incident["id"], "actor_id": world["admin"]["id"],
    }))
    client.post("/notifications/read-all", headers=world["employee_h"])
    notifier.handler(sqs_event({
        "event": "note_added", "incident_id": incident["id"], "actor_id": world["admin"]["id"],
    }))

    unread = client.get("/notifications?unread_only=true", headers=world["employee_h"]).json()
    assert len(unread["items"]) == 1
    assert unread["items"][0]["is_read"] is False


def test_the_feed_requires_authentication(client):
    """Notifications are personal, so anonymous access is rejected."""
    assert client.get("/notifications").status_code == 401
