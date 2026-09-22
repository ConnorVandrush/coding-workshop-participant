"""
Engineer profiles.

A profile is the assignable unit of work: incidents reference
``engineer_profiles.id``, not ``users.id``. Creating a profile also promotes the
underlying account to the ``engineer`` role, so facility admins manage their
engineering roster from one place.
"""

from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Response, status

from app.database import cursor, execute, fetch_all, fetch_one
from app.domain import ACTIVE_STATUSES, Role
from app.errors import ApiError, not_found
from app.models import EngineerCreate, EngineerResponse, EngineerUpdate
from app.security import get_current_user, require_roles

router = APIRouter(prefix="/engineers", tags=["engineers"])

_ANY_USER = Depends(get_current_user)
_ADMIN_ONLY = Depends(require_roles(Role.FACILITY_ADMIN))

# Active workload is computed live rather than cached, so capacity is always
# consistent with the incidents table.
_ENGINEER_SELECT = """
    SELECT e.id, e.user_id, u.email, u.full_name, e.specialties, e.phone,
           e.is_available, e.max_active_incidents, e.created_at,
           COUNT(i.id) FILTER (WHERE i.status = ANY(%s))::int AS active_incidents
    FROM engineer_profiles e
    JOIN users u ON u.id = e.user_id
    LEFT JOIN incidents i ON i.assignee_id = e.id
"""
_ACTIVE = list(ACTIVE_STATUSES)


def _with_capacity(row: dict[str, Any]) -> dict[str, Any]:
    """
    Add the derived ``has_capacity`` flag used by the assignment UI.

    Args:
        row: A joined engineer row.

    Returns:
        dict: The row plus ``has_capacity``.
    """
    return {
        **row,
        "has_capacity": bool(row["is_available"])
        and row["active_incidents"] < row["max_active_incidents"],
    }


