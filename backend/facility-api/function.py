"""
AWS Lambda entry point for the ACME facility incident management API.

Terraform (`infra/locals.tf`) hard-codes the handler as ``function.handler`` for
every Python service, so this module only exists to adapt the FastAPI (ASGI)
application to the Lambda invocation contract via Mangum.

The same Lambda is reachable through three routes, all handled transparently by
``app.middleware.ServicePrefixMiddleware``:

* CloudFront  -> ``https://{cloudfront}/api/facility-api/incidents``
* Function URL -> ``https://{url-id}.lambda-url.{region}.on.aws/incidents``
* Local proxy  -> ``http://localhost:3001/api/facility-api/incidents``
"""

import logging
import os

from mangum import Mangum

from app.main import app

logger = logging.getLogger()
logger.setLevel(os.getenv("LOG_LEVEL", "INFO"))

# Mangum translates Lambda Function URL / API Gateway payloads (v1 and v2) into
# ASGI scopes. ``lifespan="off"`` because Lambda has no long-lived startup phase;
# database bootstrap happens lazily on first use instead.
handler = Mangum(app, lifespan="off", api_gateway_base_path="/")


# Convenience entry point for `python function.py` smoke tests.
if __name__ == "__main__":
    import uvicorn  # type: ignore[import-not-found]  # dev-only dependency

    uvicorn.run(app, host="127.0.0.1", port=int(os.getenv("PORT", "8000")))
