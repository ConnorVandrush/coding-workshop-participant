"""
Pydantic request and response models.

Every router documents the concrete JSON shapes in a comment above the route;
these classes are the executable version of that documentation and drive both
validation and the generated OpenAPI schema at ``/docs``.
"""

import re
from datetime import datetime
from typing import Annotated, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.config import ALLOWED_EMAIL_DOMAIN
from app.domain import IncidentCategory, IncidentPriority, IncidentStatus, Role

_EMAIL_PATTERN = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")

NonEmptyStr = Annotated[str, Field(min_length=1, max_length=255)]
LongText = Annotated[str, Field(min_length=1, max_length=8000)]


class ApiModel(BaseModel):
    """Base model: rejects unknown fields so typos fail loudly at the edge."""

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


# --------------------------------------------------------------------------
# Authentication
# --------------------------------------------------------------------------
class RegisterRequest(ApiModel):
    """Self-service registration payload."""

    email: NonEmptyStr
    full_name: NonEmptyStr
    password: Annotated[str, Field(min_length=8, max_length=128)]

    @field_validator("email")
    @classmethod
    def validate_corporate_email(cls, value: str) -> str:
        """
        Ensure the address is well formed and belongs to the ACME domain.

        Args:
            value: The submitted email address.

        Returns:
            str: The lower-cased address.

        Raises:
            ValueError: When the address is malformed or off-domain.
        """
        email = value.strip().lower()
        if not _EMAIL_PATTERN.match(email):
            raise ValueError("email is not a valid address")
        if not email.endswith(f"@{ALLOWED_EMAIL_DOMAIN}"):
            raise ValueError(f"email must belong to the @{ALLOWED_EMAIL_DOMAIN} domain")
        return email


class LoginRequest(ApiModel):
    """Credentials exchanged for a bearer token."""

    email: NonEmptyStr
    password: Annotated[str, Field(min_length=1, max_length=128)]

    @field_validator("email")
    @classmethod
    def normalise_email(cls, value: str) -> str:
        """Lower-case the address so logins are case-insensitive."""
        return value.strip().lower()


class TokenResponse(ApiModel):
    """
    An issued session.

    The access token is short-lived and is only a signature, so it cannot be
    revoked; the refresh token is the long-lived credential and lives in a
    table, so it can be.
    """

    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int
    user: "UserResponse"


class RefreshRequest(ApiModel):
    """Exchange a refresh token for a new session."""

    refresh_token: Annotated[str, Field(min_length=10, max_length=512)]


class UserResponse(ApiModel):
    """Public view of a user account; never includes the password hash."""

    id: int
    email: str
    full_name: str
    role: Role
    is_active: bool
    created_at: datetime


class UserRoleUpdate(ApiModel):
    """Facility-admin-only role change."""

    role: Role


class UserStatusUpdate(ApiModel):
    """Facility-admin-only activation toggle."""

    is_active: bool


# --------------------------------------------------------------------------
# Facilities: building -> floor -> seat
# --------------------------------------------------------------------------
class BuildingCreate(ApiModel):
    """New building."""

    name: NonEmptyStr
    address: Optional[Annotated[str, Field(max_length=500)]] = None


class BuildingUpdate(ApiModel):
    """Partial building update; omitted fields are left untouched."""

    name: Optional[NonEmptyStr] = None
    address: Optional[Annotated[str, Field(max_length=500)]] = None


class BuildingResponse(ApiModel):
    """Building record, with child counts for the facilities screen."""

    id: int
    name: str
    address: Optional[str] = None
    floor_count: int = 0
    created_at: datetime


class FloorCreate(ApiModel):
    """New floor inside a building."""

    level: Annotated[int, Field(ge=-10, le=200)]
    name: Optional[NonEmptyStr] = None


class FloorUpdate(ApiModel):
    """Partial floor update."""

    level: Optional[Annotated[int, Field(ge=-10, le=200)]] = None
    name: Optional[NonEmptyStr] = None


class FloorResponse(ApiModel):
    """Floor record with its parent building and seat count."""

    id: int
    building_id: int
    building_name: Optional[str] = None
    level: int
    name: Optional[str] = None
    seat_count: int = 0
    created_at: datetime


class SeatCreate(ApiModel):
    """New seat on a floor."""

    code: NonEmptyStr
    description: Optional[Annotated[str, Field(max_length=500)]] = None


