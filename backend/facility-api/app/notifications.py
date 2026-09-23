"""
Deferred notification fan-out, using an outbox.

Telling everyone about a change is fan-out: one status change can concern the
reporter, the assigned engineer and every facility admin. Doing that inside the
request would add latency to a workflow transition, and a failure to notify
would fail a state change that has already been agreed.

**Why an outbox and not a queue.** SQS with an event source mapping is the
usual answer, and an asynchronous Lambda invocation is the usual fallback.
Neither is available here: the functions run in a VPC that has no NAT gateway
and no interface endpoint for Lambda or SQS, so an in-VPC function cannot reach
those control-plane APIs at all - a call simply hangs until the request times
out. `ec2:CreateVpcEndpoint` is denied too, so that cannot be fixed from here.

What is always reachable is the database the function is already connected to.
So the causing request records the bare event - one cheap insert - and the
expansion into a row per recipient happens later, drained by whoever reads
their feed next, or by `backend/notifier` where something can invoke it. The
expensive work is off the request that caused it, which is the point.
"""

import logging
from typing import Any, Optional

from app.database import cursor

logger = logging.getLogger(__name__)

# What each event says. The incident number is prefixed by `_compose`.
TEMPLATES = {
    "assigned": "was assigned to {assignee}",
    "status_changed": "moved to {detail}",
    "escalated": "was escalated",
    "de_escalated": "is no longer escalated",
    "note_added": "has a new note from {actor}",
}

# How many events one drain will process. Bounded so the reader who happens to
# trigger it never pays for an unbounded backlog.
DRAIN_BATCH = 25

# Give up after this many attempts, so one poisonous event cannot be retried
# forever at every reader's expense.
MAX_ATTEMPTS = 5


def enqueue(event: str, incident_id: int, actor_id: int, detail: Optional[str] = None) -> bool:
    """
    Record an incident event for later fan-out.

    This is one insert into a table the connection is already using, so it adds
    negligible time to the request that caused the change.

    Args:
        event: What happened, e.g. ``assigned`` or ``status_changed``.
        incident_id: The incident the event concerns.
        actor_id: The user who caused it; they are not notified about their own
            action.
        detail: Optional extra context, such as the new status.

    Returns:
        bool: True when recorded. A failure is logged and swallowed: a missing
        notification must never undo the workflow change it describes.
    """
    try:
        with cursor() as cur:
            cur.execute(
                """
                INSERT INTO notification_events (event, incident_id, actor_id, detail)
                VALUES (%s, %s, %s, %s)
                """,
                (event, incident_id, actor_id, detail),
            )
        return True
    except Exception as exc:  # noqa: BLE001 - never fail the caller's workflow
        logger.error("Could not record notification event for incident %s: %s", incident_id, exc)
        return False


def _compose(cur, row: dict[str, Any]) -> Optional[str]:
    """
    Turn an outbox row into the sentence a person reads.

    Args:
        cur: An open cursor.
        row: The outbox row.

    Returns:
        str | None: The text, or None when the event is unknown or the incident
        has since been deleted.
    """
    template = TEMPLATES.get(row["event"])
    if template is None:
        logger.warning("Ignoring unknown notification event: %s", row["event"])
        return None

    cur.execute(
        """
        SELECT i.id, i.title, au.full_name AS assignee, ac.full_name AS actor
        FROM incidents i
        LEFT JOIN engineer_profiles e ON e.id = i.assignee_id
        LEFT JOIN users au ON au.id = e.user_id
        LEFT JOIN users ac ON ac.id = %(actor)s
        WHERE i.id = %(incident)s
        """,
        {"incident": row["incident_id"], "actor": row["actor_id"]},
    )
    incident = cur.fetchone()
    if incident is None:
        return None

    phrase = template.format(
        assignee=incident.get("assignee") or "an engineer",
        actor=incident.get("actor") or "someone",
        detail=row.get("detail") or "a new state",
    )
    return f"#{incident['id']} \"{incident['title']}\" {phrase}"


def drain(limit: int = DRAIN_BATCH) -> int:
    """
    Expand pending outbox events into notifications.

    Rows are claimed with ``FOR UPDATE SKIP LOCKED`` so that concurrent Lambda
    containers draining at the same time never process the same event twice and
    never block one another.

    Args:
        limit: Maximum events to process in this pass.

    Returns:
        int: How many events were processed.
    """
    processed = 0
    try:
        with cursor(transactional=True) as cur:
            cur.execute(
                """
                SELECT id, event, incident_id, actor_id, detail, attempts
                FROM notification_events
                WHERE processed_at IS NULL AND attempts < %s
                ORDER BY id
                LIMIT %s
                FOR UPDATE SKIP LOCKED
                """,
                (MAX_ATTEMPTS, limit),
            )
            events = list(cur.fetchall())

            for row in events:
                body = _compose(cur, row)
                if body is not None:
                    cur.execute(
                        """
                        INSERT INTO notifications (user_id, incident_id, event, body)
                        SELECT u.id, %(incident)s, %(event)s, %(body)s
                        FROM users u
                        WHERE u.is_active
                          AND u.id <> COALESCE(%(actor)s, 0)
                          AND (
                                u.id = (SELECT reporter_id FROM incidents WHERE id = %(incident)s)
                             OR u.id = (
                                    SELECT e.user_id FROM engineer_profiles e
                                    JOIN incidents i ON i.assignee_id = e.id
                                    WHERE i.id = %(incident)s
                                )
                             OR u.role = 'facility_admin'
                          )
                        """,
                        {
                            "incident": row["incident_id"],
                            "event": row["event"],
                            "body": body,
                            "actor": row["actor_id"],
                        },
                    )
                # Marked processed either way: an unknown event or a deleted
                # incident will never succeed, so retrying it is pure cost.
                cur.execute(
                    "UPDATE notification_events SET processed_at = NOW(), attempts = attempts + 1 WHERE id = %s",
                    (row["id"],),
                )
                processed += 1
    except Exception as exc:  # noqa: BLE001 - draining is best effort
        logger.error("Notification drain failed: %s", exc)

    if processed:
        logger.info("Expanded %s notification event(s)", processed)
    return processed
