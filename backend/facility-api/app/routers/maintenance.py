"""
Maintenance analytics: which units are worth replacing rather than repairing.

Everything here is counting, deliberately. Predicting a failure date is a
survival-analysis problem, and this data cannot support one: there are no
service records, most units have never failed (so the informative cases are
exactly the censored ones), and the only failure signal is a human choosing to
file a ticket. A rule anyone can read off the screen - "four failures in ninety
days, against a median of one for its type" - is both defensible in front of
whoever signs the purchase order and honest about how little it assumes.

The figures are only as good as the share of incidents linked to an asset,
which is why ``/maintenance/summary`` reports that coverage first.

Location hotspots live on ``/dashboard/hotspots`` and are not duplicated here;
the maintenance screen calls that endpoint directly. They answer a different
question - where faults are reported - and one that is biased by how diligently
each floor reports.
"""

from typing import Any, Final, Optional

from fastapi import APIRouter, Depends, Query

from app.database import fetch_all, fetch_one
from app.domain import ACTIVE_STATUSES, Role
from app.models import AssetReviewPage, AssetTypeReliability, MaintenanceSummary
from app.routers.assets import service_state
from app.security import require_roles

router = APIRouter(prefix="/maintenance", tags=["maintenance"])

# Maintenance planning is staff work: employees have no use for it and their
# incident visibility is too narrow for the figures to mean anything.
_STAFF_ONLY = Depends(require_roles(Role.ENGINEER, Role.FACILITY_ADMIN))

# How far back "recent" reaches by default. A quarter is long enough to survive
# a quiet month and short enough that a unit fixed last year stops being news.
_DEFAULT_WINDOW_DAYS: Final[int] = 90

# Failures inside the window that make a unit worth looking at on their own.
_RECENT_FAILURE_LIMIT: Final[int] = 3

# How far above its type's median a unit must sit to be flagged for comparison
# alone. Two failures against a median of one is noise; four is a pattern.
_TYPE_FACTOR: Final[float] = 2.0
_TYPE_MINIMUM: Final[int] = 2

_REVIEW_SQL = """
WITH per_asset AS (
    SELECT a.id, a.code, a.name, a.asset_type, a.installed_on, a.expected_life_months,
           a.service_interval_months, a.last_serviced_on,
           (CASE
                WHEN a.service_interval_months IS NOT NULL
                THEN COALESCE(a.last_serviced_on, a.installed_on)
                     + make_interval(months => a.service_interval_months)
            END)::date AS next_service_due,
           b.name AS building_name, f.level AS floor_level, s.code AS seat_code,
           COUNT(i.id)::int AS incident_count,
           COUNT(i.id) FILTER (WHERE i.status = ANY(%(active)s))::int AS open_incident_count,
           COUNT(i.id) FILTER (
               WHERE i.created_at >= NOW() - make_interval(days => %(window)s)
           )::int AS recent_incident_count,
           MIN(i.created_at) AS first_incident_at,
           MAX(i.created_at) AS last_incident_at
    FROM assets a
    LEFT JOIN buildings b ON b.id = a.building_id
    LEFT JOIN floors f ON f.id = a.floor_id
    LEFT JOIN seats s ON s.id = a.seat_id
    LEFT JOIN incidents i ON i.asset_id = a.id
    WHERE a.retired_on IS NULL OR a.retired_on > CURRENT_DATE
    GROUP BY a.id, b.name, f.level, s.code, a.service_interval_months,
             a.last_serviced_on
),
-- The median rather than the mean: one catastrophic unit should not raise the
-- bar its neighbours are judged against.
type_median AS (
    SELECT asset_type,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY incident_count) AS median_incidents
    FROM per_asset
    GROUP BY asset_type
)
SELECT p.*,
       t.median_incidents,
       CASE
           WHEN p.incident_count >= 2 AND p.last_incident_at > p.first_incident_at
           THEN EXTRACT(EPOCH FROM (p.last_incident_at - p.first_incident_at))
                / 86400.0 / (p.incident_count - 1)
       END AS days_between_failures,
       CASE
           WHEN p.installed_on IS NOT NULL
           THEN EXTRACT(EPOCH FROM (NOW() - p.installed_on::timestamptz)) / 86400.0 / 365.25
       END AS age_years,
       (
           p.installed_on IS NOT NULL
           AND p.expected_life_months IS NOT NULL
           AND p.installed_on + make_interval(months => p.expected_life_months) <= CURRENT_DATE
       ) AS past_expected_life
FROM per_asset p
JOIN type_median t ON t.asset_type = p.asset_type
"""


def _label(row: dict[str, Any]) -> str:
    """
    Render an asset's position as one readable string.

    Args:
        row: A joined asset row.

    Returns:
        str: For example ``HQ North - Level 3 - 3A-12``, or ``Unplaced``.
    """
    parts = [row.get("building_name")]
    if row.get("floor_level") is not None:
        parts.append(f"Level {row['floor_level']}")
    parts.append(row.get("seat_code"))
    placed = [str(part) for part in parts if part]
    return " - ".join(placed) if placed else "Unplaced"


