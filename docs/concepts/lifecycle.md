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

If the expected pane, Pi session, and run-scoped alias are all absent from a
coherent Herdr inventory before a durable result resolves the assignment, the
assignment projects as `lost`. The mailbox remains the durable owner of that
generation until the direct owner explicitly closes it; physical disappearance
does not mean completion or task failure. Moved, conflicting, or incomplete
evidence remains `unknown`.

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
- `lost`

See [Agent states](../reference/agent-states.md) for their exact control
meaning.

Raw herdr lifecycle alone is insufficient. Mailbox handoff, pending result
delivery, pending owner questions, and cleanup may make an agent unsafe to
control until convergence is complete.

## Asynchronous orchestration

Delegation does not suspend the owning controller until an agent finishes.

`delegate` returns after the task has been atomically recorded for controller
restart recovery. The agent then runs independently in its managed Pi session
while the owner remains available for other useful work and, for a lead Pi
session, continued user interaction.

Each active delegated assignment has one executor: that agent. The owner retains
lifecycle and control authority but does not repeat the delegated assignment
locally or assign substantially overlapping work elsewhere.

The owner may continue genuinely independent, non-overlapping work. When no such
work remains, it ends its turn normally. It does not list, inspect, steer, sleep,
or otherwise check an active agent merely for progress or completion. Agent
completion, clarification, and recovery attention return asynchronously.

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

This is asynchronous but not fire-and-forget. The owner retains lifecycle and
control authority: it can steer eligible active work when the assignment
actually changes, receives clarification requests, and remains responsible for
result delivery and cleanup. The delegated agent remains the executor of its
active assignment.

## Exactly-once assignment result

Each accepted task request maps to one final assignment result. Each managed
agent generation receives exactly one assignment; a completed agent is not
available for another task.

Result publication and cleanup are separate convergence steps. An agent may
therefore appear `settling` after its model has finished. Cleanup follows
exactly-once delivery for both completed and failed terminal results.

## Session continuation

Agent cleanup does not delete the Pi session. To continue completed context,
use the exact returned session with `continue`; Pi Herdsman starts a new agent
generation for the new assignment. The continuation uses the saved cwd, session
history, definition, and logical label together with the current effective
authorized definition configuration. Its omitted model and thinking fields
restore the saved session settings, while explicit definition fields override
them. The caller cannot rename the continued session. Use `delegate` with
`fork` when a separate derived session is required.
Session continuation does not retain the old Herdr tab. A still-live
generation may be restored from its exact managed identity, while ordinary
same-workspace tab movement remains presentation-only and does not change
assignment ownership.

## Steering is different

`steer` changes the current active assignment. It does not create an independent
result.

Steering is at-least-once at the agent boundary: an agent can apply a steer
before its acknowledgement write is recorded. If that acknowledgement write
fails, retrying the same request may apply the steer again.

Use `steer` only when `agent list` reports `steer` in `available_actions`.

## Delegating agent completion

Direct agent work is a completion gate for a delegating agent.

A delegating agent cannot publish its own final result while:

- a direct agent has ordinary active work; or
- a completed direct-agent result has not yet been delivered to the delegating agent.

This completion gate does not create a separate public delegating-agent state.
The delegating agent's own state projection remains authoritative.

## Restart and recovery

Atomic mailbox state allows exact managed agents to be reconstructed after a
controller restart. Live metadata can be rebuilt only when exact herdr and Pi
identity still match; this does not claim explicit power-loss durability.

Unknown evidence remains `unknown`; recovery never rebinds stale metadata to a
different agent generation.

## See also

- [Pi Herdsman](supervision.md) for lead supervision that does not alter agent
  assignment ownership.
- [Agents and identity](agents.md)
- [Agent states](../reference/agent-states.md)
- [Recovery](../guides/recovery.md)
