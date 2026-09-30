# Supervisor tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

`supervisor_*` is upward communication across the current direct-supervisor
edge.

An ordinary Lead routes to its active project Manager when one exists,
otherwise to Chief. A Manager routes to Chief. Managed Agents use `ask_owner`
instead.

Every operation validates the current direct supervisor. Ambiguous or
incomplete authority fails closed instead of silently routing around an
intermediate Manager.

## `supervisor_message`

Available to ordinary Leads and Managers.

```json
{
  "message": "Progress update.",
  "files": ["result:researcher#1"]
}
```

Use it for meaningful progress, reports, warnings, and completion that is not a
Manager-delegated project assignment.

It queues one bounded message and does not change coordination state. An
assigned Lead uses `supervisor_result` for terminal project completion.

`files` accepts ordinary paths, reusable direct Agent refs such as
`result:implementation#1`, and canonical `result:<request-id>` refs already
supplied as evidence. File preparation uses the same canonical submission-time
behavior and configured byte limits as Agent messages.

## `supervisor_ask`

Available to ordinary Leads and Managers.

```json
{
  "question": "Which constraint should take priority?",
  "files": ["/tmp/evidence.md"]
}
```

Use it only when a direct-supervisor decision is genuinely required.

One pending ask is allowed per session and current supervisor authority. The
question is durably recorded before publication so reconciliation can retry
transient delivery failure.

It must be the only tool call in the turn. Call it last and wait for the reply
instead of guessing.

## `supervisor_result`

Available to an ordinary Lead, but valid only when that Lead has exactly one
active Manager project assignment in its current Herdsman project scope.

```json
{
  "result": "Implemented and validated the requested change.",
  "files": ["result:reviewer#1"]
}
```

The result is persisted as a canonical result for the project assignment before
notification is attempted.

If the matching Manager is active, `supervisor_result` queues a durable
notification to it. If no Manager is active, the durable result remains saved
for the next Manager to reconcile. A durable result prevents the assignment
from being restarted, and the assignment is removed only after accepted result
delivery.

The model-facing result identifies the project branch and whether notification
was queued. Internal project assignment and result references are not exposed
as project-work handles.

Use `supervisor_message` for nonterminal progress or coordination. Use
`supervisor_result` exactly once for terminal completion of the Manager
assignment.

## Delivery

Supervisor messages are bounded durable records and can remain queued while the
target is working. Same-session restart preserves queued records and accepted
IDs are deduplicated.

Attachments are prepared at submission and the durable coordination record
remains text-only. Exact sender, target, and current authority are validated
before delivery.

A project assignment remains authorized after the Manager that created it has
left, which is why its terminal result can be completed without an active
Manager. Ordinary messages, asks, and replies continue to require current
direct-supervisor authority.

## See also

- [Staff tools](staff.md)
- [Peer tools](peer.md)
- [Project orchestration](../guides/project-orchestration.md)
