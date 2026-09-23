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
    REFRESH_TOKEN_TTL_DAYS,
    JWT_ALGORITHM,
    JWT_SIGNING_KEY,
    PBKDF2_ITERATIONS,
    PBKDF2_SALT_BYTES,
)
from app.database import cursor, fetch_one
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


# --------------------------------------------------------------------------
# Refresh tokens
# --------------------------------------------------------------------------
def _digest(token: str) -> str:
    """
    Hash a refresh token for storage.

    A plain SHA-256 is enough here, unlike for passwords: the token is 256 bits
    of randomness we generated, so there is nothing to brute-force and no need
    for a slow KDF.

    Args:
        token: The raw refresh token.

    Returns:
        str: Hex-encoded digest.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def issue_refresh_token(user_id: int, replaces: Optional[int] = None) -> str:
    """
    Create a refresh token for a user and store only its digest.

    Args:
        user_id: The account the token belongs to.
        replaces: The row this token supersedes, when rotating.

    Returns:
        str: The raw token. This is the only time it exists in plaintext.
    """
    raw = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_TTL_DAYS)
    with cursor() as cur:
        cur.execute(
            """
            INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
            VALUES (%s, %s, %s)
            RETURNING id
            """,
            (user_id, _digest(raw), expires),
        )
        created = cur.fetchone()
        if replaces is not None:
            cur.execute(
                "UPDATE refresh_tokens SET revoked_at = NOW(), replaced_by = %s WHERE id = %s",
                (created["id"], replaces),
            )
    return raw


def revoke_all_for_user(user_id: int) -> int:
    """
    Revoke every live refresh token for an account.

    Args:
        user_id: The account to lock out.

    Returns:
        int: How many tokens were revoked.
    """
    with cursor() as cur:
        cur.execute(
            "UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = %s AND revoked_at IS NULL",
            (user_id,),
        )
        return cur.rowcount


def revoke_refresh_token(token: str) -> bool:
    """
    Revoke a single refresh token, used at sign-out.

    Args:
        token: The raw refresh token.

    Returns:
        bool: True when a live token was revoked.
    """
    with cursor() as cur:
        cur.execute(
            "UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = %s AND revoked_at IS NULL",
            (_digest(token),),
        )
        return cur.rowcount > 0


def rotate_refresh_token(token: str) -> tuple[dict[str, Any], str]:
    """
    Exchange a refresh token for a new one, returning its owner.

    Rotation is what makes theft detectable. A token is valid once; presenting
    one that has already been spent means two parties hold it, so every token
    for that account is revoked and the session ends everywhere. The legitimate
    user signs in again, which is the correct outcome when a credential has
    leaked.

    Args:
        token: The raw refresh token.

    Returns:
        tuple[dict, str]: The user row and a freshly issued refresh token.

    Raises:
        ApiError: 401 when the token is unknown, expired, or already spent.
    """
    row = fetch_one(
        """
        SELECT r.id, r.user_id, r.revoked_at, r.expires_at,
               u.id AS uid, u.email, u.full_name, u.role, u.is_active, u.created_at
        FROM refresh_tokens r
        JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = %s
        """,
        (_digest(token),),
    )
    if row is None:
        raise ApiError(401, "invalid_token", "Refresh token is not recognised")

    if row["revoked_at"] is not None:
        # Already spent. Either a replay or a stolen copy; either way, end the
        # whole session rather than guess which.
        revoked = revoke_all_for_user(row["user_id"])
        logger.warning(
            "Refresh token reuse detected for user %s; revoked %s token(s)", row["user_id"], revoked
        )
        raise ApiError(401, "token_reused", "This session has been ended for security reasons")

    if row["expires_at"] <= datetime.now(timezone.utc):
        raise ApiError(401, "token_expired", "Refresh token has expired; please sign in again")

    if not row["is_active"]:
        raise ApiError(403, "account_disabled", "Account has been deactivated")

    user = {k: row[k] for k in ("email", "full_name", "role", "is_active", "created_at")}
    user["id"] = row["uid"]
    return user, issue_refresh_token(row["user_id"], replaces=row["id"])
