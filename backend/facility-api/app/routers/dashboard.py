"""
Reporting endpoints that answer the questions in the workshop brief.

Every aggregate reuses ``incidents.visibility_clause`` so an employee's
dashboard counts only their own tickets while a facility admin sees the whole
estate - one rule, enforced in one place.
"""

from typing import Any

from fastapi import APIRouter, Depends, Query

from app.database import fetch_all, fetch_one
from app.domain import ACTIVE_STATUSES, IncidentStatus, Role
from app.models import (
    DashboardHotspots,
    DashboardSla,
    DashboardSummary,
    EngineerWorkload,
)
from app.routers.incidents import visibility_clause
from app.security import get_current_user, require_roles

router = APIRouter(prefix="/dashboard", tags=["dashboard"])

_ANY_USER = Depends(get_current_user)
_ADMIN_ONLY = Depends(require_roles(Role.FACILITY_ADMIN))


def _buckets(column: str, where: str, params: list[Any]) -> list[dict[str, Any]]:
    """
    Group visible incidents by a column.

    Args:
        column: Column to group by (never user-supplied).
        where: Visibility/filter expression.
        params: Parameters for ``where``.

    Returns:
        list[dict]: ``{"key": ..., "count": ...}`` rows, largest first.
    """
    return fetch_all(
        f"""
        SELECT i.{column} AS key, COUNT(*)::int AS count
        FROM incidents i
        WHERE {where}
        GROUP BY i.{column}
        ORDER BY count DESC, key
        """,  # nosec B608 # identifiers below are module constants, never client input; every value is bound with %s
        params,
    )


# GET /dashboard/summary
# Request:  header `Authorization: Bearer <token>`, no body.
#   Counts are scoped to the caller's role (see the incidents module).
# Response 200:
#   {"scope": "facility_admin", "total": 137, "open_total": 41,
#    "escalated_total": 6, "unassigned_total": 12,
#    "by_status":   [{"key": "OPEN", "count": 23}, ...],
#    "by_priority": [{"key": "HIGH", "count": 18}, ...],
#    "by_category": [{"key": "HVAC", "count": 31}, ...]}
@router.get("/summary", response_model=DashboardSummary, summary="Headline counters")
async def summary(user: dict[str, Any] = _ANY_USER) -> dict[str, Any]:
    """
    Return ticket counts by status, priority and category for the caller.

    Args:
        user: The authenticated caller; determines the scope of the counts.

    Returns:
        dict: Headline totals plus three breakdown lists.
    """
    where, params = visibility_clause(user)

    totals = fetch_one(
        f"""
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE i.status = ANY(%s))::int AS open_total,
               COUNT(*) FILTER (WHERE i.is_escalated)::int AS escalated_total,
               COUNT(*) FILTER (WHERE i.assignee_id IS NULL
                                  AND i.status <> 'CLOSED')::int AS unassigned_total
        FROM incidents i
        WHERE {where}
        """,  # nosec B608 # identifiers below are module constants, never client input; every value is bound with %s
        [list(ACTIVE_STATUSES), *params],
    ) or {}

    return {
        "scope": user["role"],
        "total": totals.get("total", 0),
        "open_total": totals.get("open_total", 0),
        "escalated_total": totals.get("escalated_total", 0),
        "unassigned_total": totals.get("unassigned_total", 0),
        "by_status": _buckets("status", where, list(params)),
        "by_priority": _buckets("priority", where, list(params)),
        "by_category": _buckets("category", where, list(params)),
    }


# GET /dashboard/hotspots?limit=5
# Request:  header `Authorization: Bearer <token>`, no body.
#   Query param: limit (1-25, default 5) - rows per grouping.
# Response 200:
#   {"buildings": [{"id": 1, "label": "HQ North", "count": 44, "open_count": 12}],
#    "floors":    [{"id": 10, "label": "HQ North - Level 3", "count": 19, "open_count": 5}],
#    "seats":     [{"id": 99, "label": "HQ North - Level 3 - 3A-12", "count": 7, "open_count": 2}]}
@router.get("/hotspots", response_model=DashboardHotspots, summary="Recurring-issue hotspots")
async def hotspots(
    user: dict[str, Any] = _ANY_USER,
    limit: int = Query(default=5, ge=1, le=25, description="Rows per grouping"),
) -> dict[str, Any]:
    """
    Rank buildings, floors and seats by incident volume.

    Args:
        user: The authenticated caller; determines the scope of the counts.
        limit: How many rows to return per grouping.

    Returns:
        dict: ``buildings``, ``floors`` and ``seats`` hotspot lists.
    """
    where, params = visibility_clause(user)
    active = list(ACTIVE_STATUSES)

    def top(join: str, key: str, label: str, group: str) -> list[dict[str, Any]]:
        """Run one hotspot query; `join`/`key`/`label`/`group` are literals."""
        return fetch_all(
            f"""
            SELECT {key} AS id, {label} AS label, COUNT(*)::int AS count,
                   COUNT(*) FILTER (WHERE i.status = ANY(%s))::int AS open_count
            FROM incidents i
            {join}
            WHERE {where} AND {key} IS NOT NULL
            GROUP BY {group}
            ORDER BY count DESC, label
            LIMIT %s
            """,  # nosec B608 # identifiers below are module constants, never client input; every value is bound with %s
            [active, *params, limit],
        )

    return {
        "buildings": top(
            "JOIN buildings b ON b.id = i.building_id",
            "b.id",
            "b.name",
            "b.id, b.name",
        ),
        "floors": top(
            "JOIN floors f ON f.id = i.floor_id JOIN buildings b ON b.id = f.building_id",
            "f.id",
            "CONCAT(b.name, ' - Level ', f.level)",
            "f.id, b.name, f.level",
        ),
        "seats": top(
            "JOIN seats s ON s.id = i.seat_id JOIN floors f ON f.id = s.floor_id "
            "JOIN buildings b ON b.id = f.building_id",
            "s.id",
            "CONCAT(b.name, ' - Level ', f.level, ' - ', s.code)",
            "s.id, b.name, f.level, s.code",
        ),
    }


