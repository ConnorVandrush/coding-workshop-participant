"""
Facility hierarchy: buildings -> floors -> seats.

Reads are open to every authenticated persona because employees need to pick a
location when reporting an incident. Writes are facility-admin only.
"""

from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Response, status

from app.database import execute, fetch_all, fetch_one
from app.domain import Role
from app.errors import ApiError, not_found
from app.models import (
    BuildingCreate,
    BuildingResponse,
    BuildingUpdate,
    FloorCreate,
    FloorResponse,
    FloorUpdate,
    SeatCreate,
    SeatResponse,
    SeatUpdate,
)
from app.security import get_current_user, require_roles

router = APIRouter(tags=["facilities"])

_ANY_USER = Depends(get_current_user)
_ADMIN_ONLY = Depends(require_roles(Role.FACILITY_ADMIN))

_BUILDING_SELECT = """
    SELECT b.id, b.name, b.address, b.created_at,
           COUNT(f.id)::int AS floor_count
    FROM buildings b
    LEFT JOIN floors f ON f.building_id = b.id
"""

_FLOOR_SELECT = """
    SELECT f.id, f.building_id, b.name AS building_name, f.level, f.name, f.created_at,
           COUNT(s.id)::int AS seat_count
    FROM floors f
    JOIN buildings b ON b.id = f.building_id
    LEFT JOIN seats s ON s.floor_id = f.id
"""

_SEAT_SELECT = """
    SELECT s.id, s.floor_id, f.building_id, b.name AS building_name,
           f.level AS floor_level, s.code, s.description, s.created_at
    FROM seats s
    JOIN floors f ON f.id = s.floor_id
    JOIN buildings b ON b.id = f.building_id
"""


def _apply_updates(table: str, record_id: int, fields: dict[str, Any], returning: str) -> dict[str, Any]:
    """
    Apply a partial update and return the refreshed row.

    Args:
        table: Table name (never user-supplied).
        record_id: Primary key of the row to update.
        fields: Column/value pairs to set; an empty dict is a no-op.
        returning: SQL fragment listing the columns to return.

    Returns:
        dict: The updated row.

    Raises:
        ApiError: 400 when nothing was supplied to update.
    """
    if not fields:
        raise ApiError(400, "validation_error", "Supply at least one field to update")
    assignments = ", ".join(f"{column} = %s" for column in fields)
    params = [*fields.values(), record_id]
    row = fetch_one(f"UPDATE {table} SET {assignments} WHERE id = %s RETURNING {returning}", params)  # nosec B608 # identifiers below are module constants, never client input; every value is bound with %s
    return row or {}


