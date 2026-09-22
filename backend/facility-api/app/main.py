"""
FastAPI application for the ACME facility incident management platform.

Route map (all paths are relative to the service root; behind CloudFront they
are additionally prefixed with ``/api/facility-api``):

    GET    /                       service metadata
    GET    /health                 liveness + database check
    GET    /workflow               incident state machine, for the UI diagram
    POST   /auth/register          self-service registration
    POST   /auth/login             exchange credentials for a bearer token
    GET    /auth/me                current profile
    GET    /users                  list accounts                (facility_admin)
    PATCH  /users/{id}/role        change a role                (facility_admin)
    PATCH  /users/{id}/status      activate / deactivate        (facility_admin)
    CRUD   /buildings, /buildings/{id}/floors, /floors/{id}/seats
    CRUD   /engineers
    CRUD   /incidents  + /assign, /status, /escalate, /notes
    GET    /dashboard/summary, /hotspots, /sla, /engineers

Error envelope (every non-2xx response)::

    {"error": {"status": 403, "type": "forbidden",
               "message": "...", "details": null}}
"""

import logging
import os
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import APP_ID, IS_LOCAL, SERVICE_NAME, SERVICE_PREFIX
from app.database import DatabaseUnavailable, ping
from app.domain import workflow_graph
from app.errors import ApiError
from app.middleware import ServicePrefixMiddleware
from app.routers import auth, dashboard, engineers, facilities, incidents, users

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)

API_VERSION = "1.0.0"

api = FastAPI(
    title="ACME Facility Incident Management API",
    description=(
        "Self-service reporting and tracking of facility and workplace "
        "technology incidents for ACME Inc."
    ),
    version=API_VERSION,
    docs_url="/docs",
    redoc_url="/redoc",
    openapi_url="/openapi.json",
)

# CORS is supplied by whatever is in front of this app, never by both layers:
#
#   * On AWS and LocalStack the Lambda Function URL adds the headers itself
#     (the `cors` block in `infra/lambda.tf`). Adding them here too produces a
#     duplicated `Access-Control-Allow-Origin: *, *`, which every browser
#     rejects as malformed - the API answers 200 and the fetch still fails.
#   * Under plain `uvicorn` (the `python function.py` dev path) nothing else
#     sets them, so the middleware is needed.
#
# AWS_LAMBDA_FUNCTION_NAME is set by the Lambda runtime and by LocalStack, which
# makes it an accurate test for "something in front of me already did this".
if not os.getenv("AWS_LAMBDA_FUNCTION_NAME"):
    api.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        max_age=600,
    )


# --------------------------------------------------------------------------
# Error handling: one envelope for every failure mode.
# --------------------------------------------------------------------------
@api.exception_handler(ApiError)
async def handle_api_error(_: Request, exc: ApiError) -> JSONResponse:
    """Render an explicitly raised :class:`ApiError`."""
    if exc.status_code >= 500:
        logger.error("API error %s: %s", exc.error_type, exc.message)
    return JSONResponse(status_code=exc.status_code, content=exc.to_payload())


@api.exception_handler(RequestValidationError)
async def handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    """
    Convert FastAPI's 422 body into the shared 400 envelope.

    Response::

        {"error": {"status": 400, "type": "validation_error",
                   "message": "Request payload failed validation",
                   "details": [{"field": "body.email", "message": "..."}]}}
    """
    details = [
        {
            "field": ".".join(str(part) for part in error.get("loc", ())),
            "message": error.get("msg", "invalid value"),
        }
        for error in exc.errors()
    ]
    error = ApiError(400, "validation_error", "Request payload failed validation", details)
    return JSONResponse(status_code=400, content=error.to_payload())


@api.exception_handler(StarletteHTTPException)
async def handle_http_exception(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    """Wrap framework-raised HTTP errors (404 routing, 405 method) in the envelope."""
    error = ApiError(exc.status_code, "http_error", str(exc.detail))
    return JSONResponse(status_code=exc.status_code, content=error.to_payload())


@api.exception_handler(DatabaseUnavailable)
async def handle_database_unavailable(_: Request, exc: DatabaseUnavailable) -> JSONResponse:
    """Report a database outage as 503 without leaking connection details."""
    logger.error("Database unavailable: %s", exc)
    error = ApiError(503, "database_unavailable", "The database is temporarily unavailable")
    return JSONResponse(status_code=503, content=error.to_payload())


@api.exception_handler(Exception)
async def handle_unexpected_error(_: Request, exc: Exception) -> JSONResponse:
    """Last-resort handler so clients never receive an unstructured stack trace."""
    logger.exception("Unhandled error: %s", exc)
    error = ApiError(500, "internal_error", "An unexpected error occurred")
    return JSONResponse(status_code=500, content=error.to_payload())


# --------------------------------------------------------------------------
# Service-level routes
# --------------------------------------------------------------------------
# GET /
# Request:  no body, no authentication.
# Response 200:
#   {"service": "facility-api", "version": "1.0.0", "app_id": "0922f9b2",
#    "environment": "aws", "docs": "/api/facility-api/docs"}
@api.get("/", tags=["service"], summary="Service metadata")
async def service_info() -> dict[str, Any]:
    """
    Return basic service identity, useful as a smoke test after deployment.

    Returns:
        dict: Service name, version, deployment id and docs location.
    """
    return {
        "service": SERVICE_NAME,
        "version": API_VERSION,
        "app_id": APP_ID,
        "environment": "local" if IS_LOCAL else "aws",
        "docs": f"{SERVICE_PREFIX}/docs",
    }


# GET /health
# Request:  no body, no authentication.
# Response 200: {"status": "ok", "database": "PostgreSQL 17.7 on x86_64-..."}
# Response 503: {"error": {"status": 503, "type": "database_unavailable", ...}}
@api.get("/health", tags=["service"], summary="Liveness and database check")
async def health() -> dict[str, str]:
    """
    Verify that the Lambda is warm and can reach PostgreSQL.

    Returns:
        dict: ``status`` and the PostgreSQL version banner.
    """
    return {"status": "ok", "database": ping()}


# GET /workflow
# Request:  no body, no authentication.
# Response 200:
#   {"statuses": [{"id": "OPEN", "label": "Open", "is_terminal": false}, ...],
#    "transitions": [{"from": "OPEN", "to": "IN_PROGRESS"}, ...]}
@api.get("/workflow", tags=["service"], summary="Incident workflow graph")
async def workflow() -> dict[str, Any]:
    """
    Publish the incident state machine so the UI can render it as a diagram.

    Returns:
        dict: ``statuses`` and the legal ``transitions`` between them.
    """
    return workflow_graph()


api.include_router(auth.router)
api.include_router(users.router)
api.include_router(facilities.router)
api.include_router(engineers.router)
api.include_router(incidents.router)
api.include_router(dashboard.router)

# Outermost wrapper: must run before routing, hence not add_middleware().
app = ServicePrefixMiddleware(api, SERVICE_PREFIX)
