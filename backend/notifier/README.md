# Notification worker

Consumes incident events from SQS and writes one notification row per
interested person.

It exists so that fan-out happens off the request. A status change can concern
several people; doing that work inside the API call would add latency to a
workflow transition, and a failure to notify would fail a state change that has
already been agreed. The API enqueues and returns; this worker expands.

## How it is deployed

Terraform discovers this folder from `requirements.txt` and deploys it exactly
like the API — `python3.13`, handler `function.handler`. Delivery is an SQS
event source mapping defined in `infra/notifications.tf`, so retries and the
dead-letter queue are handled by SQS rather than by code here.

`boto3` is not in `requirements.txt`: nothing here calls AWS. Records arrive
through the event source mapping, and the only outbound dependency is
PostgreSQL.

## Recipients

The reporter and the assigned engineer always hear about a change, and facility
admins do because they own the queue as a whole. The person who made the change
is excluded — telling someone what they just did is noise. Internal notes are
not announced, since employees cannot see them.

## Failure handling

A record that cannot be processed is returned in `batchItemFailures`, so SQS
retries that message alone rather than replaying the whole batch. After the
configured attempts it lands in the dead-letter queue.
