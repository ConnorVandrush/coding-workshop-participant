"""
Hand incident events to the notification worker.

Telling every interested person about a change is fan-out: one status change
can mean several recipients. Doing that inside the request would add latency to
a workflow transition, and - worse - a failure to notify would fail a state
change that has already been agreed. So the API records the event on a queue
and returns; `backend/notifier` expands it into per-person notifications.

boto3 is deliberately not in requirements.txt. The Lambda runtime provides it,
and vendoring it would add tens of megabytes to a package that does not need
it. Where it is absent - a bare `uvicorn` run, for instance - enqueueing
degrades to a logged no-op rather than an error, because a missing notification
must never break the workflow it describes.
"""

import json
import logging
import os
from typing import Any, Optional

logger = logging.getLogger(__name__)

NOTIFICATIONS_QUEUE_URL = os.getenv("NOTIFICATIONS_QUEUE_URL", "").strip()

_client = None
_unavailable = False


def _sqs():
    """
    Return a cached SQS client, or None when queueing is unavailable.

    Returns:
        Any | None: A boto3 SQS client, or None when boto3 or the queue URL is
        missing.
    """
    global _client, _unavailable
    if _unavailable or not NOTIFICATIONS_QUEUE_URL:
        return None
    if _client is None:
        try:
            import boto3  # imported lazily; provided by the Lambda runtime

            # AWS_ENDPOINT_URL points at LocalStack when running locally.
            _client = boto3.client("sqs", endpoint_url=os.getenv("AWS_ENDPOINT_URL") or None)
        except Exception as exc:  # pragma: no cover - depends on the environment
            logger.warning("Notification queue unavailable: %s", exc)
            _unavailable = True
            return None
    return _client


def enqueue(event: str, incident_id: int, actor_id: int, detail: Optional[str] = None) -> bool:
    """
    Record an incident event for the notification worker.

    Args:
        event: What happened, e.g. ``assigned`` or ``status_changed``.
        incident_id: The incident the event concerns.
        actor_id: The user who caused it; they are not notified about their own
            action.
        detail: Optional extra context, such as a blocking reason.

    Returns:
        bool: True when the event was queued. False means nobody will be
        notified, which is logged but never raised: the caller's workflow
        change has already been agreed and must not be undone by this.
    """
    client = _sqs()
    if client is None:
        logger.info("Notification skipped (no queue configured): %s incident=%s", event, incident_id)
        return False

    message: dict[str, Any] = {
        "event": event,
        "incident_id": incident_id,
        "actor_id": actor_id,
        "detail": detail,
    }
    try:
        client.send_message(QueueUrl=NOTIFICATIONS_QUEUE_URL, MessageBody=json.dumps(message))
        return True
    except Exception as exc:  # pragma: no cover - network failure path
        logger.error("Could not queue notification for incident %s: %s", incident_id, exc)
        return False