# --------------------------------------------------------------------------
# Buildings
# --------------------------------------------------------------------------
# GET /buildings?q=hq&limit=100&offset=0
# Request:  header `Authorization: Bearer <token>`, no body.
# Response 200:
#   [{"id": 1, "name": "HQ North", "address": "1 Market St",
#     "floor_count": 4, "created_at": "2026-09-22T10:00:00Z"}]
@router.get("/buildings", response_model=list[BuildingResponse], summary="List buildings")
async def list_buildings(
    _: dict[str, Any] = _ANY_USER,
    q: Optional[str] = Query(default=None, max_length=120, description="Search by name"),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> list[dict[str, Any]]:
    """
    List buildings with their floor counts.

    Args:
        _: Authenticated caller (any role).
        q: Case-insensitive substring match on the building name.
        limit: Page size.
        offset: Rows to skip.

    Returns:
        list[dict]: Buildings ordered by name.
    """
    where = "WHERE b.name ILIKE %s" if q else ""
    params: list[Any] = [f"%{q}%"] if q else []
    params.extend([limit, offset])
    return fetch_all(
        f"{_BUILDING_SELECT} {where} GROUP BY b.id ORDER BY b.name LIMIT %s OFFSET %s",
        params,
    )


# POST /buildings
# Request body: {"name": "HQ North", "address": "1 Market St"}
# Response 201: {"id": 1, "name": "HQ North", "address": "1 Market St",
#                "floor_count": 0, "created_at": "2026-09-22T10:00:00Z"}
# Response 409: conflict (duplicate name)
@router.post(
    "/buildings",
    response_model=BuildingResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a building",
)
async def create_building(payload: BuildingCreate, _: dict[str, Any] = _ADMIN_ONLY) -> dict[str, Any]:
    """
    Register a new building.

    Args:
        payload: Name and optional street address.
        _: Authenticated facility admin (authorization only).

    Returns:
        dict: The created building.

    Raises:
        ApiError: 409 when a building with that name already exists.
    """
    if fetch_one("SELECT id FROM buildings WHERE name = %s", (payload.name,)):
        raise ApiError(409, "conflict", "A building with that name already exists")
    created = fetch_one(
        "INSERT INTO buildings (name, address) VALUES (%s, %s) RETURNING id, name, address, created_at",
        (payload.name, payload.address),
    )
    return {**(created or {}), "floor_count": 0}


# GET /buildings/{building_id}
# Response 200: single building object (same shape as the list items)
# Response 404: not_found
@router.get("/buildings/{building_id}", response_model=BuildingResponse, summary="Fetch a building")
async def get_building(building_id: int, _: dict[str, Any] = _ANY_USER) -> dict[str, Any]:
    """
    Fetch one building by id.

    Args:
        building_id: Building identifier.
        _: Authenticated caller (any role).

    Returns:
        dict: The building record.

    Raises:
        ApiError: 404 when the building does not exist.
    """
    building = fetch_one(f"{_BUILDING_SELECT} WHERE b.id = %s GROUP BY b.id", (building_id,))
    if building is None:
        raise not_found("Building", building_id)
    return building


# PUT /buildings/{building_id}
# Request body (all fields optional): {"name": "HQ South", "address": "9 Pine St"}
# Response 200: the updated building object
# Response 400: validation_error (empty payload) | 404: not_found | 409: conflict
@router.put("/buildings/{building_id}", response_model=BuildingResponse, summary="Update a building")
async def update_building(
    building_id: int,
    payload: BuildingUpdate,
    _: dict[str, Any] = _ADMIN_ONLY,
) -> dict[str, Any]:
    """
    Update a building's name and/or address.

    Args:
        building_id: Building identifier.
        payload: Fields to change; omitted fields are left as-is.
        _: Authenticated facility admin (authorization only).

    Returns:
        dict: The updated building.

    Raises:
        ApiError: 404 when missing, 409 on a duplicate name.
    """
    if fetch_one("SELECT id FROM buildings WHERE id = %s", (building_id,)) is None:
        raise not_found("Building", building_id)
    if payload.name and fetch_one(
        "SELECT id FROM buildings WHERE name = %s AND id <> %s", (payload.name, building_id)
    ):
        raise ApiError(409, "conflict", "A building with that name already exists")

    _apply_updates(
        "buildings",
        building_id,
        payload.model_dump(exclude_unset=True),
        "id, name, address, created_at",
    )
    return await get_building(building_id, _)


# DELETE /buildings/{building_id}
# Request:  no body. Cascades to floors and seats; incidents keep their history
#           with the location fields reset to null.
# Response 204: empty body
# Response 404: not_found
@router.delete(
    "/buildings/{building_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a building",
)
async def delete_building(building_id: int, _: dict[str, Any] = _ADMIN_ONLY) -> Response:
    """
    Delete a building along with its floors and seats.

    Args:
        building_id: Building identifier.
        _: Authenticated facility admin (authorization only).

    Returns:
        Response: An empty 204 response.

    Raises:
        ApiError: 404 when the building does not exist.
    """
    if execute("DELETE FROM buildings WHERE id = %s", (building_id,)) == 0:
        raise not_found("Building", building_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------
# Floors
# --------------------------------------------------------------------------
# GET /buildings/{building_id}/floors
# Response 200:
#   [{"id": 10, "building_id": 1, "building_name": "HQ North", "level": 3,
#     "name": "Engineering", "seat_count": 48,
#     "created_at": "2026-09-22T10:00:00Z"}]
# Response 404: not_found (unknown building)
@router.get(
    "/buildings/{building_id}/floors",
    response_model=list[FloorResponse],
    summary="List floors in a building",
)
async def list_floors(building_id: int, _: dict[str, Any] = _ANY_USER) -> list[dict[str, Any]]:
    """
    List the floors of a building, lowest level first.

    Args:
        building_id: Parent building identifier.
        _: Authenticated caller (any role).

    Returns:
        list[dict]: Floors with seat counts.

    Raises:
        ApiError: 404 when the building does not exist.
    """
    if fetch_one("SELECT id FROM buildings WHERE id = %s", (building_id,)) is None:
        raise not_found("Building", building_id)
    return fetch_all(
        f"{_FLOOR_SELECT} WHERE f.building_id = %s GROUP BY f.id, b.name ORDER BY f.level",
        (building_id,),
    )


# POST /buildings/{building_id}/floors
# Request body: {"level": 3, "name": "Engineering"}
# Response 201: the created floor object (seat_count = 0)
# Response 404: not_found (unknown building) | 409: conflict (duplicate level)
@router.post(
    "/buildings/{building_id}/floors",
    response_model=FloorResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add a floor to a building",
)
async def create_floor(
    building_id: int,
    payload: FloorCreate,
    _: dict[str, Any] = _ADMIN_ONLY,
) -> dict[str, Any]:
    """
    Add a floor to a building.

    Args:
        building_id: Parent building identifier.
        payload: Floor level and optional label.
        _: Authenticated facility admin (authorization only).

    Returns:
        dict: The created floor.

    Raises:
        ApiError: 404 when the building is missing, 409 when the level is taken.
    """
    if fetch_one("SELECT id FROM buildings WHERE id = %s", (building_id,)) is None:
        raise not_found("Building", building_id)
    if fetch_one(
        "SELECT id FROM floors WHERE building_id = %s AND level = %s", (building_id, payload.level)
    ):
        raise ApiError(409, "conflict", "That floor level already exists in this building")

    created = fetch_one(
        "INSERT INTO floors (building_id, level, name) VALUES (%s, %s, %s) RETURNING id",
        (building_id, payload.level, payload.name),
    )
    return await get_floor(int((created or {})["id"]), _)


# GET /floors/{floor_id}
# Response 200: single floor object | Response 404: not_found
@router.get("/floors/{floor_id}", response_model=FloorResponse, summary="Fetch a floor")
async def get_floor(floor_id: int, _: dict[str, Any] = _ANY_USER) -> dict[str, Any]:
    """
    Fetch one floor by id.

    Args:
        floor_id: Floor identifier.
        _: Authenticated caller (any role).

    Returns:
        dict: The floor record.

    Raises:
        ApiError: 404 when the floor does not exist.
    """
    floor = fetch_one(f"{_FLOOR_SELECT} WHERE f.id = %s GROUP BY f.id, b.name", (floor_id,))
    if floor is None:
        raise not_found("Floor", floor_id)
    return floor


# PUT /floors/{floor_id}
# Request body (all fields optional): {"level": 4, "name": "Design"}
# Response 200: the updated floor object
# Response 400: validation_error | 404: not_found | 409: conflict
@router.put("/floors/{floor_id}", response_model=FloorResponse, summary="Update a floor")
async def update_floor(
    floor_id: int,
    payload: FloorUpdate,
    _: dict[str, Any] = _ADMIN_ONLY,
) -> dict[str, Any]:
    """
    Update a floor's level and/or label.

    Args:
        floor_id: Floor identifier.
        payload: Fields to change.
        _: Authenticated facility admin (authorization only).

    Returns:
        dict: The updated floor.

    Raises:
        ApiError: 404 when missing, 409 when the new level collides.
    """
    floor = fetch_one("SELECT id, building_id FROM floors WHERE id = %s", (floor_id,))
    if floor is None:
        raise not_found("Floor", floor_id)
    if payload.level is not None and fetch_one(
        "SELECT id FROM floors WHERE building_id = %s AND level = %s AND id <> %s",
        (floor["building_id"], payload.level, floor_id),
    ):
        raise ApiError(409, "conflict", "That floor level already exists in this building")

    _apply_updates("floors", floor_id, payload.model_dump(exclude_unset=True), "id")
    return await get_floor(floor_id, _)


# DELETE /floors/{floor_id}
# Response 204: empty body | Response 404: not_found
@router.delete("/floors/{floor_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a floor")
async def delete_floor(floor_id: int, _: dict[str, Any] = _ADMIN_ONLY) -> Response:
    """
    Delete a floor and its seats.

    Args:
        floor_id: Floor identifier.
        _: Authenticated facility admin (authorization only).

    Returns:
        Response: An empty 204 response.

    Raises:
        ApiError: 404 when the floor does not exist.
    """
    if execute("DELETE FROM floors WHERE id = %s", (floor_id,)) == 0:
        raise not_found("Floor", floor_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------
# Seats
# --------------------------------------------------------------------------
# GET /floors/{floor_id}/seats?q=3A
# Response 200:
#   [{"id": 99, "floor_id": 10, "building_id": 1, "building_name": "HQ North",
#     "floor_level": 3, "code": "3A-12", "description": "Window desk",
#     "created_at": "2026-09-22T10:00:00Z"}]
# Response 404: not_found (unknown floor)
@router.get("/floors/{floor_id}/seats", response_model=list[SeatResponse], summary="List seats")
async def list_seats(
    floor_id: int,
    _: dict[str, Any] = _ANY_USER,
    q: Optional[str] = Query(default=None, max_length=120, description="Search by seat code"),
) -> list[dict[str, Any]]:
    """
    List the seats on a floor.

    Args:
        floor_id: Parent floor identifier.
        _: Authenticated caller (any role).
        q: Case-insensitive substring match on the seat code.

    Returns:
        list[dict]: Seats ordered by code.

    Raises:
        ApiError: 404 when the floor does not exist.
    """
    if fetch_one("SELECT id FROM floors WHERE id = %s", (floor_id,)) is None:
        raise not_found("Floor", floor_id)
    where = "WHERE s.floor_id = %s"
    params: list[Any] = [floor_id]
    if q:
        where += " AND s.code ILIKE %s"
        params.append(f"%{q}%")
    return fetch_all(f"{_SEAT_SELECT} {where} ORDER BY s.code", params)


# POST /floors/{floor_id}/seats
# Request body: {"code": "3A-12", "description": "Window desk"}
# Response 201: the created seat object
# Response 404: not_found (unknown floor) | 409: conflict (duplicate code)
@router.post(
    "/floors/{floor_id}/seats",
    response_model=SeatResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add a seat to a floor",
)
async def create_seat(
    floor_id: int,
    payload: SeatCreate,
    _: dict[str, Any] = _ADMIN_ONLY,
) -> dict[str, Any]:
    """
    Add a seat to a floor.

    Args:
        floor_id: Parent floor identifier.
        payload: Seat code and optional description.
        _: Authenticated facility admin (authorization only).

    Returns:
        dict: The created seat.

    Raises:
        ApiError: 404 when the floor is missing, 409 when the code is taken.
    """
    if fetch_one("SELECT id FROM floors WHERE id = %s", (floor_id,)) is None:
        raise not_found("Floor", floor_id)
    if fetch_one("SELECT id FROM seats WHERE floor_id = %s AND code = %s", (floor_id, payload.code)):
        raise ApiError(409, "conflict", "That seat code already exists on this floor")

    created = fetch_one(
        "INSERT INTO seats (floor_id, code, description) VALUES (%s, %s, %s) RETURNING id",
        (floor_id, payload.code, payload.description),
    )
    return await get_seat(int((created or {})["id"]), _)


# GET /seats/{seat_id}
# Response 200: single seat object | Response 404: not_found
@router.get("/seats/{seat_id}", response_model=SeatResponse, summary="Fetch a seat")
async def get_seat(seat_id: int, _: dict[str, Any] = _ANY_USER) -> dict[str, Any]:
    """
    Fetch one seat by id, including its floor and building.

    Args:
        seat_id: Seat identifier.
        _: Authenticated caller (any role).

    Returns:
        dict: The seat record.

    Raises:
        ApiError: 404 when the seat does not exist.
    """
    seat = fetch_one(f"{_SEAT_SELECT} WHERE s.id = %s", (seat_id,))
    if seat is None:
        raise not_found("Seat", seat_id)
    return seat


# PUT /seats/{seat_id}
# Request body (all fields optional): {"code": "3A-14", "description": "Standing desk"}
# Response 200: the updated seat object
# Response 400: validation_error | 404: not_found | 409: conflict
@router.put("/seats/{seat_id}", response_model=SeatResponse, summary="Update a seat")
async def update_seat(
    seat_id: int,
    payload: SeatUpdate,
    _: dict[str, Any] = _ADMIN_ONLY,
) -> dict[str, Any]:
    """
    Update a seat's code and/or description.

    Args:
        seat_id: Seat identifier.
        payload: Fields to change.
        _: Authenticated facility admin (authorization only).

    Returns:
        dict: The updated seat.

    Raises:
        ApiError: 404 when missing, 409 when the new code collides.
    """
    seat = fetch_one("SELECT id, floor_id FROM seats WHERE id = %s", (seat_id,))
    if seat is None:
        raise not_found("Seat", seat_id)
    if payload.code and fetch_one(
        "SELECT id FROM seats WHERE floor_id = %s AND code = %s AND id <> %s",
        (seat["floor_id"], payload.code, seat_id),
    ):
        raise ApiError(409, "conflict", "That seat code already exists on this floor")

    _apply_updates("seats", seat_id, payload.model_dump(exclude_unset=True), "id")
    return await get_seat(seat_id, _)


# DELETE /seats/{seat_id}
# Response 204: empty body | Response 404: not_found
@router.delete("/seats/{seat_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a seat")
async def delete_seat(seat_id: int, _: dict[str, Any] = _ADMIN_ONLY) -> Response:
    """
    Delete a seat.

    Args:
        seat_id: Seat identifier.
        _: Authenticated facility admin (authorization only).

    Returns:
        Response: An empty 204 response.

    Raises:
        ApiError: 404 when the seat does not exist.
    """
    if execute("DELETE FROM seats WHERE id = %s", (seat_id,)) == 0:
        raise not_found("Seat", seat_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
