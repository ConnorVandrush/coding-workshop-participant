"""
Incidents: the core of the platform.

Visibility rules applied to every read in this module:

* ``employee``       - only incidents they reported.
* ``engineer``       - incidents assigned to them, plus unassigned ones so they
                       can pick work up.
* ``facility_admin`` - everything.

Write rules are enforced per endpoint and documented above each route.
"""

from typing import Any, Optional

from fastapi import APIRouter, Depends, Query, Response, status

from app.database import cursor, execute, fetch_all, fetch_one
from app.domain import (
    IncidentCategory,
    IncidentPriority,
    IncidentStatus,
    REPORTER_TRANSITIONS,
    Role,
    TRANSITIONS,
    can_transition,
)
from app.duplicates import find_similar
from app.errors import ApiError, not_found
from app.notifications import enqueue
from app.models import (
    DuplicateCheck,
    IncidentAssign,
    IncidentCreate,
    IncidentEscalation,
    IncidentPage,
    IncidentResponse,
    IncidentStatusChange,
    IncidentUpdate,
    NoteCreate,
    NoteResponse,
    SimilarIncidents,
)
from app.security import engineer_profile_id, get_current_user, is_admin

router = APIRouter(prefix="/incidents", tags=["incidents"])

_ANY_USER = Depends(get_current_user)

_INCIDENT_SELECT = """
    SELECT i.id, i.title, i.description, i.category, i.priority, i.status,
           i.is_escalated, i.escalation_note, i.blocked_reason, i.resolution,
           i.created_at, i.updated_at, i.acknowledged_at, i.assigned_at,
           i.resolved_at, i.closed_at,
           i.reporter_id, ru.full_name AS reporter_name, ru.email AS reporter_email,
           i.assignee_id, au.id AS assignee_user_id,
           au.full_name AS assignee_name, au.email AS assignee_email,
           i.building_id, b.name AS building_name,
           i.floor_id, f.level AS floor_level,
           i.seat_id, s.code AS seat_code,
           (SELECT COUNT(*) FROM incident_notes n WHERE n.incident_id = i.id)::int AS note_count
    FROM incidents i
    JOIN users ru ON ru.id = i.reporter_id
    LEFT JOIN engineer_profiles e ON e.id = i.assignee_id
    LEFT JOIN users au ON au.id = e.user_id
    LEFT JOIN buildings b ON b.id = i.building_id
    LEFT JOIN floors f ON f.id = i.floor_id
    LEFT JOIN seats s ON s.id = i.seat_id
"""

_SORTABLE = {
    "created_at": "i.created_at",
    "updated_at": "i.updated_at",
    "priority": "CASE i.priority WHEN 'CRITICAL' THEN 4 WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2 ELSE 1 END",
    "status": "i.status",
}


def _serialise(row: dict[str, Any]) -> dict[str, Any]:
    """
    Shape a joined incident row into the API response object.

    Args:
        row: A row produced by ``_INCIDENT_SELECT``.

    Returns:
        dict: The nested incident representation returned to clients.
    """
    assignee = None
    if row.get("assignee_id"):
        assignee = {
            "id": row["assignee_id"],
            "user_id": row["assignee_user_id"],
            "full_name": row["assignee_name"],
            "email": row["assignee_email"],
        }
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "category": row["category"],
        "priority": row["priority"],
        "status": row["status"],
        "is_escalated": row["is_escalated"],
        "escalation_note": row["escalation_note"],
        "blocked_reason": row["blocked_reason"],
        "resolution": row["resolution"],
        "reporter": {
            "id": row["reporter_id"],
            "user_id": row["reporter_id"],
            "full_name": row["reporter_name"],
            "email": row["reporter_email"],
        },
        "assignee": assignee,
        "location": {
            "building_id": row["building_id"],
            "building_name": row["building_name"],
            "floor_id": row["floor_id"],
            "floor_level": row["floor_level"],
            "seat_id": row["seat_id"],
            "seat_code": row["seat_code"],
        },
        "note_count": row["note_count"],
        "allowed_transitions": list(TRANSITIONS.get(IncidentStatus(row["status"]), ())),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "acknowledged_at": row["acknowledged_at"],
        "assigned_at": row["assigned_at"],
        "resolved_at": row["resolved_at"],
        "closed_at": row["closed_at"],
    }


