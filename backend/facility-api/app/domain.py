"""
Domain vocabulary and the incident workflow state machine.

Keeping the transition table in one place lets the API enforce it, the
`/workflow` endpoint publish it, and the React frontend draw it without
duplicating the rules.
"""

from enum import StrEnum
from typing import Final


class Role(StrEnum):
    """The three personas described in the workshop brief."""

    EMPLOYEE = "employee"
    ENGINEER = "engineer"
    FACILITY_ADMIN = "facility_admin"


class IncidentStatus(StrEnum):
    """Lifecycle states of an incident."""

    OPEN = "OPEN"
    IN_PROGRESS = "IN_PROGRESS"
    BLOCKED = "BLOCKED"
    RESOLVED = "RESOLVED"
    CLOSED = "CLOSED"


class IncidentPriority(StrEnum):
    """Urgency assigned by the reporter and refined by staff."""

    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    CRITICAL = "CRITICAL"


class IncidentCategory(StrEnum):
    """Facility and workplace-technology issue taxonomy."""

    HVAC = "HVAC"
    ELECTRICAL = "ELECTRICAL"
    PLUMBING = "PLUMBING"
    FURNITURE = "FURNITURE"
    CLEANING = "CLEANING"
    SECURITY = "SECURITY"
    NETWORK = "NETWORK"
    HARDWARE = "HARDWARE"
    SOFTWARE = "SOFTWARE"
    AV_EQUIPMENT = "AV_EQUIPMENT"
    OTHER = "OTHER"


# Allowed status transitions. Anything not listed here is rejected with 409.
TRANSITIONS: Final[dict[IncidentStatus, tuple[IncidentStatus, ...]]] = {
    IncidentStatus.OPEN: (IncidentStatus.IN_PROGRESS, IncidentStatus.BLOCKED, IncidentStatus.RESOLVED),
    IncidentStatus.IN_PROGRESS: (IncidentStatus.BLOCKED, IncidentStatus.RESOLVED, IncidentStatus.OPEN),
    IncidentStatus.BLOCKED: (IncidentStatus.IN_PROGRESS, IncidentStatus.OPEN, IncidentStatus.RESOLVED),
    IncidentStatus.RESOLVED: (IncidentStatus.CLOSED, IncidentStatus.IN_PROGRESS),
    IncidentStatus.CLOSED: (IncidentStatus.OPEN,),
}

# Who may drive each transition, on top of the ownership checks in the router.
# A reporter may close their own resolved incident or reopen it; everything else
# belongs to the assigned engineer or a facility admin.
REPORTER_TRANSITIONS: Final[tuple[tuple[IncidentStatus, IncidentStatus], ...]] = (
    (IncidentStatus.RESOLVED, IncidentStatus.CLOSED),
    (IncidentStatus.RESOLVED, IncidentStatus.IN_PROGRESS),
)

# Statuses that still consume engineer capacity, used for workload reporting.
ACTIVE_STATUSES: Final[tuple[str, ...]] = (
    IncidentStatus.OPEN,
    IncidentStatus.IN_PROGRESS,
    IncidentStatus.BLOCKED,
)


def can_transition(current: str, target: str) -> bool:
    """
    Report whether a status change is allowed by the workflow.

    Args:
        current: The incident's present status.
        target: The requested status.

    Returns:
        bool: True when the transition is legal.
    """
    try:
        allowed = TRANSITIONS[IncidentStatus(current)]
    except (KeyError, ValueError):
        return False
    return IncidentStatus(target) in allowed


def workflow_graph() -> dict[str, object]:
    """
    Describe the workflow in a shape a UI can render directly.

    Returns:
        dict: ``{"statuses": [...], "transitions": [{"from": ..., "to": ...}]}``.
    """
    return {
        "statuses": [
            {"id": status.value, "label": status.value.replace("_", " ").title(), "is_terminal": status is IncidentStatus.CLOSED}
            for status in IncidentStatus
        ],
        "transitions": [
            {"from": source.value, "to": target.value}
            for source, targets in TRANSITIONS.items()
            for target in targets
        ],
    }