# GET /engineers?available_only=true&q=dana
# Request:  header `Authorization: Bearer <token>`, no body.
#   Query params: available_only (bool, default false), q (name/email search),
#                 limit (1-200, default 100), offset (default 0).
# Response 200:
#   [{"id": 3, "user_id": 7, "email": "dana@acme.inc", "full_name": "Dana Ruiz",
#     "specialties": ["HVAC", "ELECTRICAL"], "phone": "+1-555-0101",
#     "is_available": true, "max_active_incidents": 10, "active_incidents": 4,
#     "has_capacity": true, "created_at": "2026-09-22T10:00:00Z"}]
@router.get("", response_model=list[EngineerResponse], summary="List engineers and their workload")
async def list_engineers(
    _: dict[str, Any] = _ANY_USER,
    available_only: bool = Query(default=False, description="Only engineers with spare capacity"),
    q: Optional[str] = Query(default=None, max_length=120, description="Search name or email"),
    limit: int = Query(default=100, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> list[dict[str, Any]]:
    """
    List engineer profiles with their live active-incident counts.

    Args:
        _: Authenticated caller (any role).
        available_only: Drop engineers who are unavailable or at capacity.
        q: Case-insensitive substring match on name or email.
        limit: Page size.
        offset: Rows to skip.

    Returns:
        list[dict]: Engineer profiles ordered by name.
    """
    params: list[Any] = [_ACTIVE]
    where = ""
    if q:
        where = "WHERE (u.full_name ILIKE %s OR u.email ILIKE %s)"
        params.extend([f"%{q}%", f"%{q}%"])
    params.extend([limit, offset])

    rows = [
        _with_capacity(row)
        for row in fetch_all(
            f"{_ENGINEER_SELECT} {where} GROUP BY e.id, u.email, u.full_name "
            "ORDER BY u.full_name LIMIT %s OFFSET %s",
            params,
        )
    ]
    return [row for row in rows if row["has_capacity"]] if available_only else rows


# POST /engineers
# Request body:
#   {"user_id": 7, "specialties": ["HVAC", "ELECTRICAL"], "phone": "+1-555-0101",
#    "is_available": true, "max_active_incidents": 10}
#   - the user must already have registered via POST /auth/register.
# Response 201: the created engineer object (same shape as the list items)
# Response 404: not_found (unknown user)
# Response 409: conflict (user already has an engineer profile)
@router.post(
    "",
    response_model=EngineerResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create an engineer profile",
)
async def create_engineer(payload: EngineerCreate, _: dict[str, Any] = _ADMIN_ONLY) -> dict[str, Any]:
    """
    Turn an existing account into an assignable engineer.

    The profile insert and the role promotion run in one transaction so a failed
    promotion never leaves an orphaned profile behind.

    Args:
        payload: Target user id and profile attributes.
        _: Authenticated facility admin (authorization only).

    Returns:
        dict: The created engineer profile.

    Raises:
        ApiError: 404 when the user is missing, 409 when a profile already exists.
    """
    if fetch_one("SELECT id FROM users WHERE id = %s", (payload.user_id,)) is None:
        raise not_found("User", payload.user_id)
    if fetch_one("SELECT id FROM engineer_profiles WHERE user_id = %s", (payload.user_id,)):
        raise ApiError(409, "conflict", "That user already has an engineer profile")

    with cursor(transactional=True) as cur:
        cur.execute(
            """
            INSERT INTO engineer_profiles
                (user_id, specialties, phone, is_available, max_active_incidents)
            VALUES (%s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                payload.user_id,
                list(payload.specialties),
                payload.phone,
                payload.is_available,
                payload.max_active_incidents,
            ),
        )
        created = cur.fetchone()
        cur.execute(
            "UPDATE users SET role = %s WHERE id = %s AND role <> %s",
            (Role.ENGINEER.value, payload.user_id, Role.FACILITY_ADMIN.value),
        )

    return await get_engineer(int((created or {})["id"]), _)


# GET /engineers/{engineer_id}
# Response 200: single engineer object | Response 404: not_found
@router.get("/{engineer_id}", response_model=EngineerResponse, summary="Fetch an engineer")
async def get_engineer(engineer_id: int, _: dict[str, Any] = _ANY_USER) -> dict[str, Any]:
    """
    Fetch one engineer profile with its live workload.

    Args:
        engineer_id: Engineer profile identifier.
        _: Authenticated caller (any role).

    Returns:
        dict: The engineer profile.

    Raises:
        ApiError: 404 when the profile does not exist.
    """
    engineer = fetch_one(
        f"{_ENGINEER_SELECT} WHERE e.id = %s GROUP BY e.id, u.email, u.full_name",
        (_ACTIVE, engineer_id),
    )
    if engineer is None:
        raise not_found("Engineer", engineer_id)
    return _with_capacity(engineer)


# PUT /engineers/{engineer_id}
# Request body (all fields optional):
#   {"specialties": ["NETWORK"], "phone": "+1-555-0199",
#    "is_available": false, "max_active_incidents": 6}
# Response 200: the updated engineer object
# Response 400: validation_error (empty payload) | 404: not_found
@router.put("/{engineer_id}", response_model=EngineerResponse, summary="Update an engineer profile")
async def update_engineer(
    engineer_id: int,
    payload: EngineerUpdate,
    _: dict[str, Any] = _ADMIN_ONLY,
) -> dict[str, Any]:
    """
    Update specialties, contact details, availability or capacity.

    Args:
        engineer_id: Engineer profile identifier.
        payload: Fields to change; omitted fields are left as-is.
        _: Authenticated facility admin (authorization only).

    Returns:
        dict: The updated engineer profile.

    Raises:
        ApiError: 404 when missing, 400 when the payload is empty.
    """
    if fetch_one("SELECT id FROM engineer_profiles WHERE id = %s", (engineer_id,)) is None:
        raise not_found("Engineer", engineer_id)

    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        raise ApiError(400, "validation_error", "Supply at least one field to update")
    if "specialties" in fields and fields["specialties"] is not None:
        fields["specialties"] = list(fields["specialties"])

    assignments = ", ".join(f"{column} = %s" for column in fields)
    execute(
        f"UPDATE engineer_profiles SET {assignments} WHERE id = %s",  # nosec B608 # identifiers below are module constants, never client input; every value is bound with %s
        [*fields.values(), engineer_id],
    )
    return await get_engineer(engineer_id, _)


# DELETE /engineers/{engineer_id}
# Request:  no body. Open incidents assigned to this engineer are unassigned
#           (their history is preserved) and the account drops to `employee`.
# Response 204: empty body
# Response 404: not_found
@router.delete("/{engineer_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a profile")
async def delete_engineer(engineer_id: int, _: dict[str, Any] = _ADMIN_ONLY) -> Response:
    """
    Remove an engineer profile and demote the underlying account.

    Args:
        engineer_id: Engineer profile identifier.
        _: Authenticated facility admin (authorization only).

    Returns:
        Response: An empty 204 response.

    Raises:
        ApiError: 404 when the profile does not exist.
    """
    engineer = fetch_one("SELECT id, user_id FROM engineer_profiles WHERE id = %s", (engineer_id,))
    if engineer is None:
        raise not_found("Engineer", engineer_id)

    with cursor(transactional=True) as cur:
        # ON DELETE SET NULL handles incidents; the explicit UPDATE keeps the
        # assignment timestamp consistent with the now-empty assignee.
        cur.execute(
            "UPDATE incidents SET assignee_id = NULL, assigned_at = NULL, updated_at = NOW() "
            "WHERE assignee_id = %s",
            (engineer_id,),
        )
        cur.execute("DELETE FROM engineer_profiles WHERE id = %s", (engineer_id,))
        cur.execute(
            "UPDATE users SET role = %s WHERE id = %s AND role = %s",
            (Role.EMPLOYEE.value, engineer["user_id"], Role.ENGINEER.value),
        )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
