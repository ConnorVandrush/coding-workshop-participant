"""
Account administration, restricted to facility admins.

Registration lives in `auth.py`; this module only covers the operations an
admin performs on existing accounts - listing them, granting the engineer or
admin role, and deactivating leavers.
"""

from typing import Any, Optional

from fastapi import APIRouter, Depends, Query

from app.database import fetch_all, fetch_one
from app.domain import Role
from app.errors import ApiError, not_found
from app.models import UserResponse, UserRoleUpdate, UserStatusUpdate
from app.security import require_roles

router = APIRouter(prefix="/users", tags=["users"])

_ADMIN_ONLY = Depends(require_roles(Role.FACILITY_ADMIN))


# GET /users?role=engineer&q=dana&limit=50&offset=0
# Request:  header `Authorization: Bearer <admin token>`, no body.
#   Query params: role (employee|engineer|facility_admin), q (name/email search),
#                 is_active (bool), limit (1-200, default 50), offset (default 0).
# Response 200:
#   [{"id": 7, "email": "dana@acme.inc", "full_name": "Dana Ruiz",
#     "role": "engineer", "is_active": true,
#     "created_at": "2026-09-22T10:00:00Z"}]
# Response 403: forbidden (caller is not a facility admin)
@router.get("", response_model=list[UserResponse], summary="List accounts")
async def list_users(
    _: dict[str, Any] = _ADMIN_ONLY,
    role: Optional[Role] = Query(default=None, description="Filter by role"),
    q: Optional[str] = Query(default=None, max_length=120, description="Search name or email"),
    is_active: Optional[bool] = Query(default=None, description="Filter by activation state"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[dict[str, Any]]:
    """
    List accounts with optional role, text and activation filters.

    Args:
        _: Authenticated facility admin (authorization only).
        role: Restrict to a single role.
        q: Case-insensitive substring match on full name or email.
        is_active: Restrict to active or inactive accounts.
        limit: Page size.
        offset: Rows to skip.

    Returns:
        list[dict]: Matching user records, newest first.
    """
    clauses: list[str] = []
    params: list[Any] = []
    if role is not None:
        clauses.append("role = %s")
        params.append(role.value)
    if is_active is not None:
        clauses.append("is_active = %s")
        params.append(is_active)
    if q:
        clauses.append("(full_name ILIKE %s OR email ILIKE %s)")
        params.extend([f"%{q}%", f"%{q}%"])

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.extend([limit, offset])
    return fetch_all(
        f"""
        SELECT id, email, full_name, role, is_active, created_at
        FROM users {where}
        ORDER BY created_at DESC, id DESC
        LIMIT %s OFFSET %s
        """,  # nosec B608 # identifiers below are module constants, never client input; every value is bound with %s
        params,
    )


# GET /users/{user_id}
# Request:  header `Authorization: Bearer <admin token>`, no body.
# Response 200: single user object (same shape as GET /users items)
# Response 404: not_found
@router.get("/{user_id}", response_model=UserResponse, summary="Fetch one account")
async def get_user(user_id: int, _: dict[str, Any] = _ADMIN_ONLY) -> dict[str, Any]:
    """
    Fetch a single account by id.

    Args:
        user_id: Account identifier.
        _: Authenticated facility admin (authorization only).

    Returns:
        dict: The user record.

    Raises:
        ApiError: 404 when no such account exists.
    """
    user = fetch_one(
        "SELECT id, email, full_name, role, is_active, created_at FROM users WHERE id = %s",
        (user_id,),
    )
    if user is None:
        raise not_found("User", user_id)
    return user


# PATCH /users/{user_id}/role
# Request body: {"role": "engineer"}   // employee | engineer | facility_admin
# Response 200: the updated user object
# Response 403: forbidden | last_admin (refusing to demote the only admin)
# Response 404: not_found
@router.patch("/{user_id}/role", response_model=UserResponse, summary="Change a user's role")
async def update_role(
    user_id: int,
    payload: UserRoleUpdate,
    admin: dict[str, Any] = _ADMIN_ONLY,
) -> dict[str, Any]:
    """
    Grant or revoke a role.

    Demoting an engineer leaves their profile in place so historical
    assignments stay resolvable; re-promoting them restores it.

    Args:
        user_id: Account to modify.
        payload: The target role.
        admin: The acting facility admin.

    Returns:
        dict: The updated user record.

    Raises:
        ApiError: 404 when the account is missing, 403 when the change would
            remove the last remaining facility admin.
    """
    target = fetch_one("SELECT id, role FROM users WHERE id = %s", (user_id,))
    if target is None:
        raise not_found("User", user_id)

    if target["role"] == Role.FACILITY_ADMIN and payload.role != Role.FACILITY_ADMIN:
        remaining = fetch_one(
            "SELECT COUNT(*) AS total FROM users WHERE role = %s AND is_active = TRUE AND id <> %s",
            (Role.FACILITY_ADMIN.value, user_id),
        )
        if (remaining or {}).get("total", 0) == 0:
            raise ApiError(403, "last_admin", "At least one active facility admin must remain")

    updated = fetch_one(
        """
        UPDATE users SET role = %s WHERE id = %s
        RETURNING id, email, full_name, role, is_active, created_at
        """,
        (payload.role.value, user_id),
    )
    return updated or {}


# PATCH /users/{user_id}/status
# Request body: {"is_active": false}
# Response 200: the updated user object
# Response 403: forbidden | last_admin | self_deactivation
# Response 404: not_found
@router.patch("/{user_id}/status", response_model=UserResponse, summary="Activate or deactivate")
async def update_status(
    user_id: int,
    payload: UserStatusUpdate,
    admin: dict[str, Any] = _ADMIN_ONLY,
) -> dict[str, Any]:
    """
    Enable or disable sign-in for an account.

    Args:
        user_id: Account to modify.
        payload: Desired activation state.
        admin: The acting facility admin.

    Returns:
        dict: The updated user record.

    Raises:
        ApiError: 404 when missing, 403 when deactivating yourself or the last
            active facility admin.
    """
    target = fetch_one("SELECT id, role FROM users WHERE id = %s", (user_id,))
    if target is None:
        raise not_found("User", user_id)

    if not payload.is_active:
        if target["id"] == admin["id"]:
            raise ApiError(403, "self_deactivation", "You cannot deactivate your own account")
        if target["role"] == Role.FACILITY_ADMIN:
            remaining = fetch_one(
                "SELECT COUNT(*) AS total FROM users WHERE role = %s AND is_active = TRUE AND id <> %s",
                (Role.FACILITY_ADMIN.value, user_id),
            )
            if (remaining or {}).get("total", 0) == 0:
                raise ApiError(403, "last_admin", "At least one active facility admin must remain")

    updated = fetch_one(
        """
        UPDATE users SET is_active = %s WHERE id = %s
        RETURNING id, email, full_name, role, is_active, created_at
        """,
        (payload.is_active, user_id),
    )
    return updated or {}
