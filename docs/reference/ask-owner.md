# `ask_owner` API

[Documentation index](../README.md)

`ask_owner` is mandatory managed-worker infrastructure for one direct-owner
decision required to continue the current assignment.

It is not a generic messaging channel.

## Availability

Every valid managed worker receives the `ask_owner` tool at launch.

Normal definition `tools`, `excludeTools`, and `noTools` policy cannot remove
this infrastructure capability.

## Request

```json
{
  "question": "Should I use option A or option B?",
  "files": [".pi-herdsman/options.md", "diagram.png"]
}
```

`question` must contain non-whitespace text.
`files` supplies supporting evidence using the same rules as `worker`: complete
strict UTF-8 text may be embedded, while other files are canonical local
references and are not copied or snapshotted. Relative paths use the worker's
working directory. This does not weaken the sole-final-tool-call rule.

## Turn rule

`ask_owner` must be:

- the worker's only tool call in the turn;
- the final tool call of the turn.

The worker then stops and waits.

A call made alongside another tool call is rejected.

## Eligibility

A worker can ask only while it has a valid active assignment and:

- has no outstanding ask;
- has no completed/final result pending;
- has no pending state transition;
- has no unacknowledged owner request;
- has no ordinary unresolved direct-worker work.

A delegation-enabled worker may ask its own owner when its unresolved direct
workers are themselves validly blocked on owner questions. Ordinary active
workers and pending worker results still block escalation.

## Durable effect

On acceptance, Pi Herdsman creates one correlated ask record and sets
`pendingAskId` while preserving the original active assignment request ID.

The tool result tells the worker that the assignment is blocked and returns
details containing:

```text
askId
assignmentRequestId
```

The worker public state projects as `blocked` after the turn settles.

Final assignment settlement is disabled while the ask remains pending.

## Owner delivery

The exact direct owner receives the question through the existing owner-session
delivery path.

The system does not automatically forward a worker question through an ownership
chain.

If a delegating worker needs a lead decision, it independently calls `ask_owner`
on its own direct ownership edge.

## Reply

The direct owner answers through the `worker` tool:

```json
{
  "action": "reply",
  "worker": "<exact worker>",
  "message": "Use option B."
}
```

The reply is correlated to:

- ask ID;
- original assignment request ID;
- run ID;
- owner session;
- workspace;
- worker label;
- pane;
- Pi session.

A mismatched or stale reply fails closed.

The worker clears the pending ask, acknowledges the reply request, and resumes
the same assignment with the owner answer.

## One outstanding question

Only one `ask_owner` question may be outstanding per assignment at a time.

There is no ask timeout.

The worker must not guess the owner answer and complete while blocked.

Rejected calls identify the known eligibility reason, such as no active
assignment, an existing owner question, settling state, a pending control
request, or active direct-worker work.

## Close

Closing the worker abandons the pending question as part of worker teardown.

## See also

- [`worker` `reply`](worker.md#reply)
- [Lifecycle](../concepts/lifecycle.md)
- [Delegation](../concepts/delegation.md)
