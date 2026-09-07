# Worker states

[Documentation index](../README.md)

The public state is a safe-control projection built from live lifecycle and
durable assignment/convergence evidence. It is not a raw herdr lifecycle string.

| State      | Meaning                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------- |
| `working`  | An assignment is active.                                                                              |
| `blocked`  | Active assignment waits for owner attention or another condition.                                     |
| `settling` | Assignment handoff, completion/result delivery, launch, direct-worker gate, or cleanup is converging. |
| `unknown`  | Exact safe control state cannot be proved.                                                            |

## `available_actions` is authoritative

A live worker record in `worker list` includes an `available_actions` snapshot.
Use only operations currently listed there; do not infer control eligibility
from `state` alone. `steer` means active work accepts steering, `reply` means a
correlated pending `ask_owner` is valid, and `close` means exact ownership or
approved orphan recovery permits teardown. `available_actions` never includes
`delegate`; a worker generation handles one assignment only. Every operation
revalidates identity, ownership, mailbox state, and lifecycle immediately before
mutation.

A delegating worker may be blocked while direct worker work is pending and still accept
steering when `steer` is listed. Descendant visibility does not imply authority;
records outside the controller's direct ownership can have an empty action list.

## `blocked` and owner questions

A worker waiting on a valid `ask_owner` reply projects as `blocked` after its ask
turn settles. Answer through the exact direct owner using `reply.worker`.

## `settling`

Examples include an uncompleted task handoff, pending final result delivery,
direct-worker gating, terminal cleanup, result persistence recovery, and startup
or integration handoff. Do not assign another task to a settling worker.

## `unknown`

Unknown is intentional fail-closed behavior. Unreadable, oversized, malformed,
or validation-failing mailbox state is reported with a bounded diagnostic and an
empty `available_actions` list. Do not substitute pane idleness, elapsed time,
model metadata, missing activity, a guessed session, or an old worker identity.

## Inactivity fields

A qualifying `working` worker may also report `stale`, `inactive_ms`, and
`last_activity_at`. This advisory does not change the state or prove a hang.

## See also

- [Lifecycle](../concepts/lifecycle.md)
- [Recovery](../guides/recovery.md)
- [`worker` API](worker.md)
