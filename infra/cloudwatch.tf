# Observability for the backend Lambdas.
#
# Lambda already writes a REPORT line per invocation with the billed duration
# and the memory used. That answers "is the function healthy" and nothing else:
# it cannot say which endpoint is slow, which is failing, or how often. The
# application emits one JSON line per request instead (see
# `app/middleware.py::RequestLogMiddleware`), and the filters below turn those
# lines into CloudWatch metrics without anything having to parse message text.
#
# The log groups themselves are created by the Lambda module, with retention
# already set to 7 days (`cloudwatch_logs_retention_in_days` in lambda.tf).

locals {
  # Only the services that emit the structured access log. The notifier is a
  # scheduled drain with no HTTP surface, so request metrics would be empty.
  http_services = { for name, func in local.function_names : name => func if func.name == "facility-api" }
}

# Count of requests that failed with a 5xx.
#
# Matching on `$.level` rather than on the status code keeps the filter stable:
# the middleware decides what counts as an error in one place, and this follows
# it rather than restating the rule.
resource "aws_cloudwatch_log_metric_filter" "server_errors" {
  for_each = data.aws_caller_identity.this.id != "000000000000" ? local.http_services : {}

  name           = format("%s-%s-server-errors", var.aws_project, local.app_id)
  log_group_name = module.lambda[each.key].lambda_cloudwatch_log_group_name
  pattern        = "{ $.event = \"request\" && $.level = \"ERROR\" }"

  metric_transformation {
    name      = "ServerErrors"
    namespace = local.metric_namespace
    value     = "1"
    # Without this an interval with no errors reports no data rather than zero,
    # which makes a rate calculation divide by nothing and an alarm sit in
    # INSUFFICIENT_DATA instead of OK.
    default_value = 0
    unit          = "Count"
  }
}

# Count of requests rejected as the caller's fault.
#
# Tracked separately from 5xx because the two mean opposite things: a rise in
# 4xx usually means a client or a user is doing something wrong, and paging
# someone for it would be noise. It is still worth a graph - a sudden jump in
# 401s is what a broken token refresh looks like from the outside.
resource "aws_cloudwatch_log_metric_filter" "client_errors" {
  for_each = data.aws_caller_identity.this.id != "000000000000" ? local.http_services : {}

  name           = format("%s-%s-client-errors", var.aws_project, local.app_id)
  log_group_name = module.lambda[each.key].lambda_cloudwatch_log_group_name
  pattern        = "{ $.event = \"request\" && $.level = \"WARN\" }"

  metric_transformation {
    name          = "ClientErrors"
    namespace     = local.metric_namespace
    value         = "1"
    default_value = 0
    unit          = "Count"
  }
}

# Request latency, as a metric rather than a count.
#
# The value is the duration itself, so CloudWatch holds a distribution and p95
# and p99 can be read straight off it. A count of "requests slower than N" would
# only ever answer the one question N was chosen for.
resource "aws_cloudwatch_log_metric_filter" "request_duration" {
  for_each = data.aws_caller_identity.this.id != "000000000000" ? local.http_services : {}

  name           = format("%s-%s-request-duration", var.aws_project, local.app_id)
  log_group_name = module.lambda[each.key].lambda_cloudwatch_log_group_name
  pattern        = "{ $.event = \"request\" }"

  metric_transformation {
    name      = "RequestDurationMs"
    namespace = local.metric_namespace
    value     = "$.duration_ms"
    unit      = "Milliseconds"
  }
}

# --------------------------------------------------------------------------
# Alarms
# --------------------------------------------------------------------------
# Off by default, because this workshop's participant role is granted
# `cloudwatch:Get*` and `cloudwatch:List*` and no `Put`, so creating an alarm
# fails with AccessDenied:
#
#   User: ...coding-workshop-assume-us-east-2-... is not authorized to perform:
#   cloudwatch:PutMetricAlarm
#
# The definitions are kept here rather than described in a README so that they
# are correct and ready: in an account with the permission, set
# `enable_cloudwatch_alarms = true` and they apply. `alarm_sns_topic_arn` is
# separate because the same role can `sns:Publish` but not create a topic.
variable "enable_cloudwatch_alarms" {
  description = "Create CloudWatch alarms. Needs cloudwatch:PutMetricAlarm, which the workshop role does not have."
  type        = bool
  default     = false
}

variable "alarm_sns_topic_arn" {
  description = "SNS topic to notify when an alarm fires. Empty means the alarm changes state silently."
  type        = string
  default     = ""
}

resource "aws_cloudwatch_metric_alarm" "server_errors" {
  for_each = var.enable_cloudwatch_alarms ? local.http_services : {}

  alarm_name        = format("%s-%s-server-errors", var.aws_project, local.app_id)
  alarm_description = "The API returned 5xx responses. Something is broken server-side."

  namespace           = local.metric_namespace
  metric_name         = "ServerErrors"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  # A 5xx is never expected, so one is worth knowing about; there is no rate
  # here to fall below a threshold and hide a steady trickle of failures.
  treat_missing_data = "notBreaching"

  alarm_actions = compact([var.alarm_sns_topic_arn])
  ok_actions    = compact([var.alarm_sns_topic_arn])
  tags          = local.app_tags
}

resource "aws_cloudwatch_metric_alarm" "slow_requests" {
  for_each = var.enable_cloudwatch_alarms ? local.http_services : {}

  alarm_name        = format("%s-%s-slow-requests", var.aws_project, local.app_id)
  alarm_description = "p95 request latency above 1s for 10 minutes."

  namespace          = local.metric_namespace
  metric_name        = "RequestDurationMs"
  extended_statistic = "p95"
  period             = 300
  # Two periods, because one slow window is usually an Aurora resume after the
  # cluster has scaled to zero - a known cost of this configuration, not an
  # incident. Two in a row is a real regression.
  evaluation_periods  = 2
  threshold           = 1000
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = compact([var.alarm_sns_topic_arn])
  ok_actions    = compact([var.alarm_sns_topic_arn])
  tags          = local.app_tags
}

resource "aws_cloudwatch_metric_alarm" "function_throttles" {
  for_each = var.enable_cloudwatch_alarms ? local.http_services : {}

  alarm_name        = format("%s-%s-throttles", var.aws_project, local.app_id)
  alarm_description = "Lambda is being throttled: concurrency has run out."

  # From Lambda's own metrics rather than the access log, because a throttled
  # invocation never reaches the application and so never writes a log line.
  namespace   = "AWS/Lambda"
  metric_name = "Throttles"
  dimensions = {
    FunctionName = module.lambda[each.key].lambda_function_name
  }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = compact([var.alarm_sns_topic_arn])
  ok_actions    = compact([var.alarm_sns_topic_arn])
  tags          = local.app_tags
}
