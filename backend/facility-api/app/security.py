"""
Authentication (who you are) and authorization (what you may do).

Passwords are stored as PBKDF2-HMAC-SHA256 digests and sessions are stateless
JWT bearer tokens, so nothing needs to be shared between Lambda containers.
"""

import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

import jwt
from fastapi import Depends, Request

from app.config import (
    ACCESS_TOKEN_TTL_MINUTES,
    JWT_ALGORITHM,
    JWT_SIGNING_KEY,
    PBKDF2_ITERATIONS,
    PBKDF2_SALT_BYTES,
)
from app.database import fetch_one
from app.domain import Role
from app.errors import ApiError

logger = logging.getLogger(__name__)

_HASH_FORMAT = "pbkdf2_sha256"


def hash_password(password: str) -> str:
    """
    Derive a storable digest from a plaintext password.

    Args:
        password: The plaintext password.

    Returns:
        str: ``pbkdf2_sha256$<iterations>$<salt-hex>$<digest-hex>``.
    """
    salt = secrets.token_bytes(PBKDF2_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)
    return f"{_HASH_FORMAT}${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """
    Check a plaintext password against a stored digest in constant time.

    Args:
        password: The plaintext password supplied at login.
        stored: The digest produced by :func:`hash_password`.

    Returns:
        bool: True when the password matches.
    """
    try:
        algorithm, iterations, salt_hex, digest_hex = stored.split("$", 3)
        if algorithm != _HASH_FORMAT:
            return False
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iterations)
        )
    except (ValueError, TypeError):
        logger.warning("Malformed password hash encountered")
        return False
    return hmac.compare_digest(candidate.hex(), digest_hex)


def create_access_token(user: dict[str, Any]) -> tuple[str, int]:
    """
    Mint a signed access token for a user row.

    Args:
        user: A row from the ``users`` table.

    Returns:
        tuple[str, int]: The encoded token and its lifetime in seconds.
    """
    ttl = timedelta(minutes=ACCESS_TOKEN_TTL_MINUTES)
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user["id"]),
        "email": user["email"],
        "role": user["role"],
        "iat": int(now.timestamp()),
        "exp": int((now + ttl).timestamp()),
    }
    token = jwt.encode(payload, JWT_SIGNING_KEY, algorithm=JWT_ALGORITHM)
    return token, int(ttl.total_seconds())


def _decode_token(token: str) -> dict[str, Any]:
    """
    Verify and decode a bearer token.

    Args:
        token: The raw JWT.

    Returns:
        dict: The token claims.

    Raises:
        ApiError: 401 when the token is expired or otherwise invalid.
    """
    try:
        return jwt.decode(token, JWT_SIGNING_KEY, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError as exc:
        raise ApiError(401, "token_expired", "Access token has expired; please sign in again") from exc
    except jwt.PyJWTError as exc:
        raise ApiError(401, "invalid_token", "Access token is invalid") from exc


def get_current_user(request: Request) -> dict[str, Any]:
    """
    FastAPI dependency resolving the caller from the ``Authorization`` header.

    Args:
        request: The incoming request.

    Returns:
        dict: The authenticated ``users`` row.

    Raises:
        ApiError: 401 when the header is missing/invalid or the account is gone
            or deactivated.
    """
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise ApiError(401, "not_authenticated", "Authorization header must be 'Bearer <token>'")

    claims = _decode_token(token.strip())
    user = fetch_one(
        "SELECT id, email, full_name, role, is_active, created_at FROM users WHERE id = %s",
        (int(claims["sub"]),),
    )
    if user is None:
        raise ApiError(401, "invalid_token", "Account no longer exists")
    if not user["is_active"]:
        raise ApiError(403, "account_disabled", "Account has been deactivated")
    return user


def require_roles(*roles: Role) -> Callable[..., dict[str, Any]]:
    """
    Build a dependency that admits only the listed roles.

    Args:
        *roles: Roles allowed to call the endpoint.

    Returns:
        Callable: A FastAPI dependency returning the authenticated user.

    Example::

        @router.post("", dependencies=[Depends(require_roles(Role.FACILITY_ADMIN))])
    """
    allowed = {role.value for role in roles}

    def dependency(user: dict[str, Any] = Depends(get_current_user)) -> dict[str, Any]:
        if user["role"] not in allowed:
            raise ApiError(
                403,
                "forbidden",
                "Your role is not permitted to perform this action",
                {"required_roles": sorted(allowed), "your_role": user["role"]},
            )
        return user

    return dependency


def is_admin(user: dict[str, Any]) -> bool:
    """Return True when the user is a facility admin."""
    return user["role"] == Role.FACILITY_ADMIN


def engineer_profile_id(user: dict[str, Any]) -> Optional[int]:
    """
    Look up the engineer-profile id owned by a user.

    Args:
        user: An authenticated ``users`` row.

    Returns:
        int | None: The ``engineer_profiles.id``, or None when the user is not
        an engineer or has no profile yet.
    """
    if user["role"] != Role.ENGINEER:
        return None
    row = fetch_one("SELECT id FROM engineer_profiles WHERE user_id = %s", (user["id"],))
    return row["id"] if row else None
