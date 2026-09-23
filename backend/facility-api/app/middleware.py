"""
ASGI middleware: URL reconciliation, and one structured log line per request.

CloudFront routes ``/api/facility-api*`` to the Function URL **without**
stripping the prefix (see `infra/cloudfront.tf`), while a direct Function URL
call and the local dev proxy (`bin/proxy-server.js`, which strips it) arrive
without one. Rather than registering every route twice, the prefix is removed
here - before routing - and published as ``root_path`` so that the generated
OpenAPI document and the ``/docs`` page keep working behind CloudFront.
"""

import json
import logging
import time
import uuid
from typing import Any, Callable, MutableMapping

logger = logging.getLogger(__name__)
access_logger = logging.getLogger("app.access")

Scope = MutableMapping[str, Any]

# Paths that would otherwise fill the log with nothing. /health is polled by the
# deploy workflow and by CloudFront; logging it drowns the requests that matter.
_QUIET_PATHS = frozenset({"/health"})


class ServicePrefixMiddleware:
    """
    Strip an optional ``/api/{service-name}`` prefix from the request path.

    Args:
        app: The wrapped ASGI application.
        prefix: The prefix to strip, e.g. ``/api/facility-api``.
    """

    def __init__(self, app: Callable[..., Any], prefix: str) -> None:
        self.app = app
        self.prefix = prefix.rstrip("/")

    async def __call__(self, scope: Scope, receive: Callable, send: Callable) -> None:
        """Rewrite the scope in place for HTTP requests, then delegate."""
        if scope.get("type") == "http" and self.prefix:
            path = scope.get("path", "")
            if path == self.prefix or path.startswith(f"{self.prefix}/"):
                scope = dict(scope)
                scope["path"] = path[len(self.prefix):] or "/"
                scope["root_path"] = self.prefix
                # raw_path (set by Mangum) would otherwise contradict the rewrite.
                scope.pop("raw_path", None)
        await self.app(scope, receive, send)


class RequestLogMiddleware:
    """
    Emit one JSON line per request: method, path, status and duration.

    Lambda already writes a REPORT line per invocation with the billed duration
    and the memory used, which is enough to answer "is the function healthy"
    and nothing else. It cannot say which endpoint is slow, which is failing,
    or for whom - and those are the questions an operator actually has.

    JSON rather than a formatted string because CloudWatch Logs Insights parses
    it natively, so ``stats pct(duration_ms, 95) by route`` works without a
    regex, and because ``infra/cloudwatch.tf`` builds metric filters from these
    fields.

    What is deliberately absent: request and response bodies, the Authorization
    header, and anything else that could put a credential or an incident's
    contents into a log that is retained for a fortnight and readable by anyone
    with console access. The user id is recorded, the user's data is not.

    Args:
        app: The wrapped ASGI application.
    """

    def __init__(self, app: Callable[..., Any]) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Callable, send: Callable) -> None:
        """Time the request, then log its outcome once the response starts."""
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        started = time.perf_counter()
        # Prefer the trace id the platform already assigned, so a log line can
        # be lined up with an X-Ray trace or a CloudFront access log entry.
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        request_id = headers.get("x-amzn-trace-id") or headers.get("x-request-id") or str(uuid.uuid4())
        status_holder = {"status": 500}

        async def send_wrapper(message: MutableMapping[str, Any]) -> None:
            """Record the status as it goes past, then pass the message on."""
            if message.get("type") == "http.response.start":
                status_holder["status"] = message.get("status", 500)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            path = scope.get("path", "")
            if path not in _QUIET_PATHS:
                duration_ms = round((time.perf_counter() - started) * 1000, 2)
                status = status_holder["status"]
                access_logger.info(json.dumps({
                    # `level` is what the metric filters in infra/cloudwatch.tf
                    # match on, so a 5xx becomes a CloudWatch metric without
                    # anything having to parse the message text.
                    "level": "ERROR" if status >= 500 else "WARN" if status >= 400 else "INFO",
                    "event": "request",
                    "method": scope.get("method", ""),
                    # The templated route ("/incidents/{incident_id}") rather
                    # than the concrete path, so percentiles group usefully
                    # instead of splitting across every id ever requested.
                    "route": _route_of(scope),
                    "path": path,
                    "status": status,
                    "duration_ms": duration_ms,
                    "request_id": request_id,
                }))


def _route_of(scope: Scope) -> str:
    """
    Report the matched route template, falling back to the raw path.

    Args:
        scope: The ASGI scope, after routing has run.

    Returns:
        str: The route template, e.g. ``/incidents/{incident_id}``.
    """
    route = scope.get("route")
    return getattr(route, "path", None) or scope.get("path", "")
