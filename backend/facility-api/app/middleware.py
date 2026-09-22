"""
ASGI middleware that reconciles the three URLs this Lambda answers on.

CloudFront routes ``/api/facility-api*`` to the Function URL **without**
stripping the prefix (see `infra/cloudfront.tf`), while a direct Function URL
call and the local dev proxy (`bin/proxy-server.js`, which strips it) arrive
without one. Rather than registering every route twice, the prefix is removed
here - before routing - and published as ``root_path`` so that the generated
OpenAPI document and the ``/docs`` page keep working behind CloudFront.
"""

import logging
from typing import Any, Callable, MutableMapping

logger = logging.getLogger(__name__)

Scope = MutableMapping[str, Any]


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
