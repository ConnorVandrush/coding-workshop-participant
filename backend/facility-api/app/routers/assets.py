"""
Equipment register: one row per physical unit.

Reads are open to every authenticated persona, because a reporter needs to say
which unit failed. Writes are facility-admin only, like the rest of the estate.

The register exists so that a recurring fault can be attributed to a unit. A
seat tells you where a problem happened; an asset tells you what keeps
breaking, which is the question a replacement budget is answered from.
"""

from datetime import date
from typing import Any, Final, Optional

from fastapi import APIRouter, Depends, Query, Response, status

from app.database import execute, fetch_all, fetch_one
from app.domain import ACTIVE_STATUSES, Role
from app.errors import ApiError, not_found
from app.models import AssetCreate, AssetResponse, AssetServiceRecord, AssetUpdate
from app.security import get_current_user, require_roles

router = APIRouter(prefix="/assets", tags=["assets"])

_ANY_USER = Depends(get_current_user)
_ADMIN_ONLY = Depends(require_roles(Role.FACILITY_ADMIN))

_ASSET_SELECT = """
    SELECT a.id, a.code, a.name, a.asset_type, a.manufacturer, a.model,
           a.building_id, b.name AS building_name,
           a.floor_id, f.level AS floor_level,
           a.seat_id, s.code AS seat_code,
           a.installed_on, a.expected_life_months, a.retired_on, a.notes,
           a.service_interval_months, a.last_serviced_on,
           -- A unit that has never been serviced is measured from the day it
           -- went in: the first service is due an interval after installation,
           -- not never.
           (CASE
                WHEN a.service_interval_months IS NOT NULL
                THEN COALESCE(a.last_serviced_on, a.installed_on)
                     + make_interval(months => a.service_interval_months)
            END)::date AS next_service_due,
           (a.retired_on IS NOT NULL AND a.retired_on <= CURRENT_DATE) AS is_retired,
           a.created_at,
           COUNT(i.id)::int AS incident_count,
           COUNT(i.id) FILTER (WHERE i.status = ANY(%s))::int AS open_incident_count,
           MAX(i.created_at) AS last_incident_at
    FROM assets a
    LEFT JOIN buildings b ON b.id = a.building_id
    LEFT JOIN floors f ON f.id = a.floor_id
    LEFT JOIN seats s ON s.id = a.seat_id
    LEFT JOIN incidents i ON i.asset_id = a.id
"""

_GROUP_BY = "GROUP BY a.id, b.name, f.level, s.code"

# Columns a client may set, so that an update can never reach anything else.
_WRITABLE = (
    "code",
    "name",
    "asset_type",
    "manufacturer",
    "model",
    "building_id",
    "floor_id",
    "seat_id",
    "installed_on",
    "expected_life_months",
    "service_interval_months",
    "last_serviced_on",
    "retired_on",
    "notes",
)


# A service falling due inside this many days is worth planning for now; past
# the date it is overdue. One month is a maintenance window people can act on.
DUE_SOON_DAYS: Final[int] = 30


def service_state(next_due: Optional[date]) -> tuple[str, Optional[int]]:
    """
    Classify a unit's next service against today.

    Args:
        next_due: When the unit is next due a service, if it has an interval.

    Returns:
        tuple[str, int | None]: ``unknown``/``ok``/``due_soon``/``overdue``, and
        the days until it falls due (negative once it has passed).
    """
    if next_due is None:
        # No interval set. Not a healthy unit - an unanswered question, which
        # is why the summary counts these separately.
        return "unknown", None
    days = (next_due - date.today()).days
    if days < 0:
        return "overdue", days
    return ("due_soon" if days <= DUE_SOON_DAYS else "ok"), days


def _shape(row: dict[str, Any]) -> dict[str, Any]:
    """
    Add the derived service fields to a joined asset row.

    Args:
        row: A row produced by ``_ASSET_SELECT``.

    Returns:
        dict: The same row with ``service_status`` and ``days_until_service``.
    """
    status, days = service_state(row.get("next_service_due"))
    return {**row, "service_status": status, "days_until_service": days}


