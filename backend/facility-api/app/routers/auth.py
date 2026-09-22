"""
Registration, login and "who am I" endpoints.

Bootstrap rule: the very first account created in an empty database becomes a
``facility_admin`` so a fresh deployment is usable without seeding credentials
into the codebase. Every subsequent self-service registration is an
``employee``; admins promote users to ``engineer`` or ``facility_admin`` through
``PATCH /users/{id}/role``.
"""

from typing import Any

from fastapi import APIRouter, Depends, status

from app.config import ACCESS_TOKEN_TTL_MINUTES
from app.database import fetch_one
from app.domain import Role
from app.errors import ApiError
from app.models import LoginRequest, RegisterRequest, TokenResponse, UserResponse
from app.security import create_access_token, get_current_user, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])


# POST /auth/register
# Request body:
#   {"email": "dana@acme.inc", "full_name": "Dana Ruiz", "password": "s3cret-pass"}
#   - email must end in @acme.inc; password >= 8 characters.
# Response 201:
#   {"id": 7, "email": "dana@acme.inc", "full_name": "Dana Ruiz",
#    "role": "employee", "is_active": true, "created_at": "2026-09-22T10:00:00Z"}
# Response 400: validation_error (bad email domain, short password)
# Response 409: conflict (email already registered)
@router.post(
    "/register",
    response_model=UserResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new ACME employee",
)
async def register(payload: RegisterRequest) -> dict[str, Any]:
    """
    Create an account for an ``@acme.inc`` address.

    Args:
        payload: Email, full name and plaintext password.

    Returns:
        dict: The created user, without any credential material.

    Raises:
        ApiError: 409 when the email is already registered.
    """
    existing = fetch_one("SELECT id FROM users WHERE email = %s", (payload.email,))
    if existing is not None:
        raise ApiError(409, "conflict", "An account with that email already exists")

    # First account in an empty database bootstraps the facility admin.
    bootstrap = fetch_one("SELECT COUNT(*) AS total FROM users")
    role = Role.FACILITY_ADMIN if (bootstrap or {}).get("total", 0) == 0 else Role.EMPLOYEE

    created = fetch_one(
        """
        INSERT INTO users (email, full_name, password_hash, role)
        VALUES (%s, %s, %s, %s)
        RETURNING id, email, full_name, role, is_active, created_at
        """,
        (payload.email, payload.full_name, hash_password(payload.password), role.value),
    )
    if created is None:  # pragma: no cover - INSERT ... RETURNING always yields a row
        raise ApiError(500, "internal_error", "Account could not be created")
    return created


# POST /auth/login
# Request body:
#   {"email": "dana@acme.inc", "password": "s3cret-pass"}
# Response 200:
#   {"access_token": "eyJhbGci...", "token_type": "bearer", "expires_in": 43200,
#    "user": {"id": 7, "email": "dana@acme.inc", "full_name": "Dana Ruiz",
#             "role": "employee", "is_active": true,
#             "created_at": "2026-09-22T10:00:00Z"}}
# Response 401: invalid_credentials
# Response 403: account_disabled
@router.post("/login", response_model=TokenResponse, summary="Exchange credentials for a token")
async def login(payload: LoginRequest) -> dict[str, Any]:
    """
    Authenticate a user and issue a bearer token.

    Args:
        payload: Email and plaintext password.

    Returns:
        dict: The access token, its lifetime and the caller's profile.

    Raises:
        ApiError: 401 for unknown email or wrong password, 403 when disabled.
    """
    user = fetch_one(
        """
        SELECT id, email, full_name, password_hash, role, is_active, created_at
        FROM users WHERE email = %s
        """,
        (payload.email,),
    )
    # Same message for "no such user" and "wrong password" - do not leak which.
    if user is None or not verify_password(payload.password, user["password_hash"]):
        raise ApiError(401, "invalid_credentials", "Email or password is incorrect")
    if not user["is_active"]:
        raise ApiError(403, "account_disabled", "Account has been deactivated")

    token, expires_in = create_access_token(user)
    profile = {key: user[key] for key in ("id", "email", "full_name", "role", "is_active", "created_at")}
    return {
        "access_token": token,
        "token_type": "bearer",  # nosec B105 # an OAuth token type label, not a secret
        "expires_in": expires_in,
        "user": profile,
    }


# GET /auth/me
# Request:  header `Authorization: Bearer <token>`, no body.
# Response 200:
#   {"id": 7, "email": "dana@acme.inc", "full_name": "Dana Ruiz",
#    "role": "employee", "is_active": true, "created_at": "2026-09-22T10:00:00Z"}
# Response 401: not_authenticated | invalid_token | token_expired
@router.get("/me", response_model=UserResponse, summary="Current authenticated profile")
async def me(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
    """
    Return the profile behind the supplied bearer token.

    Args:
        user: Injected by the authentication dependency.

    Returns:
        dict: The caller's user record.
    """
    return user


# Exposed so the frontend can show a session-expiry countdown without decoding
# the token itself.
TOKEN_TTL_MINUTES = ACCESS_TOKEN_TTL_MINUTES
