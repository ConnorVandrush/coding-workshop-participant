# Asynchronous notification fan-out.
#
# The API records an incident event here and returns; backend/notifier consumes
# the queue and writes one notification per interested person. Fan-out is kept
# off the request so a status change does not wait on notifying several people,
# and so a failure to notify cannot undo a transition that has already been
# agreed.
#
# The queue name must start with the project and end with the participant id:
# the Lambda execution role grants sqs:* only on
# arn:aws:sqs:*:*:coding-workshop*<app_id>*.

resource "aws_sqs_queue" "notifications" {
  name = format("%s-notifications-%s", var.aws_project, local.app_id)

  # Long enough for a cold start plus the database round trip, and at least as
  # long as the consumer's timeout, or SQS would redeliver work still in flight.
  visibility_timeout_seconds = 310
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.notifications_dlq.arn
    maxReceiveCount     = 3
  })

  tags = local.app_tags
}

resource "aws_sqs_queue" "notifications_dlq" {
  name                      = format("%s-notifications-dlq-%s", var.aws_project, local.app_id)
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true

  tags = local.app_tags
}

# Deliver queued events to the worker. Guarded on the service existing so the
# rest of the stack still applies if backend/notifier is ever removed.
resource "aws_lambda_event_source_mapping" "notifications" {
  for_each = contains(keys(local.function_names), "notifier") ? toset(["notifier"]) : toset([])

  event_source_arn = aws_sqs_queue.notifications.arn
  function_name    = module.lambda[each.value].lambda_function_arn
  batch_size       = 10
  enabled          = true

  # The worker reports individual bad records, so SQS retries just those
  # rather than replaying an entire batch.
  function_response_types = ["ReportBatchItemFailures"]

  depends_on = [module.lambda]
}

output "notifications_queue_url" {
  description = "URL of the notification work queue"
  value       = aws_sqs_queue.notifications.url
}