class SeatUpdate(ApiModel):
    """Partial seat update."""

    code: Optional[NonEmptyStr] = None
    description: Optional[Annotated[str, Field(max_length=500)]] = None


class SeatResponse(ApiModel):
    """Seat record, denormalised with floor and building for display."""

    id: int
    floor_id: int
    building_id: Optional[int] = None
    building_name: Optional[str] = None
    floor_level: Optional[int] = None
    code: str
    description: Optional[str] = None
    created_at: datetime


# --------------------------------------------------------------------------
# Engineers
# --------------------------------------------------------------------------
class EngineerCreate(ApiModel):
    """
    Promote an existing user account to engineer and create its profile.

    The user must already have registered; this keeps password handling in the
    single registration path.
    """

    user_id: int
    specialties: list[NonEmptyStr] = Field(default_factory=list, max_length=20)
    phone: Optional[Annotated[str, Field(max_length=50)]] = None
    is_available: bool = True
    max_active_incidents: Annotated[int, Field(ge=1, le=100)] = 10


class EngineerUpdate(ApiModel):
    """Partial engineer-profile update."""

    specialties: Optional[list[NonEmptyStr]] = Field(default=None, max_length=20)
    phone: Optional[Annotated[str, Field(max_length=50)]] = None
    is_available: Optional[bool] = None
    max_active_incidents: Optional[Annotated[int, Field(ge=1, le=100)]] = None


class EngineerResponse(ApiModel):
    """Engineer profile joined with the owning user account and live workload."""

    id: int
    user_id: int
    email: str
    full_name: str
    specialties: list[str]
    phone: Optional[str] = None
    is_available: bool
    max_active_incidents: int
    active_incidents: int = 0
    has_capacity: bool = True
    created_at: datetime


# --------------------------------------------------------------------------
# Incidents
# --------------------------------------------------------------------------
class IncidentCreate(ApiModel):
    """Incident reported by an employee."""

    title: NonEmptyStr
    description: LongText
    category: IncidentCategory
    priority: IncidentPriority = IncidentPriority.MEDIUM
    building_id: Optional[int] = None
    floor_id: Optional[int] = None
    seat_id: Optional[int] = None


class IncidentUpdate(ApiModel):
    """
    Partial incident update.

    Reporters may correct the descriptive fields while the incident is still
    OPEN; engineers and facility admins may also change ``priority``.
    """

    title: Optional[NonEmptyStr] = None
    description: Optional[LongText] = None
    category: Optional[IncidentCategory] = None
    priority: Optional[IncidentPriority] = None
    building_id: Optional[int] = None
    floor_id: Optional[int] = None
    seat_id: Optional[int] = None


class IncidentAssign(ApiModel):
    """Assign (``engineer_id``) or unassign (``null``) an incident."""

    engineer_id: Optional[int] = None
    note: Optional[Annotated[str, Field(max_length=2000)]] = None


class IncidentStatusChange(ApiModel):
    """
    Drive the workflow.

    ``reason`` is mandatory for BLOCKED and ``resolution`` for RESOLVED, so that
    the ticket history always explains itself.
    """

    status: IncidentStatus
    reason: Optional[Annotated[str, Field(max_length=2000)]] = None
    resolution: Optional[Annotated[str, Field(max_length=2000)]] = None


class IncidentEscalation(ApiModel):
    """Raise or clear an escalation flag, optionally bumping the priority."""

    is_escalated: bool = True
    reason: Optional[Annotated[str, Field(max_length=2000)]] = None
    priority: Optional[IncidentPriority] = None


class IncidentLocation(ApiModel):
    """Denormalised location block returned with each incident."""

    building_id: Optional[int] = None
    building_name: Optional[str] = None
    floor_id: Optional[int] = None
    floor_level: Optional[int] = None
    seat_id: Optional[int] = None
    seat_code: Optional[str] = None


class IncidentPerson(ApiModel):
    """Compact person reference embedded in incident payloads."""

    id: int
    user_id: Optional[int] = None
    full_name: str
    email: str


