"""
Tests for the Lambda adapter itself.

`tests/test_facility_api.py` drives the ASGI app directly. These tests go
through ``function.handler`` with the payloads AWS actually delivers, which is
the only place the Mangum translation and the ``/api/facility-api`` prefix
handling are exercised together.
"""

import base64
import json

import pytest

from conftest import PASSWORD

SERVICE_PREFIX = "/api/facility-api"


def url_event(method: str, path: str, body: dict | None = None, headers: dict | None = None) -> dict:
    """
    Build a Lambda Function URL event (payload format 2.0).

    Args:
        method: HTTP method.
        path: Request path, optionally with a query string.
        body: JSON body to send, if any.
        headers: Extra request headers.

    Returns:
        dict: The event as AWS would deliver it.
    """
    raw_path, _, raw_query = path.partition("?")
    event = {
        "version": "2.0",
        "routeKey": "$default",
        "rawPath": raw_path,
        "rawQueryString": raw_query,
        "headers": {
            "content-type": "application/json",
            "host": "abc123.lambda-url.us-east-2.on.aws",
            **(headers or {}),
        },
        "requestContext": {
            "domainName": "abc123.lambda-url.us-east-2.on.aws",
            "stage": "$default",
            "http": {
                "method": method,
                "path": raw_path,
                "protocol": "HTTP/1.1",
                "sourceIp": "203.0.113.1",
                "userAgent": "pytest",
            },
        },
        "isBase64Encoded": False,
    }
    if body is not None:
        event["body"] = json.dumps(body)
    return event


@pytest.fixture(scope="module")
def invoke(client, world):
    """
    Return a callable that invokes the real Lambda handler.

    Depends on ``world`` so the fixture data (and the bootstrap admin) exist
    before any handler call is made.

    Returns:
        Callable: ``invoke(method, path, body=None, headers=None) -> (status, text)``.
    """
    import function

    def call(method: str, path: str, body: dict | None = None, headers: dict | None = None):
        response = function.handler(url_event(method, path, body, headers), None)
        payload = response.get("body", "")
        if response.get("isBase64Encoded"):
            payload = base64.b64decode(payload).decode("utf-8")
        return response["statusCode"], payload

    return call


@pytest.mark.parametrize(
    "path",
    [
        "/health",                       # direct Function URL, and the local proxy
        f"{SERVICE_PREFIX}/health",      # CloudFront, which keeps the prefix
    ],
)
def test_handler_serves_both_url_shapes(invoke, path):
    """One Lambda answers on the Function URL and behind CloudFront."""
    status, body = invoke("GET", path)
    assert status == 200
    assert json.loads(body)["status"] == "ok"


def test_handler_reports_the_prefixed_docs_url(invoke):
    """The service metadata points at the CloudFront-reachable docs path."""
    status, body = invoke("GET", f"{SERVICE_PREFIX}/")
    assert status == 200
    assert json.loads(body)["docs"] == f"{SERVICE_PREFIX}/docs"


def test_handler_passes_the_query_string_through(invoke):
    """`rawQueryString` reaches the route's query parameters."""
    login_status, login_body = invoke(
        "POST", f"{SERVICE_PREFIX}/auth/login", {"email": "admin@acme.inc", "password": PASSWORD}
    )
    assert login_status == 200
    headers = {"authorization": f"Bearer {json.loads(login_body)['access_token']}"}

    status, body = invoke("GET", f"{SERVICE_PREFIX}/incidents?status=OPEN&limit=2", headers=headers)
    assert status == 200
    page = json.loads(body)
    assert page["limit"] == 2
    assert all(item["status"] == "OPEN" for item in page["items"])


def test_handler_does_not_duplicate_cors_headers(invoke, monkeypatch):
    """
    Inside Lambda the app must not add CORS headers of its own.

    The Function URL already sets them (`infra/lambda.tf`), and a second copy
    merges into `Access-Control-Allow-Origin: *, *`, which browsers reject as
    malformed while the request itself still returns 200 - a failure that only
    shows up in a browser, never in an HTTP-level test.
    """
    monkeypatch.setenv("AWS_LAMBDA_FUNCTION_NAME", "coding-workshop-facility-api-test")

    import importlib

    import app.main

    reloaded = importlib.reload(app.main)
    middleware = [entry.cls.__name__ for entry in reloaded.api.user_middleware]
    assert "CORSMiddleware" not in middleware

    # Restore the module for the rest of the session.
    monkeypatch.delenv("AWS_LAMBDA_FUNCTION_NAME")
    importlib.reload(app.main)


def test_app_adds_cors_when_not_behind_lambda():
    """Under plain uvicorn nothing else sets CORS, so the app must."""
    import app.main

    middleware = [entry.cls.__name__ for entry in app.main.api.user_middleware]
    assert "CORSMiddleware" in middleware


def test_handler_returns_the_error_envelope_for_unknown_routes(invoke):
    """Even routing failures come back in the shared envelope."""
    status, body = invoke("GET", f"{SERVICE_PREFIX}/does-not-exist")
    assert status == 404
    assert set(json.loads(body)["error"]) == {"status", "type", "message", "details"}


def test_handler_rejects_unauthenticated_calls(invoke):
    """Authentication is enforced at the Lambda boundary, not only in tests."""
    status, body = invoke("GET", f"{SERVICE_PREFIX}/dashboard/summary")
    assert status == 401
    assert json.loads(body)["error"]["type"] == "not_authenticated"
