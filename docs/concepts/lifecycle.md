# Lifecycle

[Documentation index](../README.md)

The public lifecycle is assignment-centric. It deliberately does not mirror raw
herdr process states one-for-one.

## Assignment flow

A normal assignment moves conceptually through:

```text
accepted
  ↓
working
  ↓
agent completes
  ↓
settling
  ↓ result delivered once
cleanup
  ↓
gone
```

The authoritative final result is correlated to the accepted assignment request
ID.

## Clarification flow

An agent that requires an owner decision stays on the same assignment:

```text
working
  ↓ ask_owner
blocked
  ↓ owner reply
working
  ↓ completion
settling
  ↓ result delivery
cleanup → gone
```

`reply` is not a new assignment and does not create another final result.

## Public state is a safe-control projection

The public states are:

- `working`
- `blocked`
- `settling`
- `unknown`

See [Agent states](../reference/agent-states.md) for their exact control
meaning.

Raw herdr lifecycle alone is insufficient. Mailbox handoff, pending result
delivery, pending owner questions, and cleanup may make an agent unsafe to
control until convergence is complete.

## Asynchronous orchestration

Delegation does not suspend the owning controller until an agent finishes.

`delegate` returns after the task has been durably accepted. The agent then runs
independently in its managed Pi session while the owner remains available for
other useful work and, for a lead Pi session, continued user interaction.

The owner must not poll for completion. It may continue with work that does not
depend on the result or end its turn normally. Agent completion or an
`ask_owner` question is delivered back to that same owner when attention is
required.

Conceptually:

```text
assignment accepted
       ↓
owner remains available
       ↓
agent runs independently
       ↓
result or question returns to the owner
```

This is asynchronous but not fire-and-forget. The owner retains explicit
assignment ownership, can steer eligible active work, receives clarification
requests, and remains responsible for result delivery and lifecycle control.

## Exactly-once assignment result

Each accepted task request maps to one final assignment result. Each managed
agent generation receives exactly one assignment; a completed agent is not
available for another task.

Result publication and cleanup are separate convergence steps. An agent may
therefore appear `settling` after its model has finished. Cleanup follows
exactly-once delivery for both completed and failed terminal results.

## Session continuation

Agent cleanup does not delete the Pi session. To continue completed context,
use the exact returned session with `delegate.session`; Pi Herdsman starts a new
agent generation for the new assignment. The continuation uses the saved cwd
and session history together with the current effective authorized definition
configuration. Use `delegate.definition` with `fork` when a separate derived
session is required.
Session continuation does not retain the old Herdr tab. A still-live
generation may be restored from its exact managed identity, while ordinary
same-workspace tab movement remains presentation-only and does not change
assignment ownership.

## Steering is different

`steer` changes the current active assignment. It does not create an independent
result.

Steering is at-least-once at the agent boundary: an agent can apply a steer
before its acknowledgement write becomes durable. If that acknowledgement
write fails, retrying the same request may apply the steer again.

Use `steer` only when `agent list` reports `steer` in `available_actions`.

## Delegating agent completion

Direct agent work is a completion gate for a delegating agent.

A delegating agent cannot publish its own final result while:

- a direct agent has ordinary active work; or
- a completed direct-agent result has not yet been delivered to the delegating agent.

This completion gate does not create a separate public delegating-agent state.
The delegating agent's own state projection remains authoritative.

## Restart and recovery

Durable mailbox state allows exact managed agents to be reconstructed after a
controller restart. Live metadata can be rebuilt only when exact herdr and Pi
identity still match.

Unknown evidence remains `unknown`; recovery never rebinds stale metadata to a
different agent generation.

## See also

- [Pi Herdsman](supervision.md) for lead supervision that does not alter agent
  assignment ownership.
- [Agents and identity](agents.md)
- [Agent states](../reference/agent-states.md)
- [Recovery](../guides/recovery.md)