class IncidentResponse(ApiModel):
    """Full incident record as returned by every incident endpoint."""

    id: int
    title: str
    description: str
    category: IncidentCategory
    priority: IncidentPriority
    status: IncidentStatus
    is_escalated: bool
    escalation_note: Optional[str] = None
    blocked_reason: Optional[str] = None
    resolution: Optional[str] = None
    reporter: IncidentPerson
    assignee: Optional[IncidentPerson] = None
    location: IncidentLocation
    note_count: int = 0
    allowed_transitions: list[IncidentStatus] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime
    acknowledged_at: Optional[datetime] = None
    assigned_at: Optional[datetime] = None
    resolved_at: Optional[datetime] = None
    closed_at: Optional[datetime] = None


class IncidentPage(ApiModel):
    """Paginated incident list."""

    items: list[IncidentResponse]
    total: int
    limit: int
    offset: int


class DuplicateCheck(ApiModel):
    """Draft incident text to look for existing reports of the same problem."""

    title: NonEmptyStr
    description: Optional[Annotated[str, Field(max_length=8000)]] = None
    category: Optional[IncidentCategory] = None
    building_id: Optional[int] = None
    floor_id: Optional[int] = None
    seat_id: Optional[int] = None


class SimilarIncident(ApiModel):
    """
    One candidate duplicate.

    Narrower than :class:`IncidentResponse` on purpose - see
    ``app/duplicates.py::_serialise_match`` for why the description and
    reporter are withheld.
    """

    id: int
    title: str
    category: IncidentCategory
    priority: IncidentPriority
    status: IncidentStatus
    location: IncidentLocation
    created_at: datetime
    score: float
    reasons: list[str] = Field(default_factory=list)
    visible: bool


class SimilarIncidents(ApiModel):
    """Ranked duplicate candidates, best first."""

    matches: list[SimilarIncident]


class NoteCreate(ApiModel):
    """
    A comment on an incident.

    ``is_internal`` notes are visible to engineers and facility admins only;
    employees never see them, which keeps triage chatter out of the reporter's
    view without a second table.
    """

    body: LongText
    is_internal: bool = False


class NoteResponse(ApiModel):
    """Incident note with its author."""

    id: int
    incident_id: int
    author: IncidentPerson
    body: str
    is_internal: bool
    created_at: datetime


# --------------------------------------------------------------------------
# Notifications
# --------------------------------------------------------------------------
class NotificationResponse(ApiModel):
    """One entry in a person's notification feed."""

    id: int
    incident_id: Optional[int] = None
    event: str
    body: str
    is_read: bool
    created_at: datetime


class NotificationSummary(ApiModel):
    """The feed plus the unread count, so a badge needs only one request."""

    unread: int
    items: list[NotificationResponse]


# --------------------------------------------------------------------------
# Dashboard
# --------------------------------------------------------------------------
class CountBucket(ApiModel):
    """A single ``{key, count}`` pair used throughout the dashboard."""

    key: str
    count: int


class DashboardSummary(ApiModel):
    """Headline counters scoped to the caller's role."""

    scope: Role
    total: int
    open_total: int
    escalated_total: int
    unassigned_total: int
    by_status: list[CountBucket]
    by_priority: list[CountBucket]
    by_category: list[CountBucket]


class HotspotBucket(ApiModel):
    """Recurring-issue hotspot for a building, floor or seat."""

    id: Optional[int] = None
    label: str
    count: int
    open_count: int


class DashboardHotspots(ApiModel):
    """Top locations by incident volume."""

    buildings: list[HotspotBucket]
    floors: list[HotspotBucket]
    seats: list[HotspotBucket]


class DashboardSla(ApiModel):
    """Average workflow durations in hours; ``null`` when there is no data yet."""

    acknowledged_hours_avg: Optional[float] = None
    assigned_hours_avg: Optional[float] = None
    resolved_hours_avg: Optional[float] = None
    closed_hours_avg: Optional[float] = None
    resolved_count: int = 0
    sample_size: int = 0


class EngineerWorkload(ApiModel):
    """Per-engineer distribution of work."""

    engineer_id: int
    full_name: str
    email: str
    is_available: bool
    max_active_incidents: int
    active: int
    resolved: int
    closed: int
    escalated: int


class ErrorResponse(ApiModel):
    """
    Consistent error envelope returned by every failing request.

    Example::

        {"error": {"status": 404, "type": "not_found",
                   "message": "Incident 42 was not found", "details": null}}
    """

    error: dict


TokenResponse.model_rebuild()
