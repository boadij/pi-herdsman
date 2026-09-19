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

After starting an agent assignment or receiving an agent result or attention
event, the owner reassesses the remaining work:

1. Handle required agent control when needed.
2. Delegate another concrete, necessary objective when it is independent of
   active assignments and an authorized agent is the right owner.
3. Continue concrete, necessary independent work locally when the owner is the
   right owner and doing it now materially advances the task.
4. Otherwise end the turn.

After control, delegation, or local parallel work, the owner reassesses again.
Once further useful progress depends on active agents, or no other concrete,
necessary independent work remains, it ends the turn. Agent results,
clarifications, and recovery attention resume the session automatically.

The owner does not invent side work merely because agents are running. It does
not poll, sleep, inspect or transcript merely for progress, send status steering, or use
another mechanism to keep the turn alive.

Health reconciliation follows the same boundary. It is event-driven, with a
30-second fallback scan for durable and physical state that has not emitted a
separate event. Each scan reconciles fresh mailbox and Herdr evidence for the
controller's direct agents and sends health attention only to an idle exact
direct owner. The event's `available_actions` is a current advisory snapshot;
the selected action revalidates identity, ownership, mailbox state, and
lifecycle before it mutates anything.

Unresolved work may remain passive when it can still make progress without the
owner, or when a durable transition can produce a future result or attention
event. A condition that requires owner action wakes the direct owner. If that
same state-specific condition persists, attention may repeat. Reminder timing
is process-local and advisory rather than durable mailbox state, so a restart
may produce another reminder. Persistent attention follows approximately
`5m → 2m30s → 1m15s → 1m`, subject to the 30-second scan; stale still first
becomes eligible after ten minutes without qualifying execution progress.

The health conditions are deliberately narrow: stale working and proven lost
retain their dedicated messages; a delivered owner question may be reminded;
`result_error`, a live runtime `blocked` condition, and an old retained
unacknowledged handoff use generic attention. A retained request is not proof
of non-delivery and must not be duplicated. Physical `unknown` remains
fail-closed and receives at most one attention event for an episode. `settling`
alone is not a timeout or generic attention condition. A parent projected as
blocked while waiting for direct children is progress-capable and is not the
same as Herdr reporting that the managed child runtime is blocked.

When attention arrives, the owner handles a required action before ending the
turn. For evidence, use `transcript` for persisted Pi conversation and tool
history, and `inspect` for live terminal/process state. Leave healthy or
legitimately long-running stale work alone. Use `steer` for a cooperative
non-preemptive correction, `interrupt` to cancel the current operation,
supersede earlier undelivered steering, and continue the same assignment,
`close` to abandon an assignment, and
`reply` only for the exact pending owner question. Do not poll or keep the turn
alive solely to wait for agent progress.

Conceptually:

```text
assignment or agent event
          ↓
reassess remaining work
    ↙        ↓        ↘
 control   parallel   no useful
            work      action
          ↙     ↘        ↓
      delegate  local  end turn
          \      /        ↓
           reassess   agent event resumes
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

## Steering and interruption

`steer` changes the current active assignment cooperatively. It does not create
another result and does not cancel the current Pi operation. If a tool or model
operation does not finish, a queued steer may not take effect.

`interrupt` changes the same active assignment preemptively. It requests
cancellation of the current Pi operation, supersedes earlier steering that Pi
has not yet delivered, and supplies the replacement instruction that continues
the same assignment. The generation, active task
request, ownership, Pi session, and final-result obligation remain unchanged.

Neither action creates another assignment. `close` is the operation that
abandons the managed generation.

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
