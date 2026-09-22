"""
Runtime configuration, sourced entirely from the environment variables that
Terraform injects into the Lambda (see `infra/locals.tf` -> `local.env_vars`).

Nothing here is workshop-participant specific: the same module works unchanged
against LocalStack (``IS_LOCAL=true``) and AWS Aurora (``IS_LOCAL=false``).
"""

import hashlib
import os
from typing import Final

# --- Service identity ------------------------------------------------------
# The folder name under `backend/` becomes the Lambda name and the CloudFront
# path pattern `/api/facility-api*` (see `infra/cloudfront.tf`). Keep the two in
# sync if the folder is ever renamed.
SERVICE_NAME: Final[str] = os.getenv("SERVICE_NAME", "facility-api")
SERVICE_PREFIX: Final[str] = f"/api/{SERVICE_NAME}"

APP_ID: Final[str] = os.getenv("APP_ID", "local")
APP_NAME: Final[str] = os.getenv("APP_NAME", "coding-workshop-local")
APP_REGION: Final[str] = os.getenv("APP_REGION", "us-east-1")
IS_LOCAL: Final[bool] = os.getenv("IS_LOCAL", "false").lower() == "true"

# --- PostgreSQL ------------------------------------------------------------
POSTGRES_HOST: Final[str] = os.getenv("POSTGRES_HOST", "localhost")
POSTGRES_PORT: Final[str] = os.getenv("POSTGRES_PORT", "5432")
POSTGRES_NAME: Final[str] = os.getenv("POSTGRES_NAME", "postgres")
POSTGRES_USER: Final[str] = os.getenv("POSTGRES_USER", "postgres")
POSTGRES_PASS: Final[str] = os.getenv("POSTGRES_PASS", "")

# Aurora requires TLS; the LocalStack/dev PostgreSQL does not run with it.
_SSL_MODE: Final[str] = "prefer" if IS_LOCAL else "require"

POSTGRES_DSN: Final[str] = " ".join(
    [
        f"host={POSTGRES_HOST}",
        f"port={POSTGRES_PORT}",
        f"dbname={POSTGRES_NAME}",
        f"user={POSTGRES_USER}",
        f"password={POSTGRES_PASS}",
        f"sslmode={_SSL_MODE}",
        "connect_timeout=15",
        f"application_name={SERVICE_NAME}",
    ]
)

# --- Authentication --------------------------------------------------------
# Only ACME staff may register; the check is enforced in `app/models.py`.
ALLOWED_EMAIL_DOMAIN: Final[str] = os.getenv("ALLOWED_EMAIL_DOMAIN", "acme.inc")

JWT_ALGORITHM: Final[str] = "HS256"
ACCESS_TOKEN_TTL_MINUTES: Final[int] = int(os.getenv("ACCESS_TOKEN_TTL_MINUTES", "720"))


def _derive_signing_key() -> str:
    """
    Return the HMAC key used to sign access tokens.

    Prefers an explicit ``JWT_SECRET`` environment variable. When it is absent
    (the default for this workshop, where Terraform injects no such variable)
    the key is derived deterministically from per-deployment values so that every
    warm and cold Lambda container in the same deployment agrees on it, while two
    different deployments never share a key. Set ``JWT_SECRET`` in
    `infra/locals.tf` before using this outside the workshop.

    Returns:
        str: A hex-encoded 256-bit signing key.
    """
    configured = os.getenv("JWT_SECRET", "").strip()
    if configured:
        return configured

    seed = "|".join([os.getenv("APP_ROLE", ""), APP_NAME, APP_ID, POSTGRES_PASS])
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()


JWT_SIGNING_KEY: Final[str] = _derive_signing_key()

# --- Password hashing ------------------------------------------------------
# PBKDF2-HMAC-SHA256 from the standard library keeps the Lambda package free of
# native crypto wheels (the Terraform module builds without Docker).
PBKDF2_ITERATIONS: Final[int] = int(os.getenv("PBKDF2_ITERATIONS", "240000"))
PBKDF2_SALT_BYTES: Final[int] = 16
