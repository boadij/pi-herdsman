# Agent states

[Documentation index](../README.md)

The public state is a safe-control projection built from live lifecycle and
durable assignment/convergence evidence. It is not a raw herdr lifecycle string.

| State      | Meaning                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| `working`  | An assignment is active.                                                                                 |
| `blocked`  | Active assignment waits for owner attention or another condition.                                        |
| `settling` | Assignment handoff, completion/result delivery, launch, direct-agent gate, or cleanup is converging.     |
| `unknown`  | Exact safe control state cannot be proved.                                                               |
| `lost`     | Physical execution is proven absent before a durable terminal result; the assignment remains unresolved. |

## `available_actions` is authoritative

A live agent record in `agent list` includes an `available_actions` snapshot.
Use only operations currently listed there; do not infer control eligibility
from `state` alone. `steer` means active work accepts steering, `reply` means a
correlated pending `ask_owner` is valid, and `close` means exact direct ownership
permits teardown. `available_actions` never includes
`delegate`; an agent generation handles one assignment only. Every operation
revalidates identity, ownership, mailbox state, and lifecycle immediately before
mutation.

A delegating agent may be blocked while direct agent work is pending and still accept
steering when `steer` is listed. Descendant visibility does not imply authority;
records outside the controller's direct ownership can have an empty action list.
Directly owned live records may expose the applicable live controls, including
`close`; directly owned proven `lost` records expose `close` only. Unknown
records and non-direct descendants remain fail-closed with no mutation actions.

## `blocked` and owner questions

An agent waiting on a valid `ask_owner` reply projects as `blocked` after its ask
turn settles. Answer through the exact direct owner using `reply.agent`.

## `settling`

Examples include an uncompleted task handoff, pending final result delivery,
direct-agent gating, terminal cleanup, result persistence recovery, and startup
or integration handoff. Do not assign another task to a settling agent.

## `unknown`

Unknown is intentional fail-closed behavior. Unreadable, oversized, malformed,
or validation-failing mailbox state is reported with a bounded diagnostic and an
empty `available_actions` list. Do not substitute pane idleness, elapsed time,
model metadata, missing activity, a guessed session, or an old agent identity.

`lost` is different: a coherent Herdr inventory proves the expected pane,
session, and run-scoped alias are absent. It is not completion or task failure;
use direct-owner `close` to abandon the unresolved generation.

## Result precedence and actions

A durable terminal result or `result_error` takes precedence over physical
absence and projects as `settling` while delivery or recovery converges. A
failed inventory never proves `lost`; relocated or conflicting evidence is
`unknown`.

| Record    | Direct-owner actions                                                            |
| --------- | ------------------------------------------------------------------------------- |
| `live`    | Existing live controls, including `inspect` and eligible `steer`, plus `close`. |
| `lost`    | `close` only.                                                                   |
| `unknown` | None.                                                                           |

Owned descendants remain visible through proven durable ancestry but do not gain
direct control from that visibility.

## Inactivity fields

A qualifying `working` agent may also report `stale`, `inactive_ms`, and
`last_activity_at`. Qualifying progress includes model streaming and tool
execution boundaries (`tool_execution_start` and `tool_execution_end`), along
with the surrounding turn and message boundaries. Streaming tool updates alone
do not advance `last_activity_at`. This advisory does not change the state or
prove a hang.

## See also

- [Lifecycle](../concepts/lifecycle.md)
- [Recovery](../guides/recovery.md)
- [`agent` API](agent.md)
