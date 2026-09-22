"""
A single error type and a single error envelope for the whole API.

Every failure - validation, permission, workflow or database - reaches the
client as::

    {"error": {"status": <int>, "type": "<slug>", "message": "<human text>",
               "details": <object|array|null>}}
"""

from typing import Any, Optional


class ApiError(Exception):
    """
    Raised anywhere in the service to produce a structured error response.

    Args:
        status_code: HTTP status to return.
        error_type: Stable machine-readable slug (e.g. ``not_found``).
        message: Human-readable explanation safe to show a user.
        details: Optional structured context, such as failing field names.
    """

    def __init__(
        self,
        status_code: int,
        error_type: str,
        message: str,
        details: Optional[Any] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.error_type = error_type
        self.message = message
        self.details = details

    def to_payload(self) -> dict[str, Any]:
        """
        Render the exception as the JSON body sent to the client.

        Returns:
            dict: The error envelope.
        """
        return {
            "error": {
                "status": self.status_code,
                "type": self.error_type,
                "message": self.message,
                "details": self.details,
            }
        }


def not_found(resource: str, identifier: Any) -> ApiError:
    """
    Build a consistent 404 for a missing record.

    Args:
        resource: Human name of the resource, e.g. ``"Incident"``.
        identifier: The identifier that was looked up.

    Returns:
        ApiError: A ready-to-raise 404.
    """
    return ApiError(404, "not_found", f"{resource} {identifier} was not found")