def _load(asset_id: int) -> dict[str, Any]:
    """
    Fetch one asset with its failure history.

    Args:
        asset_id: Asset identifier.

    Returns:
        dict: The joined asset row.

    Raises:
        ApiError: 404 when the asset does not exist.
    """
    row = fetch_one(
        f"{_ASSET_SELECT} WHERE a.id = %s {_GROUP_BY}",
        [list(ACTIVE_STATUSES), asset_id],
    )
    if row is None:
        raise not_found("Asset", asset_id)
    return _shape(row)


def _validate_placement(building_id: Optional[int], floor_id: Optional[int], seat_id: Optional[int]) -> None:
    """
    Check the asset's location exists and its building/floor/seat chain lines up.

    Args:
        building_id: Optional building reference.
        floor_id: Optional floor reference.
        seat_id: Optional seat reference.

    Raises:
        ApiError: 400 when a reference is unknown or inconsistent.
    """
    if building_id is not None and fetch_one("SELECT id FROM buildings WHERE id = %s", (building_id,)) is None:
        raise ApiError(400, "validation_error", f"Building {building_id} does not exist")
    if floor_id is not None:
        floor = fetch_one("SELECT id, building_id FROM floors WHERE id = %s", (floor_id,))
        if floor is None:
            raise ApiError(400, "validation_error", f"Floor {floor_id} does not exist")
        if building_id is not None and floor["building_id"] != building_id:
            raise ApiError(400, "validation_error", "Floor does not belong to the supplied building")
    if seat_id is not None:
        seat = fetch_one("SELECT id, floor_id FROM seats WHERE id = %s", (seat_id,))
        if seat is None:
            raise ApiError(400, "validation_error", f"Seat {seat_id} does not exist")
        if floor_id is not None and seat["floor_id"] != floor_id:
            raise ApiError(400, "validation_error", "Seat does not belong to the supplied floor")


