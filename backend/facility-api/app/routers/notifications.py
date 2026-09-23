"""
A person's own notification feed.

Rows are written by `backend/notifier` off the queue, never by these
endpoints: reading and dismissing is all a signed-in user does here. Everything
is scoped to the caller, so there is no cross-user access to guard against
beyond the ownership check on each row.
"""

from typing import Any

from fastapi import APIRouter, Depends, Query, Response, status

from app.database import execute, fetch_all, fetch_one
from app.errors import not_found
from app.models import NotificationResponse, NotificationSummary
from app.notifications import drain
from app.security import get_current_user

router = APIRouter(prefix="/notifications", tags=["notifications"])

_ANY_USER = Depends(get_current_user)


# GET /notifications?unread_only=true&limit=20
# Request:  header `Authorization: Bearer <token>`, no body.
#   Query params: unread_only (bool, default false), limit (1-100, default 20).
# Response 200:
#   {"unread": 3,
#    "items": [{"id": 9, "incident_id": 42, "event": "status_changed",
#               "body": "Incident #42 moved to BLOCKED: lamp on back-order",
#               "is_read": false, "created_at": "2026-09-22T12:00:00Z"}]}
@router.get("", response_model=NotificationSummary, summary="Your notification feed")
async def list_notifications(
    user: dict[str, Any] = _ANY_USER,
    unread_only: bool = Query(default=False, description="Only notifications not yet read"),
    limit: int = Query(default=20, ge=1, le=100),
) -> dict[str, Any]:
    """
    Return the caller's notifications, newest first, with the unread count.

    Args:
        user: The authenticated caller.
        unread_only: Restrict to unread notifications.
        limit: Page size.

    Returns:
        dict: ``unread`` count and the ``items`` themselves.
    """
    # Expand anything still pending before reporting the feed, so a reader
    # never sees a stale count. Bounded, and safe to run concurrently.
    drain()

    where = "WHERE user_id = %s" + (" AND is_read = FALSE" if unread_only else "")
    items = fetch_all(
        f"""
        SELECT id, incident_id, event, body, is_read, created_at
        FROM notifications {where}
        ORDER BY created_at DESC, id DESC
        LIMIT %s
        """,  # nosec B608 # `where` is one of two literals chosen above; both ids are bound
        (user["id"], limit),
    )
    unread = fetch_one(
        "SELECT COUNT(*)::int AS total FROM notifications WHERE user_id = %s AND is_read = FALSE",
        (user["id"],),
    )
    return {"unread": (unread or {}).get("total", 0), "items": items}


# POST /notifications/{notification_id}/read
# Request:  no body.
# Response 200: the updated notification object
# Response 404: not_found (missing, or belongs to someone else)
@router.post("/{notification_id}/read", response_model=NotificationResponse, summary="Mark one as read")
async def mark_read(notification_id: int, user: dict[str, Any] = _ANY_USER) -> dict[str, Any]:
    """
    Mark a single notification as read.

    Args:
        notification_id: The notification to mark.
        user: The authenticated caller; only their own rows are reachable.

    Returns:
        dict: The updated notification.

    Raises:
        ApiError: 404 when it does not exist or belongs to someone else.
    """
    updated = fetch_one(
        """
        UPDATE notifications SET is_read = TRUE
        WHERE id = %s AND user_id = %s
        RETURNING id, incident_id, event, body, is_read, created_at
        """,
        (notification_id, user["id"]),
    )
    if updated is None:
        # 404 rather than 403, so another user's ids are not enumerable.
        raise not_found("Notification", notification_id)
    return updated


# POST /notifications/read-all
# Request:  no body.
# Response 200: {"unread": 0, "marked": 3}
@router.post("/read-all", summary="Mark the whole feed as read")
async def mark_all_read(user: dict[str, Any] = _ANY_USER) -> dict[str, int]:
    """
    Mark every unread notification for the caller as read.

    Args:
        user: The authenticated caller.

    Returns:
        dict: How many were marked, and the resulting unread count.
    """
    marked = execute(
        "UPDATE notifications SET is_read = TRUE WHERE user_id = %s AND is_read = FALSE",
        (user["id"],),
    )
    return {"unread": 0, "marked": marked}