def visibility_clause(user: dict[str, Any]) -> tuple[str, list[Any]]:
    """
    Build the SQL fragment restricting rows to what the caller may see.

    Args:
        user: The authenticated user row.

    Returns:
        tuple[str, list]: A boolean SQL expression and its parameters.
    """
    if is_admin(user):
        return "TRUE", []
    if user["role"] == Role.ENGINEER:
        profile_id = engineer_profile_id(user)
        if profile_id is None:
            # Engineer without a profile yet: only unassigned work is visible.
            return "i.assignee_id IS NULL", []
        return "(i.assignee_id = %s OR i.assignee_id IS NULL)", [profile_id]
    return "i.reporter_id = %s", [user["id"]]


def _load_incident(incident_id: int, user: dict[str, Any]) -> dict[str, Any]:
    """
    Fetch one incident, enforcing visibility.

    Args:
        incident_id: Incident identifier.
        user: The authenticated user row.

    Returns:
        dict: The raw joined row.

    Raises:
        ApiError: 404 when the incident is missing or not visible to the caller.
    """
    clause, params = visibility_clause(user)
    row = fetch_one(f"{_INCIDENT_SELECT} WHERE i.id = %s AND {clause}", [incident_id, *params])
    if row is None:
        # Deliberately 404 rather than 403 so that ids are not enumerable.
        raise not_found("Incident", incident_id)
    return row


def _validate_location(building_id: Optional[int], floor_id: Optional[int], seat_id: Optional[int]) -> None:
    """
    Check that the referenced location exists and is internally consistent.

    Args:
        building_id: Optional building reference.
        floor_id: Optional floor reference.
        seat_id: Optional seat reference.

    Raises:
        ApiError: 400 when a reference is unknown or the seat/floor/building
            chain does not line up.
    """
    if building_id is not None and fetch_one("SELECT id FROM buildings WHERE id = %s", (building_id,)) is None:
        raise ApiError(400, "validation_error", f"Building {building_id} does not exist")

    floor = None
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


def _may_work_on(incident: dict[str, Any], user: dict[str, Any]) -> bool:
    """
    Report whether the caller may drive an incident's workflow.

    Args:
        incident: The incident row.
        user: The authenticated user row.

    Returns:
        bool: True for facility admins and the assigned engineer.
    """
    if is_admin(user):
        return True
    if user["role"] != Role.ENGINEER:
        return False
    return incident["assignee_id"] is not None and incident["assignee_id"] == engineer_profile_id(user)


