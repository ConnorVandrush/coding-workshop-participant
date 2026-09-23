# Notification worker

Expands pending rows in the `notification_events` outbox into one
`notifications` row per interested person.

It exists so that fan-out happens off the request. A status change can concern
several people; doing that work inside the API call would add latency to a
workflow transition, and a failure to notify would fail a state change that has
already been agreed. The API records the bare event and returns; the expansion
happens later.

## Why an outbox and not a queue

SQS with an event source mapping is the usual answer here, and an asynchronous
Lambda invocation is the usual fallback. Neither is available: the functions run
in a VPC with no NAT gateway and no interface endpoint for SQS or Lambda, so an
in-VPC function cannot reach those control-plane APIs at all — a call hangs
until the request times out. `ec2:CreateVpcEndpoint` is denied, so that cannot
be fixed from here either.

What is always reachable is the database the function is already connected to,
so it carries the handoff. `app/notifications.py` in the API inserts the event;
this worker expands it.

## What drains the outbox

Two things, and they are safe to run at the same time. Rows are claimed with
`FOR UPDATE SKIP LOCKED`, so a worker and an API container never handle the same
event twice and never block one another.

* **This worker**, wherever something can invoke it — LocalStack, an operator,
  a scheduler if one ever becomes available. It drains the whole backlog, 500
  events per pass by default, or `{"limit": n}` to bound it.
* **The API**, when someone reads their notification feed. That path drains a
  bounded batch of 25, so the reader who happens to trigger it never pays for
  an unbounded backlog, and the work still happens off the request that caused
  the change.

## How it is deployed

Terraform discovers this folder from `requirements.txt` and deploys it exactly
like the API — `python3.13`, handler `function.handler`, in the VPC, with an SQS
dead-letter queue for invocations that fail after their retries. Nothing invokes
it on a schedule; see above for why.

`boto3` is not in `requirements.txt`: nothing here calls AWS. The only outbound
dependency is PostgreSQL.

## Recipients

The reporter and the assigned engineer always hear about a change, and facility
admins do because they own the queue as a whole. Deactivated accounts are
skipped. The person who made the change is excluded — telling someone what they
just did is noise. Internal notes are not announced, since employees cannot see
them.

## Failure handling

An event is marked processed whether or not it produced notifications: an
unknown event type, or one whose incident has since been deleted, will never
succeed, so retrying it is pure cost. `attempts` is incremented on every pass
and events are skipped once it reaches 5, so one poisonous row cannot be
retried forever at every reader's expense.