# GET /assets?q=projector&asset_type=PROJECTOR&building_id=1&floor_id=3&seat_id=99
#            &include_retired=false&limit=200&offset=0
# Request:  header `Authorization: Bearer <token>`, no body.
# Response 200:
#   [{"id": 4, "code": "AV-3A-PROJ-01", "name": "Ceiling projector, Meeting Room 3A",
#     "asset_type": "PROJECTOR", "manufacturer": "Epson", "model": "EB-L200",
#     "building_id": 1, "building_name": "HQ North", "floor_id": 3, "floor_level": 3,
#     "seat_id": 99, "seat_code": "3A-12", "installed_on": "2023-03-14",
#     "expected_life_months": 60, "retired_on": null, "is_retired": false,
#     "notes": null, "incident_count": 3, "open_incident_count": 1,
#     "last_incident_at": "2026-09-22T10:00:00Z", "created_at": "2026-09-01T09:00:00Z"}]
@router.get("", response_model=list[AssetResponse], summary="List equipment")
async def list_assets(
    _: dict[str, Any] = _ANY_USER,
    q: Optional[str] = Query(default=None, max_length=120, description="Search code, name or model"),
    asset_type: Optional[str] = Query(default=None, max_length=120),
    building_id: Optional[int] = Query(default=None),
    floor_id: Optional[int] = Query(default=None),
    seat_id: Optional[int] = Query(default=None),
    include_retired: bool = Query(default=False, description="Include units already taken out of service"),
    limit: int = Query(default=200, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[dict[str, Any]]:
    """
    List equipment with its failure counts, filtered by location or type.

    Args:
        _: Authenticated caller (any role).
        q: Case-insensitive substring match on code, name or model.
        asset_type: Exact equipment class.
        building_id: Restrict to one building.
        floor_id: Restrict to one floor.
        seat_id: Restrict to one seat.
        include_retired: When False, retired units are omitted.
        limit: Page size.
        offset: Rows to skip.

    Returns:
        list[dict]: Assets ordered by location then code.
    """
    clauses: list[str] = []
    params: list[Any] = [list(ACTIVE_STATUSES)]
    if q:
        clauses.append("(a.code ILIKE %s OR a.name ILIKE %s OR a.model ILIKE %s)")
        params.extend([f"%{q}%"] * 3)
    for column, value in (
        ("a.asset_type", asset_type),
        ("a.building_id", building_id),
        ("a.floor_id", floor_id),
        ("a.seat_id", seat_id),
    ):
        if value is not None:
            clauses.append(f"{column} = %s")
            params.append(value)
    if not include_retired:
        clauses.append("(a.retired_on IS NULL OR a.retired_on > CURRENT_DATE)")

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.extend([limit, offset])
    rows = fetch_all(
        f"{_ASSET_SELECT} {where} {_GROUP_BY} ORDER BY b.name NULLS LAST, f.level, a.code LIMIT %s OFFSET %s",  # nosec B608 # identifiers below are module constants, never client input; every value is bound with %s
        params,
    )
    return [_shape(row) for row in rows]


# GET /assets/types
# Request:  header `Authorization: Bearer <token>`, no body.
# Response 200: ["HVAC_UNIT", "PROJECTOR", ...]
#   The distinct classes already in use, so the UI can offer them without
#   hard-coding a taxonomy the estate may not follow.
@router.get("/types", response_model=list[str], summary="Equipment classes in use")
async def list_asset_types(_: dict[str, Any] = _ANY_USER) -> list[str]:
    """
    List the distinct equipment classes present in the register.

    Args:
        _: Authenticated caller (any role).

    Returns:
        list[str]: Asset types, alphabetically.
    """
    return [row["asset_type"] for row in fetch_all("SELECT DISTINCT asset_type FROM assets ORDER BY asset_type")]


# GET /assets/{asset_id}
# Response 200: <asset object, see GET /assets> | 404: not_found
@router.get("/{asset_id}", response_model=AssetResponse, summary="Fetch one asset")
async def get_asset(asset_id: int, _: dict[str, Any] = _ANY_USER) -> dict[str, Any]:
    """
    Fetch a single asset.

    Args:
        asset_id: Asset identifier.
        _: Authenticated caller (any role).

    Returns:
        dict: The asset.
    """
    return _load(asset_id)


# POST /assets
# Request body: {"code": "AV-3A-PROJ-01", "name": "Ceiling projector, Meeting Room 3A",
#                "asset_type": "PROJECTOR", "seat_id": 99, "floor_id": 3,
#                "building_id": 1, "installed_on": "2023-03-14",
#                "expected_life_months": 60}
# Rules: facility admins only. `code` is the asset tag and must be unique.
# Response 201: <asset object> | 400: validation_error | 403: forbidden
@router.post("", response_model=AssetResponse, status_code=status.HTTP_201_CREATED, summary="Register equipment")
async def create_asset(payload: AssetCreate, _: dict[str, Any] = _ADMIN_ONLY) -> dict[str, Any]:
    """
    Register a unit of equipment.

    Args:
        payload: The asset to create.
        _: Authenticated facility admin.

    Returns:
        dict: The created asset.

    Raises:
        ApiError: 400 when the code is taken or the location is inconsistent.
    """
    _validate_placement(payload.building_id, payload.floor_id, payload.seat_id)
    if fetch_one("SELECT id FROM assets WHERE code = %s", (payload.code,)) is not None:
        raise ApiError(400, "validation_error", f"Asset code {payload.code} is already in use")
    row = fetch_one(
        """
        INSERT INTO assets (code, name, asset_type, manufacturer, model, building_id,
                            floor_id, seat_id, installed_on, expected_life_months,
                            service_interval_months, last_serviced_on, retired_on, notes)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            payload.code,
            payload.name,
            payload.asset_type,
            payload.manufacturer,
            payload.model,
            payload.building_id,
            payload.floor_id,
            payload.seat_id,
            payload.installed_on,
            payload.expected_life_months,
            payload.service_interval_months,
            payload.last_serviced_on,
            payload.retired_on,
            payload.notes,
        ),
    )
    return _load(row["id"])


# PUT /assets/{asset_id}
# Request body: any subset of the create fields.
# Rules: facility admins only.
# Response 200: <asset object> | 400 | 403 | 404
@router.put("/{asset_id}", response_model=AssetResponse, summary="Update an asset")
async def update_asset(asset_id: int, payload: AssetUpdate, _: dict[str, Any] = _ADMIN_ONLY) -> dict[str, Any]:
    """
    Apply a partial update to an asset.

    Args:
        asset_id: Asset identifier.
        payload: Fields to change.
        _: Authenticated facility admin.

    Returns:
        dict: The updated asset.

    Raises:
        ApiError: 400 when nothing was supplied, the code is taken or the
            location is inconsistent; 404 when the asset is unknown.
    """
    current = _load(asset_id)
    fields = {key: value for key, value in payload.model_dump(exclude_unset=True).items() if key in _WRITABLE}
    if not fields:
        raise ApiError(400, "validation_error", "Supply at least one field to update")

    _validate_placement(
        fields.get("building_id", current["building_id"]),
        fields.get("floor_id", current["floor_id"]),
        fields.get("seat_id", current["seat_id"]),
    )
    if "code" in fields:
        clash = fetch_one("SELECT id FROM assets WHERE code = %s AND id <> %s", (fields["code"], asset_id))
        if clash is not None:
            raise ApiError(400, "validation_error", f"Asset code {fields['code']} is already in use")

    assignments = ", ".join(f"{column} = %s" for column in fields)
    execute(
        f"UPDATE assets SET {assignments} WHERE id = %s",  # nosec B608 # identifiers below are module constants, never client input; every value is bound with %s
        [*fields.values(), asset_id],
    )
    return _load(asset_id)


# POST /assets/{asset_id}/service
# Request body: {"serviced_on": "2026-09-23", "note": "Filter replaced"}
#   Both optional; `serviced_on` defaults to today.
# Rules: facility admins only. Recording a service restarts the interval, so
#        the unit's next due date moves forward from this date.
# Response 200: <asset object, with next_service_due moved on>
# Response 400: validation_error (a service in the future) | 403 | 404
@router.post("/{asset_id}/service", response_model=AssetResponse, summary="Record a service")
async def record_service(
    asset_id: int,
    payload: AssetServiceRecord,
    _: dict[str, Any] = _ADMIN_ONLY,
) -> dict[str, Any]:
    """
    Record that a unit was serviced, moving its next due date forward.

    Args:
        asset_id: Asset identifier.
        payload: When it was serviced, and an optional note.
        _: Authenticated facility admin.

    Returns:
        dict: The updated asset.

    Raises:
        ApiError: 400 when the date is in the future, 404 when unknown.
    """
    current = _load(asset_id)
    serviced_on = payload.serviced_on or date.today()
    if serviced_on > date.today():
        raise ApiError(400, "validation_error", "A service cannot be recorded for a future date")

    # The note is appended rather than replacing what is there: the register is
    # the only place this history lives, and overwriting it would lose the
    # previous visit every time a new one is recorded.
    note = current.get("notes")
    if payload.note:
        entry = f"{serviced_on.isoformat()}: {payload.note}"
        note = f"{note}\n{entry}" if note else entry

    execute(
        "UPDATE assets SET last_serviced_on = %s, notes = %s WHERE id = %s",
        (serviced_on, note, asset_id),
    )
    return _load(asset_id)


# DELETE /assets/{asset_id}
# Rules: facility admins only. Incidents keep their history and lose the link
#        (ON DELETE SET NULL), so deleting a unit never deletes its faults.
#        Retiring (`retired_on`) is usually what you want instead.
# Response 204 | 403 | 404
@router.delete("/{asset_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Remove an asset")
async def delete_asset(asset_id: int, _: dict[str, Any] = _ADMIN_ONLY) -> Response:
    """
    Delete an asset, unlinking it from any incidents that referenced it.

    Args:
        asset_id: Asset identifier.
        _: Authenticated facility admin.

    Returns:
        Response: 204 with no body.

    Raises:
        ApiError: 404 when the asset does not exist.
    """
    if execute("DELETE FROM assets WHERE id = %s", (asset_id,)) == 0:
        raise not_found("Asset", asset_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