def _assess(row: dict[str, Any], window_days: int) -> dict[str, Any]:
    """
    Turn one asset's counts into a verdict and the reasons behind it.

    Every reason is a sentence a person can check against the numbers beside
    it, because this screen is used to argue for spending money.

    Args:
        row: A row from ``_REVIEW_SQL``.
        window_days: The recency window the counts were taken over.

    Returns:
        dict: The asset review record.
    """
    median = float(row["median_incidents"] or 0.0)
    reasons: list[str] = []

    if row["recent_incident_count"] >= _RECENT_FAILURE_LIMIT:
        reasons.append(
            f"{row['recent_incident_count']} failures in the last {window_days} days"
        )
    if row["incident_count"] >= _TYPE_MINIMUM and median > 0 and row["incident_count"] >= median * _TYPE_FACTOR:
        reasons.append(
            f"fails more often than others of its type ({row['incident_count']} against a median of {median:g})"
        )
    if row["past_expected_life"]:
        reasons.append("past its expected service life")

    status, days = service_state(row.get("next_service_due"))
    if status == "overdue":
        reasons.append(f"service overdue by {abs(days)} days")

    return {
        "id": row["id"],
        "code": row["code"],
        "name": row["name"],
        "asset_type": row["asset_type"],
        "location": _label(row),
        "installed_on": row["installed_on"],
        # EXTRACT(EPOCH ...) comes back as Decimal, which will not mix with
        # the floats these figures are averaged into further down.
        "age_years": round(float(row["age_years"]), 1) if row["age_years"] is not None else None,
        "incident_count": row["incident_count"],
        "open_incident_count": row["open_incident_count"],
        "recent_incident_count": row["recent_incident_count"],
        "last_incident_at": row["last_incident_at"],
        "days_between_failures": (
            round(float(row["days_between_failures"]), 1)
            if row["days_between_failures"] is not None
            else None
        ),
        "type_median_incidents": median,
        "next_service_due": row.get("next_service_due"),
        "service_status": status,
        "days_until_service": days,
        "needs_review": bool(reasons),
        "reasons": reasons,
    }


def _reviews(window_days: int) -> list[dict[str, Any]]:
    """
    Assess every unit still in service.

    Args:
        window_days: How far back "recent" reaches.

    Returns:
        list[dict]: Reviews, worst first.
    """
    rows = fetch_all(_REVIEW_SQL, {"active": list(ACTIVE_STATUSES), "window": window_days})
    reviews = [_assess(row, window_days) for row in rows]
    reviews.sort(
        key=lambda item: (
            item["service_status"] == "overdue",
            item["needs_review"],
            item["recent_incident_count"],
            item["incident_count"],
            item["open_incident_count"],
        ),
        reverse=True,
    )
    return reviews


# GET /maintenance/summary?window_days=90
# Request:  header `Authorization: Bearer <token>`, no body.
# Rules: engineers and facility admins only.
# Response 200:
#   {"assets_tracked": 24, "assets_retired": 2, "assets_needing_review": 3,
#    "assets_past_expected_life": 1, "incidents_total": 137,
#    "incidents_linked": 96, "linked_percent": 70.1}
# Response 403: forbidden
@router.get("/summary", response_model=MaintenanceSummary, summary="Maintenance headline figures")
async def summary(
    _: dict[str, Any] = _STAFF_ONLY,
    window_days: int = Query(default=_DEFAULT_WINDOW_DAYS, ge=7, le=730),
) -> dict[str, Any]:
    """
    Report register size, review count and how much of the incident record is
    actually attributed to equipment.

    Args:
        _: Authenticated engineer or facility admin.
        window_days: Recency window for the review rules.

    Returns:
        dict: The headline figures.
    """
    counts = fetch_one(
        """
        SELECT
            (SELECT COUNT(*) FROM assets
              WHERE retired_on IS NULL OR retired_on > CURRENT_DATE)::int AS assets_tracked,
            (SELECT COUNT(*) FROM assets
              WHERE retired_on IS NOT NULL AND retired_on <= CURRENT_DATE)::int AS assets_retired,
            (SELECT COUNT(*) FROM incidents)::int AS incidents_total,
            (SELECT COUNT(*) FROM incidents WHERE asset_id IS NOT NULL)::int AS incidents_linked
        """
    ) or {}

    reviews = _reviews(window_days)
    total = counts.get("incidents_total", 0)
    linked = counts.get("incidents_linked", 0)
    return {
        "assets_tracked": counts.get("assets_tracked", 0),
        "assets_retired": counts.get("assets_retired", 0),
        "assets_needing_review": sum(1 for item in reviews if item["needs_review"]),
        "assets_past_expected_life": sum(
            1 for item in reviews if "past its expected service life" in item["reasons"]
        ),
        "assets_service_overdue": sum(1 for item in reviews if item["service_status"] == "overdue"),
        "assets_service_due_soon": sum(1 for item in reviews if item["service_status"] == "due_soon"),
        # Not a failing of the units, but of the register: nothing can be
        # planned for a unit nobody has said how often to service.
        "assets_without_service_interval": sum(
            1 for item in reviews if item["service_status"] == "unknown"
        ),
        "incidents_total": total,
        "incidents_linked": linked,
        "linked_percent": round(linked * 100.0 / total, 1) if total else 0.0,
    }