# GET /dashboard/sla
# Request:  header `Authorization: Bearer <token>`, no body.
#   Averages are in hours and are null until there is data to average.
# Response 200:
#   {"acknowledged_hours_avg": 1.8, "assigned_hours_avg": 2.4,
#    "resolved_hours_avg": 26.5, "closed_hours_avg": 31.2,
#    "resolved_count": 88, "sample_size": 137}
@router.get("/sla", response_model=DashboardSla, summary="Acknowledge / assign / resolve timings")
async def sla(user: dict[str, Any] = _ANY_USER) -> dict[str, Any]:
    """
    Report how quickly incidents are acknowledged, assigned, resolved and closed.

    Args:
        user: The authenticated caller; determines the scope of the averages.

    Returns:
        dict: Average durations in hours plus the sample sizes behind them.
    """
    where, params = visibility_clause(user)
    row = fetch_one(
        f"""
        SELECT
            AVG(EXTRACT(EPOCH FROM (i.acknowledged_at - i.created_at)) / 3600.0) AS acknowledged_hours_avg,
            AVG(EXTRACT(EPOCH FROM (i.assigned_at     - i.created_at)) / 3600.0) AS assigned_hours_avg,
            AVG(EXTRACT(EPOCH FROM (i.resolved_at     - i.created_at)) / 3600.0) AS resolved_hours_avg,
            AVG(EXTRACT(EPOCH FROM (i.closed_at       - i.created_at)) / 3600.0) AS closed_hours_avg,
            COUNT(*) FILTER (WHERE i.resolved_at IS NOT NULL)::int AS resolved_count,
            COUNT(*)::int AS sample_size
        FROM incidents i
        WHERE {where}
        """,  # nosec B608 # identifiers below are module constants, never client input; every value is bound with %s
        params,
    ) or {}

    def hours(key: str) -> float | None:
        """Round an average to two decimals, preserving NULL as None."""
        value = row.get(key)
        return None if value is None else round(float(value), 2)

    return {
        "acknowledged_hours_avg": hours("acknowledged_hours_avg"),
        "assigned_hours_avg": hours("assigned_hours_avg"),
        "resolved_hours_avg": hours("resolved_hours_avg"),
        "closed_hours_avg": hours("closed_hours_avg"),
        "resolved_count": row.get("resolved_count", 0),
        "sample_size": row.get("sample_size", 0),
    }


# GET /dashboard/engineers
# Request:  header `Authorization: Bearer <admin token>`, no body.
# Response 200:
#   [{"engineer_id": 3, "full_name": "Sam Okafor", "email": "sam@acme.inc",
#     "is_available": true, "max_active_incidents": 10, "active": 4,
#     "resolved": 21, "closed": 18, "escalated": 2}]
# Response 403: forbidden (caller is not a facility admin)
@router.get(
    "/engineers",
    response_model=list[EngineerWorkload],
    summary="Work distribution across engineers",
)
async def engineer_workload(_: dict[str, Any] = _ADMIN_ONLY) -> list[dict[str, Any]]:
    """
    Show how work is distributed across the engineering roster.

    Args:
        _: Authenticated facility admin (authorization only).

    Returns:
        list[dict]: One row per engineer, busiest first.
    """
    return fetch_all(
        """
        SELECT e.id AS engineer_id, u.full_name, u.email, e.is_available,
               e.max_active_incidents,
               COUNT(i.id) FILTER (WHERE i.status = ANY(%s))::int AS active,
               COUNT(i.id) FILTER (WHERE i.status = %s)::int AS resolved,
               COUNT(i.id) FILTER (WHERE i.status = %s)::int AS closed,
               COUNT(i.id) FILTER (WHERE i.is_escalated)::int AS escalated
        FROM engineer_profiles e
        JOIN users u ON u.id = e.user_id
        LEFT JOIN incidents i ON i.assignee_id = e.id
        GROUP BY e.id, u.full_name, u.email
        ORDER BY active DESC, u.full_name
        """,
        (list(ACTIVE_STATUSES), IncidentStatus.RESOLVED.value, IncidentStatus.CLOSED.value),
    )
