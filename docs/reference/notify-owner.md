# `notify_owner` API

[Documentation index](../README.md)

`notify_owner` sends material information to a managed Agent's exact direct
owner without blocking the assignment or requiring a reply.

## Availability and request

Every valid managed Agent receives the tool, including leaf Agents and
Agents with active child work. It is available through direct Pi tool dispatch.

```json
{
  "message": "The upstream API changed; I am adapting the implementation.",
  "files": ["findings.md"]
}
```

`message` must contain non-whitespace text. Optional `files` use the same
strict UTF-8 and result-binding rules as managed-Agent handoffs. File content
is resolved and snapshotted before the notification is accepted.

## Acceptance and delivery

Acceptance requires a valid active assignment that is not settling. Herdsman
atomically stores the notification in the Agent mailbox before reporting
success. At most eight undelivered notifications may be outstanding for one
Agent; a rejected call does not remove previously accepted records.

The notification goes only to the exact direct owner. Pi's persisted owner
session history confirms receipt. A successful message submission is not
confirmation; unresolved records remain durable and are reconciled after
restart. Because Pi message submission is asynchronous, recovery may replay a
notification if interruption occurred before its receipt became visible.
Delivery is therefore recoverable and may be at-least-once, not exactly-once.

Notifications do not set `pendingAskId`, block completion, or create a reply
obligation. The owner may use `steer_agent` when that operation is eligible.
Ordinary Agent cleanup waits until accepted notifications have confirmed
receipts. Explicit `stop_agent` retains its intentional abandonment behavior.

## Choosing the owner tool

Use `notify_owner` when your direct owner needs material information but you
can continue working. Use `await_owner` only when your assignment cannot
proceed without the owner's answer. After an accepted `await_owner` call, end
your turn; Herdsman retains the blocked assignment until the owner replies.

See [`await_owner`](await-owner.md) for the blocking, correlated request
contract and [Agent tools](agent.md) for `steer_agent`.