# GET /maintenance/assets/review?window_days=90&limit=20&flagged_only=true
# Request:  header `Authorization: Bearer <token>`, no body.
# Rules: engineers and facility admins only.
# Response 200:
#   {"window_days": 90,
#    "items": [{"id": 4, "code": "AV-3A-PROJ-01", "name": "Ceiling projector...",
#               "asset_type": "PROJECTOR", "location": "HQ North - Level 3 - 3A-12",
#               "installed_on": "2021-03-14", "age_years": 5.5,
#               "incident_count": 4, "open_incident_count": 1,
#               "recent_incident_count": 3, "last_incident_at": "2026-09-22T10:00:00Z",
#               "days_between_failures": 61.2, "type_median_incidents": 1.0,
#               "needs_review": true,
#               "reasons": ["3 failures in the last 90 days", "past its expected service life"]}]}
# Response 403: forbidden
@router.get("/assets/review", response_model=AssetReviewPage, summary="Units to review")
async def assets_to_review(
    _: dict[str, Any] = _STAFF_ONLY,
    window_days: int = Query(default=_DEFAULT_WINDOW_DAYS, ge=7, le=730),
    limit: int = Query(default=20, ge=1, le=200),
    flagged_only: bool = Query(default=False, description="Only units the rules flagged"),
) -> dict[str, Any]:
    """
    Rank equipment for replacement, worst first, with the reasons shown.

    Args:
        _: Authenticated engineer or facility admin.
        window_days: How far back "recent" reaches.
        limit: Maximum rows returned.
        flagged_only: Drop units that no rule flagged.

    Returns:
        dict: The window used and the ranked units.
    """
    reviews = _reviews(window_days)
    if flagged_only:
        reviews = [item for item in reviews if item["needs_review"]]
    return {"window_days": window_days, "items": reviews[:limit]}


# GET /maintenance/types?window_days=90
# Request:  header `Authorization: Bearer <token>`, no body.
# Rules: engineers and facility admins only.
# Response 200:
#   [{"asset_type": "PROJECTOR", "asset_count": 6, "incident_count": 11,
#     "open_incident_count": 2, "incidents_per_asset": 1.8, "review_count": 2,
#     "avg_age_years": 4.1}]
# Response 403: forbidden
@router.get("/types", response_model=list[AssetTypeReliability], summary="Reliability by equipment class")
async def type_reliability(
    _: dict[str, Any] = _STAFF_ONLY,
    window_days: int = Query(default=_DEFAULT_WINDOW_DAYS, ge=7, le=730),
) -> list[dict[str, Any]]:
    """
    Aggregate failures by class of equipment, worst rate first.

    This is the figure that informs a purchasing decision rather than a
    replacement one: a class averaging two failures per unit is a bad buy, not
    a bad unit.

    Args:
        _: Authenticated engineer or facility admin.
        window_days: Recency window used for the review count.

    Returns:
        list[dict]: One row per equipment class.
    """
    grouped: dict[str, dict[str, Any]] = {}
    for item in _reviews(window_days):
        bucket = grouped.setdefault(
            item["asset_type"],
            {
                "asset_type": item["asset_type"],
                "asset_count": 0,
                "incident_count": 0,
                "open_incident_count": 0,
                "review_count": 0,
                "_age_total": 0.0,
                "_age_count": 0,
            },
        )
        bucket["asset_count"] += 1
        bucket["incident_count"] += item["incident_count"]
        bucket["open_incident_count"] += item["open_incident_count"]
        bucket["review_count"] += 1 if item["needs_review"] else 0
        if item["age_years"] is not None:
            bucket["_age_total"] += item["age_years"]
            bucket["_age_count"] += 1

    rows: list[dict[str, Any]] = []
    for bucket in grouped.values():
        age_count = bucket.pop("_age_count")
        age_total = bucket.pop("_age_total")
        bucket["incidents_per_asset"] = round(bucket["incident_count"] / bucket["asset_count"], 2)
        bucket["avg_age_years"] = round(age_total / age_count, 1) if age_count else None
        rows.append(bucket)

    rows.sort(key=lambda row: (row["incidents_per_asset"], row["incident_count"]), reverse=True)
    return rows
