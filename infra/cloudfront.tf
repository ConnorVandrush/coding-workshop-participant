resource "aws_cloudfront_origin_access_control" "this" {
  count                             = data.aws_caller_identity.this.id != "000000000000" ? 1 : 0
  name                              = local.origin_id
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Client-side routing for the React app.
#
# The bucket policy grants CloudFront `s3:GetObject` and nothing else, so S3
# answers a request for a key that does not exist with 403 AccessDenied rather
# than 404 - there is no `s3:ListBucket` permission with which to tell the two
# apart. Every client route (`/incidents`, `/dashboard`, ...) is exactly that:
# a path with no object behind it. So the app is served by rewriting those
# paths to `/index.html` here, on the way in.
#
# The alternative, a distribution-wide `custom_error_response`, cannot work:
# it applies to every origin, so it would also rewrite the API's own 403s and
# 404s - turning "you may not do that" into an HTML page with a 200 on it.
# A function attached to the default cache behaviour alone never sees `/api/*`,
# which is served by its own ordered_cache_behavior.
resource "aws_cloudfront_function" "spa_router" {
  count   = data.aws_caller_identity.this.id != "000000000000" ? 1 : 0
  name    = format("%s-spa-router", local.origin_id)
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite client-side routes to /index.html"
  publish = true

  code = <<-JAVASCRIPT
    function handler(event) {
      var request = event.request;
      var lastSegment = request.uri.split('/').pop();

      // A final segment containing a dot is a real file - index-a1b2c3.js,
      // manifest.webmanifest, sw.js. Those are left alone so that an asset
      // which genuinely is not there still fails, rather than quietly
      // returning HTML with a 200 and breaking in the browser instead.
      if (lastSegment.indexOf('.') === -1) {
        request.uri = '/index.html';
      }

      return request;
    }
  JAVASCRIPT
}

resource "aws_cloudfront_distribution" "this" {
  count               = data.aws_caller_identity.this.id != "000000000000" ? 1 : 0
  enabled             = true
  is_ipv6_enabled     = true
  default_root_object = "index.html"
  price_class         = "PriceClass_200"

  origin {
    domain_name              = aws_s3_bucket.this.bucket_regional_domain_name
    origin_id                = local.origin_id
    origin_access_control_id = element(aws_cloudfront_origin_access_control.this.*.id, count.index)
  }

  dynamic "origin" {
    for_each = local.function_origins
    content {
      domain_name = origin.value.domain_name
      origin_id   = origin.value.origin_id

      custom_header {
        name  = "X-Forwarded-Host"
        value = origin.value.domain_name
      }

      custom_origin_config {
        http_port              = 80
        https_port             = 443
        origin_protocol_policy = "https-only"
        origin_ssl_protocols   = ["TLSv1.2"]
      }
    }
  }

  # logging_config {
  #   include_cookies = false
  #   bucket          = var.aws_bucket
  #   prefix          = "cdn_website_logs/"
  # }

  dynamic "ordered_cache_behavior" {
    for_each = local.function_origins
    content {
      path_pattern     = "/api/${ordered_cache_behavior.value.name}*"
      target_origin_id = ordered_cache_behavior.value.origin_id

      allowed_methods        = ["GET", "HEAD", "OPTIONS", "DELETE", "PATCH", "POST", "PUT"]
      cached_methods         = ["GET", "HEAD"]
      viewer_protocol_policy = "redirect-to-https"

      # Use managed cache policy for no caching (ID: 4135ea2d-6df8-44a3-9df3-4b5a84be39ad)
      cache_policy_id = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"

      # Use managed origin request policy - AllViewerExceptHostHeader
      # This forwards all viewer headers EXCEPT Host, so Lambda Function URLs get the correct Host header
      # (ID: b689b0a8-53d0-40ab-baf2-68738e2966ac = AllViewerExceptHostHeader)
      origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"

      # Legacy cache settings (commented out - using managed policies above)
      # min_ttl     = 0
      # default_ttl = 0
      # max_ttl     = 0

      # forwarded_values {
      #   query_string = true
      #   headers      = ["*"]

      #   cookies {
      #     forward = "all"
      #   }
      # }
    }
  }

  default_cache_behavior {
    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    default_ttl = 3600
    max_ttl     = 86400
    min_ttl     = 0

    target_origin_id       = local.origin_id
    viewer_protocol_policy = "redirect-to-https"

    forwarded_values {
      query_string = false

      cookies {
        forward = "none"
      }
    }

    # Only on this behaviour: `/api/*` has its own, and must keep whatever
    # status the API returned.
    function_association {
      event_type   = "viewer-request"
      function_arn = element(aws_cloudfront_function.spa_router.*.arn, count.index)
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = local.app_tags
}

resource "aws_s3_bucket_policy" "this" {
  count  = data.aws_caller_identity.this.id != "000000000000" ? 1 : 0
  bucket = aws_s3_bucket.this.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudFrontServicePrincipal"
        Effect = "Allow"
        Principal = {
          Service = data.aws_service_principal.cloudfront.name
        }
        Action   = "s3:GetObject"
        Resource = format("%s/*", aws_s3_bucket.this.arn)
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = format(
              "arn:%s:cloudfront::%s:distribution/%s",
              data.aws_partition.this.partition,
              data.aws_caller_identity.this.account_id,
              element(aws_cloudfront_distribution.this.*.id, count.index)
            )
          }
        }
      }
    ]
  })
}