# --------------------------------------------------------------------------
# CRUD
# --------------------------------------------------------------------------
# GET /incidents?status=OPEN&priority=HIGH&q=projector&limit=25&offset=0
# Request:  header `Authorization: Bearer <token>`, no body.
#   Query params: status, priority, category, building_id, floor_id, seat_id,
#                 assignee_id, reporter_id, is_escalated, unassigned,
#                 q (title/description search), sort (created_at|updated_at|
#                 priority|status), order (asc|desc), limit (1-100, default 25),
#                 offset (default 0).
# Response 200:
#   {"items": [ <incident object, see GET /incidents/{id}> ],
#    "total": 137, "limit": 25, "offset": 0}
@router.get("", response_model=IncidentPage, summary="Search and filter incidents")
async def list_incidents(
    user: dict[str, Any] = _ANY_USER,
    status_filter: Optional[IncidentStatus] = Query(default=None, alias="status"),
    priority: Optional[IncidentPriority] = Query(default=None),
    category: Optional[IncidentCategory] = Query(default=None),
    building_id: Optional[int] = Query(default=None),
    floor_id: Optional[int] = Query(default=None),
    seat_id: Optional[int] = Query(default=None),
    assignee_id: Optional[int] = Query(default=None, description="Engineer profile id"),
    reporter_id: Optional[int] = Query(default=None, description="Reporting user id"),
    is_escalated: Optional[bool] = Query(default=None),
    unassigned: Optional[bool] = Query(default=None, description="Only incidents with no engineer"),
    q: Optional[str] = Query(default=None, max_length=200, description="Search title and description"),
    sort: str = Query(default="created_at", pattern="^(created_at|updated_at|priority|status)$"),
    order: str = Query(default="desc", pattern="^(asc|desc)$"),
    limit: int = Query(default=25, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    """
    Return a filtered, sorted, paginated page of incidents the caller may see.

    Args:
        user: The authenticated caller.
        status_filter: Exact status match (query parameter is named ``status``).
        priority: Exact priority match.
        category: Exact category match.
        building_id: Restrict to a building.
        floor_id: Restrict to a floor.
        seat_id: Restrict to a seat.
        assignee_id: Restrict to an engineer profile.
        reporter_id: Restrict to a reporting user.
        is_escalated: Restrict to escalated or non-escalated incidents.
        unassigned: When True, only incidents without an assignee.
        q: Case-insensitive substring search over title and description.
        sort: Sort column.
        order: Sort direction.
        limit: Page size.
        offset: Rows to skip.

    Returns:
        dict: ``items``, ``total``, ``limit`` and ``offset``.
    """
    clause, params = visibility_clause(user)
    clauses = [clause]

    simple_filters: list[tuple[str, Any]] = [
        ("i.status = %s", status_filter),
        ("i.priority = %s", priority),
        ("i.category = %s", category),
        ("i.building_id = %s", building_id),
        ("i.floor_id = %s", floor_id),
        ("i.seat_id = %s", seat_id),
        ("i.assignee_id = %s", assignee_id),
        ("i.reporter_id = %s", reporter_id),
        ("i.is_escalated = %s", is_escalated),
    ]
    for fragment, value in simple_filters:
        if value is not None:
            clauses.append(fragment)
            params.append(value.value if hasattr(value, "value") else value)

    if unassigned:
        clauses.append("i.assignee_id IS NULL")
    if q:
        clauses.append("(i.title ILIKE %s OR i.description ILIKE %s)")
        params.extend([f"%{q}%", f"%{q}%"])

    where = " AND ".join(clauses)
    total_row = fetch_one(f"SELECT COUNT(*)::int AS total FROM incidents i WHERE {where}", params)  # nosec B608 # identifiers below are module constants, never client input; every value is bound with %s

    rows = fetch_all(
        f"{_INCIDENT_SELECT} WHERE {where} "
        f"ORDER BY {_SORTABLE[sort]} {'ASC' if order == 'asc' else 'DESC'}, i.id DESC "
        "LIMIT %s OFFSET %s",
        [*params, limit, offset],
    )
    return {
        "items": [_serialise(row) for row in rows],
        "total": (total_row or {}).get("total", 0),
        "limit": limit,
        "offset": offset,
    }


# POST /incidents
# Request body:
#   {"title": "Projector will not power on",
#    "description": "Meeting room 3A projector is dead since Monday.",
#    "category": "AV_EQUIPMENT", "priority": "HIGH",
#    "building_id": 1, "floor_id": 10, "seat_id": 99}
#   - category: HVAC|ELECTRICAL|PLUMBING|FURNITURE|CLEANING|SECURITY|NETWORK|
#               HARDWARE|SOFTWARE|AV_EQUIPMENT|OTHER
#   - priority: LOW|MEDIUM|HIGH|CRITICAL (default MEDIUM)
#   - location fields are optional but must be consistent when supplied.
# Response 201: the created incident object (see GET /incidents/{id})
# Response 400: validation_error (unknown or mismatched location)
@router.post(
    "",
    response_model=IncidentResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Report a new incident",
)
async def create_incident(payload: IncidentCreate, user: dict[str, Any] = _ANY_USER) -> dict[str, Any]:
    """
    Report an incident. Any authenticated persona may report one.

    Args:
        payload: Incident details and optional location.
        user: The authenticated caller, recorded as the reporter.

    Returns:
        dict: The created incident.
    """
    _validate_location(payload.building_id, payload.floor_id, payload.seat_id)

    created = fetch_one(
        """
        INSERT INTO incidents
            (title, description, category, priority, reporter_id,
             building_id, floor_id, seat_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (
            payload.title,
            payload.description,
            payload.category.value,
            payload.priority.value,
            user["id"],
            payload.building_id,
            payload.floor_id,
            payload.seat_id,
        ),
    )
    return _serialise(_load_incident(int((created or {})["id"]), user))


# POST /incidents/duplicate-check
# Ask whether a problem has already been reported, before reporting it again.
# Request:  header `Authorization: Bearer <token>`
#   {"title": "Projecter wont turn on in 3A",      // required
#    "description": "nothing happens",              // optional, improves recall
#    "category": "AV_EQUIPMENT",                    // optional, weighs heavily
#    "building_id": 1, "floor_id": 10, "seat_id": 99}  // optional
# Response 200:
#   {"matches": [
#      {"id": 42, "title": "Projector will not power on in Meeting Room 3A",
#       "category": "AV_EQUIPMENT", "priority": "HIGH", "status": "IN_PROGRESS",
#       "location": {"building_id": 1, "building_name": "HQ North",
#                    "floor_id": 10, "floor_level": 3,
#                    "seat_id": null, "seat_code": null},
#       "created_at": "2026-09-21T09:12:00Z",
#       "score": 0.76, "reasons": ["wording is very similar", "same category",
#                                  "same floor"],
#       "visible": true}]}
# An empty list means nothing similar is open; it is not an error.
@router.post("/duplicate-check", response_model=SimilarIncidents, summary="Find existing reports of the same problem")
async def duplicate_check(payload: DuplicateCheck, user: dict[str, Any] = _ANY_USER) -> dict[str, Any]:
    """
    Look for open incidents that appear to describe the problem being reported.

    Matches deliberately ignore the caller's visibility: the point of the
    feature is to reveal that *somebody* has already reported the broken air
    conditioner, which an employee restricted to their own incidents would
    otherwise never learn. Each match instead carries ``visible``, saying
    whether the caller may open the full record, and the match itself omits the
    description and reporter so nothing beyond the existence of the incident is
    disclosed.

    Args:
        payload: The draft incident's text and optional category and location.
        user: The authenticated caller.

    Returns:
        dict: ``{"matches": [...]}`` ordered by descending score.
    """
    return {
        "matches": find_similar(
            title=payload.title,
            description=payload.description or "",
            category=payload.category.value if payload.category else None,
            building_id=payload.building_id,
            floor_id=payload.floor_id,
            seat_id=payload.seat_id,
            visibility=visibility_clause(user),
        )
    }


# GET /incidents/{incident_id}
# Request:  header `Authorization: Bearer <token>`, no body.
# Response 200:
#   {"id": 42, "title": "Projector will not power on",
#    "description": "...", "category": "AV_EQUIPMENT", "priority": "HIGH",
#    "status": "IN_PROGRESS", "is_escalated": false, "escalation_note": null,
#    "blocked_reason": null, "resolution": null,
#    "reporter": {"id": 7, "user_id": 7, "full_name": "Dana Ruiz",
#                 "email": "dana@acme.inc"},
#    "assignee": {"id": 3, "user_id": 12, "full_name": "Sam Okafor",
#                 "email": "sam@acme.inc"},
#    "location": {"building_id": 1, "building_name": "HQ North", "floor_id": 10,
#                 "floor_level": 3, "seat_id": 99, "seat_code": "3A-12"},
#    "note_count": 2,
#    "allowed_transitions": ["BLOCKED", "RESOLVED", "OPEN"],
#    "created_at": "2026-09-22T10:00:00Z", "updated_at": "2026-09-22T11:30:00Z",
#    "acknowledged_at": "2026-09-22T10:20:00Z",
#    "assigned_at": "2026-09-22T10:20:00Z",
#    "resolved_at": null, "closed_at": null}
# Response 404: not_found (missing, or not visible to this caller)
@router.get("/{incident_id}", response_model=IncidentResponse, summary="Fetch one incident")
async def get_incident(incident_id: int, user: dict[str, Any] = _ANY_USER) -> dict[str, Any]:
    """
    Fetch a single incident the caller is allowed to see.

    Args:
        incident_id: Incident identifier.
        user: The authenticated caller.

    Returns:
        dict: The incident.

    Raises:
        ApiError: 404 when missing or out of scope.
    """
    return _serialise(_load_incident(incident_id, user))


# PUT /incidents/{incident_id}
# Request body (all fields optional):
#   {"title": "...", "description": "...", "category": "HARDWARE",
#    "priority": "CRITICAL", "building_id": 1, "floor_id": 10, "seat_id": 99}
# Rules: the reporter may edit descriptive fields only while the incident is
#        still OPEN and may not change `priority`; engineers assigned to the
#        incident and facility admins may edit at any time, `priority` included.
# Response 200: the updated incident object
# Response 400: validation_error | 403: forbidden | 404: not_found
@router.put("/{incident_id}", response_model=IncidentResponse, summary="Update an incident")
async def update_incident(
    incident_id: int,
    payload: IncidentUpdate,
    user: dict[str, Any] = _ANY_USER,
) -> dict[str, Any]:
    """
    Edit an incident's descriptive fields, location or priority.

    Args:
        incident_id: Incident identifier.
        payload: Fields to change; omitted fields are left as-is.
        user: The authenticated caller.

    Returns:
        dict: The updated incident.

    Raises:
        ApiError: 400 for an empty or inconsistent payload, 403 when the caller
            may not edit this incident, 404 when it is missing or out of scope.
    """
    incident = _load_incident(incident_id, user)
    fields = payload.model_dump(exclude_unset=True)
    if not fields:
        raise ApiError(400, "validation_error", "Supply at least one field to update")

    is_reporter = incident["reporter_id"] == user["id"]
    staff = _may_work_on(incident, user)
    if not staff:
        if not is_reporter:
            raise ApiError(403, "forbidden", "Only the reporter or assigned staff may edit this incident")
        if incident["status"] != IncidentStatus.OPEN:
            raise ApiError(403, "forbidden", "Incidents can only be edited by the reporter while OPEN")
        if "priority" in fields:
            raise ApiError(
                403,
                "forbidden",
                "Use POST /incidents/{id}/escalate to request a higher priority",
            )

    _validate_location(
        fields.get("building_id", incident["building_id"]),
        fields.get("floor_id", incident["floor_id"]),
        fields.get("seat_id", incident["seat_id"]),
    )

    values = {key: (value.value if hasattr(value, "value") else value) for key, value in fields.items()}
    assignments = ", ".join(f"{column} = %s" for column in values)
    execute(
        f"UPDATE incidents SET {assignments}, updated_at = NOW() WHERE id = %s",  # nosec B608 # identifiers below are module constants, never client input; every value is bound with %s
        [*values.values(), incident_id],
    )
    return _serialise(_load_incident(incident_id, user))


# DELETE /incidents/{incident_id}
# Request:  no body. Facility admins only; notes are removed with the incident.
# Response 204: empty body
# Response 403: forbidden | 404: not_found
@router.delete("/{incident_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete an incident")
async def delete_incident(incident_id: int, user: dict[str, Any] = _ANY_USER) -> Response:
    """
    Permanently remove an incident and its notes.

    Args:
        incident_id: Incident identifier.
        user: The authenticated caller; must be a facility admin.

    Returns:
        Response: An empty 204 response.

    Raises:
        ApiError: 403 for non-admins, 404 when the incident does not exist.
    """
    if not is_admin(user):
        raise ApiError(403, "forbidden", "Only facility admins may delete incidents")
    if execute("DELETE FROM incidents WHERE id = %s", (incident_id,)) == 0:
        raise not_found("Incident", incident_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --------------------------------------------------------------------------
# Workflow
# --------------------------------------------------------------------------
# POST /incidents/{incident_id}/assign
# Request body: {"engineer_id": 3, "note": "Sam owns AV kit on this floor"}
#   - `engineer_id: null` unassigns the incident.
# Rules: facility admins may assign anyone; an engineer may only self-assign an
#        unassigned incident.
# Response 200: the updated incident object
# Response 400: validation_error (engineer unavailable or at capacity)
# Response 403: forbidden | 404: not_found (incident or engineer)
@router.post("/{incident_id}/assign", response_model=IncidentResponse, summary="Assign an incident")
async def assign_incident(
    incident_id: int,
    payload: IncidentAssign,
    user: dict[str, Any] = _ANY_USER,
) -> dict[str, Any]:
    """
    Assign or unassign an incident, recording an optional note.

    Assignment also stamps ``acknowledged_at`` the first time, which is what the
    dashboard's acknowledgement SLA measures.

    Args:
        incident_id: Incident identifier.
        payload: Target engineer profile id (or null) and an optional note.
        user: The authenticated caller.

    Returns:
        dict: The updated incident.

    Raises:
        ApiError: 403 when the caller may not assign, 404 for unknown records,
            400 when the engineer is unavailable or already at capacity.
    """
    incident = _load_incident(incident_id, user)
    own_profile = engineer_profile_id(user)

    if not is_admin(user):
        if user["role"] != Role.ENGINEER:
            raise ApiError(403, "forbidden", "Only engineers and facility admins may assign incidents")
        if payload.engineer_id != own_profile:
            raise ApiError(403, "forbidden", "Engineers may only assign incidents to themselves")
        if incident["assignee_id"] not in (None, own_profile):
            raise ApiError(403, "forbidden", "This incident is already assigned to another engineer")

    if payload.engineer_id is not None:
        engineer = fetch_one(
            """
            SELECT e.id, e.is_available, e.max_active_incidents,
                   COUNT(i.id) FILTER (WHERE i.status IN ('OPEN', 'IN_PROGRESS', 'BLOCKED'))::int AS active
            FROM engineer_profiles e
            LEFT JOIN incidents i ON i.assignee_id = e.id AND i.id <> %s
            WHERE e.id = %s
            GROUP BY e.id
            """,
            (incident_id, payload.engineer_id),
        )
        if engineer is None:
            raise not_found("Engineer", payload.engineer_id)
        if not engineer["is_available"]:
            raise ApiError(400, "engineer_unavailable", "That engineer is currently unavailable")
        if engineer["active"] >= engineer["max_active_incidents"]:
            raise ApiError(
                400,
                "engineer_at_capacity",
                "That engineer is already at their maximum active incident count",
                {"active": engineer["active"], "max": engineer["max_active_incidents"]},
            )

    with cursor(transactional=True) as cur:
        cur.execute(
            """
            UPDATE incidents
            SET assignee_id = %s,
                assigned_at = CASE WHEN %s IS NULL THEN NULL ELSE NOW() END,
                acknowledged_at = COALESCE(acknowledged_at, CASE WHEN %s IS NULL THEN NULL ELSE NOW() END),
                updated_at = NOW()
            WHERE id = %s
            """,
            (payload.engineer_id, payload.engineer_id, payload.engineer_id, incident_id),
        )
        body = payload.note or (
            f"Assigned to engineer #{payload.engineer_id}" if payload.engineer_id else "Unassigned"
        )
        cur.execute(
            "INSERT INTO incident_notes (incident_id, author_id, body, is_internal) VALUES (%s, %s, %s, TRUE)",
            (incident_id, user["id"], body),
        )

    # Fan-out happens off the request: a notification failure must not undo an
    # assignment that has already been made.
    enqueue("assigned", int(incident_id), user["id"])
    return _serialise(_load_incident(incident_id, user))


# POST /incidents/{incident_id}/status
# Request body:
#   {"status": "BLOCKED", "reason": "Replacement lamp on back-order"}
#   {"status": "RESOLVED", "resolution": "Swapped the projector lamp"}
#   - `reason` is required for BLOCKED, `resolution` for RESOLVED.
# Rules: the assigned engineer or a facility admin drives the workflow; the
#        reporter may only close or reopen their own RESOLVED incident.
#        Legal transitions come from GET /workflow.
# Response 200: the updated incident object
# Response 400: validation_error (missing reason/resolution)
# Response 403: forbidden | 404: not_found | 409: invalid_transition
@router.post("/{incident_id}/status", response_model=IncidentResponse, summary="Change status")
async def change_status(
    incident_id: int,
    payload: IncidentStatusChange,
    user: dict[str, Any] = _ANY_USER,
) -> dict[str, Any]:
    """
    Move an incident through the workflow and stamp the matching timestamp.

    Args:
        incident_id: Incident identifier.
        payload: Target status plus the reason or resolution it requires.
        user: The authenticated caller.

    Returns:
        dict: The updated incident.

    Raises:
        ApiError: 409 for an illegal transition, 403 when the caller may not
            drive it, 400 when the mandatory explanation is missing.
    """
    incident = _load_incident(incident_id, user)
    current = IncidentStatus(incident["status"])
    target = payload.status

    if current == target:
        raise ApiError(409, "invalid_transition", f"Incident is already {target.value}")
    if not can_transition(current.value, target.value):
        raise ApiError(
            409,
            "invalid_transition",
            f"Cannot move an incident from {current.value} to {target.value}",
            {"allowed": [state.value for state in TRANSITIONS.get(current, ())]},
        )

    reporter_move = (
        incident["reporter_id"] == user["id"] and (current, target) in REPORTER_TRANSITIONS
    )
    if not (_may_work_on(incident, user) or reporter_move):
        raise ApiError(403, "forbidden", "Only the assigned engineer or a facility admin may change status")

    if target == IncidentStatus.BLOCKED and not payload.reason:
        raise ApiError(400, "validation_error", "A reason is required when blocking an incident")
    if target == IncidentStatus.RESOLVED and not payload.resolution:
        raise ApiError(400, "validation_error", "A resolution is required when resolving an incident")

    with cursor(transactional=True) as cur:
        cur.execute(
            """
            UPDATE incidents
            SET status          = %s,
                blocked_reason  = CASE WHEN %s = 'BLOCKED' THEN %s ELSE NULL END,
                resolution      = CASE WHEN %s IN ('RESOLVED', 'CLOSED') THEN COALESCE(%s, resolution) ELSE NULL END,
                acknowledged_at = COALESCE(acknowledged_at, NOW()),
                resolved_at     = CASE WHEN %s = 'RESOLVED' THEN NOW()
                                       WHEN %s = 'CLOSED' THEN resolved_at ELSE NULL END,
                closed_at       = CASE WHEN %s = 'CLOSED' THEN NOW() ELSE NULL END,
                updated_at      = NOW()
            WHERE id = %s
            """,
            (
                target.value,
                target.value,
                payload.reason,
                target.value,
                payload.resolution,
                target.value,
                target.value,
                target.value,
                incident_id,
            ),
        )
        detail = payload.reason or payload.resolution
        cur.execute(
            "INSERT INTO incident_notes (incident_id, author_id, body, is_internal) VALUES (%s, %s, %s, FALSE)",
            (
                incident_id,
                user["id"],
                f"Status changed from {current.value} to {target.value}"
                + (f": {detail}" if detail else ""),
            ),
        )

    enqueue("status_changed", int(incident_id), user["id"], detail=target.value)
    return _serialise(_load_incident(incident_id, user))


# POST /incidents/{incident_id}/escalate
# Request body:
#   {"is_escalated": true, "reason": "Blocking a client demo tomorrow",
#    "priority": "CRITICAL"}
#   - `is_escalated: false` clears the flag (facility admins only).
#   - `priority` is honoured for facility admins; for an employee it is recorded
#     as a request in the escalation note instead.
# Rules: the reporter may escalate their own incident; facility admins may
#        escalate or de-escalate any incident.
# Response 200: the updated incident object
# Response 403: forbidden | 404: not_found
@router.post("/{incident_id}/escalate", response_model=IncidentResponse, summary="Escalate")
async def escalate_incident(
    incident_id: int,
    payload: IncidentEscalation,
    user: dict[str, Any] = _ANY_USER,
) -> dict[str, Any]:
    """
    Flag an incident as escalated, optionally raising its priority.

    Args:
        incident_id: Incident identifier.
        payload: Escalation flag, reason and optional target priority.
        user: The authenticated caller.

    Returns:
        dict: The updated incident.

    Raises:
        ApiError: 403 when the caller may neither escalate nor de-escalate.
    """
    incident = _load_incident(incident_id, user)
    admin = is_admin(user)

    if not admin:
        if incident["reporter_id"] != user["id"] and not _may_work_on(incident, user):
            raise ApiError(403, "forbidden", "Only the reporter or assigned staff may escalate")
        if not payload.is_escalated:
            raise ApiError(403, "forbidden", "Only facility admins may clear an escalation")

    note = payload.reason
    priority = payload.priority.value if (payload.priority and admin) else incident["priority"]
    if payload.priority and not admin:
        note = f"{note or 'Escalation requested'} (priority change to {payload.priority.value} requested)"

    with cursor(transactional=True) as cur:
        cur.execute(
            """
            UPDATE incidents
            SET is_escalated = %s, escalation_note = %s, priority = %s, updated_at = NOW()
            WHERE id = %s
            """,
            (payload.is_escalated, note, priority, incident_id),
        )
        cur.execute(
            "INSERT INTO incident_notes (incident_id, author_id, body, is_internal) VALUES (%s, %s, %s, FALSE)",
            (
                incident_id,
                user["id"],
                ("Escalated" if payload.is_escalated else "Escalation cleared")
                + (f": {note}" if note else ""),
            ),
        )

    enqueue("escalated" if payload.is_escalated else "de_escalated", int(incident_id), user["id"])
    return _serialise(_load_incident(incident_id, user))


# --------------------------------------------------------------------------
# Notes
# --------------------------------------------------------------------------
# GET /incidents/{incident_id}/notes
# Request:  header `Authorization: Bearer <token>`, no body.
#   Internal notes (`is_internal: true`) are omitted for employees.
# Response 200:
#   [{"id": 5, "incident_id": 42,
#     "author": {"id": 12, "user_id": 12, "full_name": "Sam Okafor",
#                "email": "sam@acme.inc"},
#     "body": "Ordered a replacement lamp.", "is_internal": false,
#     "created_at": "2026-09-22T11:00:00Z"}]
# Response 404: not_found
@router.get("/{incident_id}/notes", response_model=list[NoteResponse], summary="List incident notes")
async def list_notes(incident_id: int, user: dict[str, Any] = _ANY_USER) -> list[dict[str, Any]]:
    """
    List an incident's notes oldest first.

    Args:
        incident_id: Incident identifier.
        user: The authenticated caller.

    Returns:
        list[dict]: Visible notes with their authors.

    Raises:
        ApiError: 404 when the incident is missing or out of scope.
    """
    _load_incident(incident_id, user)
    visibility = "" if user["role"] != Role.EMPLOYEE else " AND n.is_internal = FALSE"
    rows = fetch_all(
        f"""
        SELECT n.id, n.incident_id, n.body, n.is_internal, n.created_at,
               u.id AS author_id, u.full_name AS author_name, u.email AS author_email
        FROM incident_notes n
        JOIN users u ON u.id = n.author_id
        WHERE n.incident_id = %s{visibility}
        ORDER BY n.created_at, n.id
        """,  # nosec B608 # identifiers below are module constants, never client input; every value is bound with %s
        (incident_id,),
    )
    return [
        {
            "id": row["id"],
            "incident_id": row["incident_id"],
            "author": {
                "id": row["author_id"],
                "user_id": row["author_id"],
                "full_name": row["author_name"],
                "email": row["author_email"],
            },
            "body": row["body"],
            "is_internal": row["is_internal"],
            "created_at": row["created_at"],
        }
        for row in rows
    ]


# POST /incidents/{incident_id}/notes
# Request body: {"body": "Ordered a replacement lamp.", "is_internal": false}
#   - employees may not post internal notes; the flag is rejected with 403.
#   - notes cannot be added to a CLOSED incident.
# Response 201: the created note object (same shape as the list items)
# Response 403: forbidden | 404: not_found | 409: incident_closed
@router.post(
    "/{incident_id}/notes",
    response_model=NoteResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Add a note to an incident",
)
async def create_note(
    incident_id: int,
    payload: NoteCreate,
    user: dict[str, Any] = _ANY_USER,
) -> dict[str, Any]:
    """
    Add a note so reporters and engineers can communicate on the ticket.

    Args:
        incident_id: Incident identifier.
        payload: Note body and internal-visibility flag.
        user: The authenticated caller, recorded as the author.

    Returns:
        dict: The created note.

    Raises:
        ApiError: 403 when an employee marks a note internal, 409 when the
            incident is already CLOSED, 404 when it is missing or out of scope.
    """
    incident = _load_incident(incident_id, user)
    if incident["status"] == IncidentStatus.CLOSED:
        raise ApiError(409, "incident_closed", "Notes cannot be added to a closed incident")
    if payload.is_internal and user["role"] == Role.EMPLOYEE:
        raise ApiError(403, "forbidden", "Employees cannot create internal notes")

    created = fetch_one(
        """
        INSERT INTO incident_notes (incident_id, author_id, body, is_internal)
        VALUES (%s, %s, %s, %s)
        RETURNING id, incident_id, body, is_internal, created_at
        """,
        (incident_id, user["id"], payload.body, payload.is_internal),
    )
    execute("UPDATE incidents SET updated_at = NOW() WHERE id = %s", (incident_id,))
    # Internal notes are staff-only, so they are not announced to the reporter.
    if not payload.is_internal:
        enqueue("note_added", int(incident_id), user["id"])
    return {
        **(created or {}),
        "author": {
            "id": user["id"],
            "user_id": user["id"],
            "full_name": user["full_name"],
            "email": user["email"],
        },
    }


# GET /incidents/{incident_id}/related
# The same ranking as POST /incidents/duplicate-check, run against an incident
# that already exists, so a triager can spot that three tickets are one fault.
# Request:  header `Authorization: Bearer <token>`, no body.
# Response 200: {"matches": [ <match object, see POST /incidents/duplicate-check> ]}
# Response 404: not_found (missing, or not visible to this caller)
@router.get("/{incident_id}/related", response_model=SimilarIncidents, summary="Find related incidents")
async def related_incidents(incident_id: int, user: dict[str, Any] = _ANY_USER) -> dict[str, Any]:
    """
    List incidents that look like the same problem as this one.

    The caller must be able to see the incident being asked about; the matches
    themselves follow the same disclosure rules as ``duplicate-check``.

    Args:
        incident_id: The incident to match against.
        user: The authenticated caller.

    Returns:
        dict: ``{"matches": [...]}`` ordered by descending score, excluding the
        incident itself.

    Raises:
        ApiError: 404 when the incident is missing or not visible to the caller.
    """
    incident = _load_incident(incident_id, user)
    return {
        "matches": find_similar(
            title=incident["title"],
            description=incident["description"],
            category=incident["category"],
            building_id=incident["building_id"],
            floor_id=incident["floor_id"],
            seat_id=incident["seat_id"],
            exclude_id=incident_id,
            visibility=visibility_clause(user),
        )
    }
