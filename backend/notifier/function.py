"""
Notification worker.

Consumes incident events from SQS and expands each one into a notification per
interested person. This exists so that fan-out happens off the request: a
status change should not wait on notifying several people, and a failure here
must not undo a workflow transition that has already been agreed.

Terraform discovers this folder from its requirements.txt and deploys it as a
python3.13 Lambda with handler ``function.handler``, the same convention the
API uses. Delivery is an SQS event source mapping, so failures are retried by
SQS and eventually land in the dead-letter queue rather than being lost.
"""

import json
import logging
import os
from typing import Any, Iterable

import psycopg
from psycopg.rows import dict_row

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

IS_LOCAL = os.getenv("IS_LOCAL", "false").lower() == "true"

DSN = " ".join(
    [
        f"host={os.getenv('POSTGRES_HOST', 'localhost')}",
        f"port={os.getenv('POSTGRES_PORT', '5432')}",
        f"dbname={os.getenv('POSTGRES_NAME', 'postgres')}",
        f"user={os.getenv('POSTGRES_USER', 'postgres')}",
        f"password={os.getenv('POSTGRES_PASS', '')}",
        f"sslmode={'prefer' if IS_LOCAL else 'require'}",
        "connect_timeout=15",
        "application_name=notifier",
    ]
)

# Reused across warm invocations, like the API's connection.
_CONNECTION: psycopg.Connection | None = None

# What each event says. The incident number is appended by the caller.
TEMPLATES = {
    "assigned": "was assigned to {assignee}",
    "status_changed": "moved to {detail}",
    "escalated": "was escalated",
    "de_escalated": "is no longer escalated",
    "note_added": "has a new note from {actor}",
}


def _connection() -> psycopg.Connection:
    """
    Return the pooled connection, reconnecting when it has been closed.

    Returns:
        psycopg.Connection: A live connection with dict rows.
    """
    global _CONNECTION
    if _CONNECTION is None or _CONNECTION.closed:
        _CONNECTION = psycopg.connect(DSN, autocommit=True, row_factory=dict_row)
    return _CONNECTION


def recipients_for(cursor: psycopg.Cursor, incident_id: int, actor_id: int) -> list[dict[str, Any]]:
    """
    Work out who should hear about a change to an incident.

    The reporter and the assigned engineer always care. Facility admins are
    included because they own the queue as a whole. The person who made the
    change is excluded: telling someone what they just did is noise.

    Args:
        cursor: An open cursor.
        incident_id: The incident that changed.
        actor_id: The user who caused the change.

    Returns:
        list[dict]: Rows of ``{id, full_name}`` to notify.
    """
    cursor.execute(
        """
        SELECT DISTINCT u.id, u.full_name
        FROM users u
        WHERE u.is_active
          AND u.id <> %(actor)s
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
        {"incident": incident_id, "actor": actor_id},
    )
    return list(cursor.fetchall())


def compose(cursor: psycopg.Cursor, message: dict[str, Any]) -> str | None:
    """
    Turn a queued event into the sentence a person reads.

    Args:
        cursor: An open cursor.
        message: The decoded queue message.

    Returns:
        str | None: The notification text, or None for an unknown event or a
        missing incident.
    """
    template = TEMPLATES.get(message.get("event", ""))
    if template is None:
        logger.warning("Ignoring unknown event: %s", message.get("event"))
        return None

    cursor.execute(
        """
        SELECT i.id, i.title, au.full_name AS assignee, ac.full_name AS actor
        FROM incidents i
        LEFT JOIN engineer_profiles e ON e.id = i.assignee_id
        LEFT JOIN users au ON au.id = e.user_id
        LEFT JOIN users ac ON ac.id = %(actor)s
        WHERE i.id = %(incident)s
        """,
        {"incident": message["incident_id"], "actor": message.get("actor_id")},
    )
    incident = cursor.fetchone()
    if incident is None:
        # Deleted between the event and this invocation; nothing to say.
        logger.info("Incident %s no longer exists", message["incident_id"])
        return None

    phrase = template.format(
        assignee=incident.get("assignee") or "an engineer",
        actor=incident.get("actor") or "someone",
        detail=message.get("detail") or "a new state",
    )
    return f"#{incident['id']} \"{incident['title']}\" {phrase}"


def process(message: dict[str, Any]) -> int:
    """
    Expand one event into notification rows.

    Args:
        message: The decoded queue message.

    Returns:
        int: How many notifications were written.
    """
    connection = _connection()
    with connection.cursor() as cursor:
        body = compose(cursor, message)
        if body is None:
            return 0

        people = recipients_for(cursor, message["incident_id"], message.get("actor_id", 0))
        if not people:
            return 0

        cursor.executemany(
            """
            INSERT INTO notifications (user_id, incident_id, event, body)
            VALUES (%s, %s, %s, %s)
            """,
            [(person["id"], message["incident_id"], message["event"], body) for person in people],
        )
        return len(people)


def handler(event: dict[str, Any] | None = None, context: Any = None) -> dict[str, Any]:
    """
    Lambda entry point for SQS batches.

    A record that cannot be processed is reported through
    ``batchItemFailures`` so SQS retries just that message and eventually sends
    it to the dead-letter queue, rather than replaying the whole batch.

    Args:
        event: The SQS event.
        context: The Lambda context.

    Returns:
        dict: Partial batch failure response.
    """
    records: Iterable[dict[str, Any]] = (event or {}).get("Records", [])
    failures: list[dict[str, str]] = []
    written = 0

    for record in records:
        try:
            written += process(json.loads(record["body"]))
        except Exception as exc:  # noqa: BLE001 - one bad record must not stop the batch
            logger.exception("Could not process record %s: %s", record.get("messageId"), exc)
            failures.append({"itemIdentifier": record.get("messageId", "")})

    logger.info("Wrote %s notification(s) from %s record(s)", written, len(list(records)))
    return {"batchItemFailures": failures}
