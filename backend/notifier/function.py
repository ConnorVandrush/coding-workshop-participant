"""
Notification worker.

Expands pending notification events into a row per interested person.

The API records events in a `notification_events` outbox rather than sending
them anywhere. The functions run in a VPC with no NAT gateway and no interface
endpoint for Lambda or SQS, so an in-VPC function cannot reach those
control-plane APIs - a call hangs until the request times out - and
`ec2:CreateVpcEndpoint` is denied, so that cannot be fixed from here. The
database is the only thing always reachable, so it carries the handoff.

This worker does the expansion away from any user request. Where something can
invoke it - LocalStack, an operator, a scheduler if one ever becomes available
- it drains the whole backlog. Where nothing can, the API drains a bounded
batch when someone reads their feed, so the work still happens off the request
that caused it.

Terraform discovers this folder from its requirements.txt and deploys it as a
python3.13 Lambda with handler ``function.handler``, the same convention the
API uses.
"""

import logging
import os
from typing import Any, Optional

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

# What each event says. The incident number is prefixed by `compose`.
TEMPLATES = {
    "assigned": "was assigned to {assignee}",
    "status_changed": "moved to {detail}",
    "escalated": "was escalated",
    "de_escalated": "is no longer escalated",
    "note_added": "has a new note from {actor}",
}

MAX_ATTEMPTS = 5

# Reused across warm invocations, like the API's connection.
_CONNECTION: Optional[psycopg.Connection] = None


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


def compose(cursor: psycopg.Cursor, row: dict[str, Any]) -> Optional[str]:
    """
    Turn an outbox row into the sentence a person reads.

    Args:
        cursor: An open cursor.
        row: The outbox row.

    Returns:
        str | None: The text, or None for an unknown event or a deleted
        incident.
    """
    template = TEMPLATES.get(row["event"])
    if template is None:
        logger.warning("Ignoring unknown event: %s", row["event"])
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
        {"incident": row["incident_id"], "actor": row["actor_id"]},
    )
    incident = cursor.fetchone()
    if incident is None:
        return None

    phrase = template.format(
        assignee=incident.get("assignee") or "an engineer",
        actor=incident.get("actor") or "someone",
        detail=row.get("detail") or "a new state",
    )
    return f"#{incident['id']} \"{incident['title']}\" {phrase}"


def drain(limit: int = 500) -> int:
    """
    Expand pending outbox events into notifications.

    Rows are claimed with ``FOR UPDATE SKIP LOCKED``, so this worker and any
    API container draining at the same time never handle the same event twice
    and never block one another.

    Recipients are the reporter, the assigned engineer and every facility
    admin, minus whoever caused the change: telling someone what they just did
    is noise.

    Args:
        limit: Maximum events to process in this pass.

    Returns:
        int: How many events were processed.
    """
    connection = _connection()
    processed = 0

    with connection.transaction(), connection.cursor() as cursor:
        cursor.execute(
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
        for row in list(cursor.fetchall()):
            body = compose(cursor, row)
            if body is not None:
                cursor.execute(
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
            cursor.execute(
                "UPDATE notification_events SET processed_at = NOW(), attempts = attempts + 1 WHERE id = %s",
                (row["id"],),
            )
            processed += 1

    return processed


def handler(event: dict[str, Any] | None = None, context: Any = None) -> dict[str, Any]:
    """
    Lambda entry point: drain the outbox.

    Args:
        event: Optional ``{"limit": n}`` to bound one pass.
        context: The Lambda context.

    Returns:
        dict: ``{"processed": n}``.
    """
    processed = drain(int((event or {}).get("limit", 500)))
    logger.info("Expanded %s notification event(s)", processed)
    return {"processed": processed}


# Convenience entry point for `python function.py`.
if __name__ == "__main__":
    print(handler())
