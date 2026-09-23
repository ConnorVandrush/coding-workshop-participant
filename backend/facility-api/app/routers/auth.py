"""
Registration, login and "who am I" endpoints.

Bootstrap rule: the very first account created in an empty database becomes a
``facility_admin`` so a fresh deployment is usable without seeding credentials
into the codebase. Every subsequent self-service registration is an
``employee``; admins promote users to ``engineer`` or ``facility_admin`` through
``PATCH /users/{id}/role``.
"""

from typing import Any

from fastapi import APIRouter, Depends, Response, status

from app.config import ACCESS_TOKEN_TTL_MINUTES
from app.database import fetch_one
from app.domain import Role
from app.errors import ApiError
from app.models import LoginRequest, RefreshRequest, RegisterRequest, TokenResponse, UserResponse
from app.security import (
    create_access_token,
    get_current_user,
    hash_password,
    issue_refresh_token,
    revoke_all_for_user,
    revoke_refresh_token,
    rotate_refresh_token,
    verify_password,
)

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
        "refresh_token": issue_refresh_token(user["id"]),
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


# POST /auth/refresh
# Request body: {"refresh_token": "Xy9..."}
# Response 200: a fresh session, same shape as POST /auth/login. The refresh
#   token in the response replaces the one sent: each is valid exactly once.
# Response 401: invalid_token | token_expired | token_reused
# Response 403: account_disabled
@router.post("/refresh", response_model=TokenResponse, summary="Exchange a refresh token")
async def refresh(payload: RefreshRequest) -> dict[str, Any]:
    """
    Issue a new access token, rotating the refresh token that bought it.

    Rotation means every refresh token is valid exactly once. Presenting a
    spent one implies two parties hold it, so the whole session is revoked
    rather than guessing which party is legitimate.

    Args:
        payload: The refresh token to exchange.

    Returns:
        dict: A new access token, a new refresh token and the profile.

    Raises:
        ApiError: 401 when the token is unknown, expired or already spent;
            403 when the account has since been deactivated.
    """
    user, new_refresh = rotate_refresh_token(payload.refresh_token)
    token, expires_in = create_access_token(user)
    return {
        "access_token": token,
        "refresh_token": new_refresh,
        "token_type": "bearer",  # nosec B105 # an OAuth token type label, not a secret
        "expires_in": expires_in,
        "user": user,
    }


# POST /auth/logout
# Request body: {"refresh_token": "Xy9..."}
# Response 204: empty body. Always succeeds, so signing out never fails.
@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT, summary="End a session")
async def logout(payload: RefreshRequest) -> Response:
    """
    Revoke a refresh token so the session cannot be resumed.

    The access token is not revoked because it cannot be: it is a signature,
    checked without touching the database. It simply expires, which is why its
    lifetime is short.

    Args:
        payload: The refresh token to revoke.

    Returns:
        Response: An empty 204, whether or not the token was still live -
        signing out should not report failure.
    """
    revoke_refresh_token(payload.refresh_token)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# POST /auth/logout-everywhere
# Request:  header `Authorization: Bearer <token>`, no body.
# Response 200: {"revoked": 3}
@router.post("/logout-everywhere", summary="End every session for this account")
async def logout_everywhere(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, int]:
    """
    Revoke every refresh token for the caller, on every device.

    Args:
        user: The authenticated caller.

    Returns:
        dict: How many sessions were ended.
    """
    return {"revoked": revoke_all_for_user(user["id"])}
