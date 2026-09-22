# Agent states

[Documentation index](../README.md)

The public state is a safe-control projection built from live lifecycle and
durable assignment/convergence evidence. It is not a raw herdr lifecycle string.

| State      | Meaning                                                                                                  |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| `working`  | An assignment is active; `stale` remains an advisory field on this state.                                |
| `blocked`  | Active assignment waits for an owner answer or another condition.                                        |
| `settling` | Assignment handoff, completion/result delivery, launch, direct-agent gate, or cleanup is converging.     |
| `unknown`  | Exact safe control state cannot be proved.                                                               |
| `lost`     | Physical execution is proven absent before a durable terminal result; the assignment remains unresolved. |

## `available_actions` is authoritative

A live agent record in `agent list` includes an `available_actions` snapshot.
Use only operations currently listed there; do not infer control eligibility
from `state` alone. `steer` means active work accepts cooperative steering,
`interrupt` means a currently working Pi operation may be preempted,
superseding earlier undelivered steering with replacement direction, `reply`
means a
correlated pending `ask_owner` is valid, and `close` means exact direct
ownership and the current applicable close preflight permit teardown. For a
Lead-owned parent, that preflight includes its owned descendant cascade.
`available_actions` never includes
`delegate`; an agent generation handles one assignment only. Every operation
revalidates identity, ownership, mailbox state, and lifecycle immediately before
mutation.

A delegating agent may be blocked while direct agent work is pending and still accept
steering when `steer` is listed, but it cannot expose `interrupt` without a
currently working Pi operation. Stale or inactive fields are advisory and do
not automatically authorize or recommend interrupt. Descendant visibility does not imply authority;
records outside the controller's direct ownership can have an empty action list.
Directly owned live records may expose the applicable live controls; directly
owned live or proven `lost` records may expose `close` when the applicable close
preflight currently succeeds. They may also expose the read-only `transcript`
action when a materialized persisted Pi session file exists. Unknown records and
non-direct descendants remain fail-closed with no actions.

## `blocked` and owner questions

An agent waiting on a valid `ask_owner` reply projects as `blocked` after its ask
turn settles. Answer through the exact direct owner using `reply.agent`.

A delegating parent can also project as `blocked` while it waits for direct
children. That is progress-capable parent waiting, not evidence that the child
runtime is externally blocked. Recovery attention for `blocked` is reserved for
a live Herdr runtime that reports `blocked` while an active request exists and
no `ask_owner` question is pending.

## `settling`

Examples include an uncompleted task handoff, pending final result delivery,
direct-agent gating, terminal cleanup, result persistence recovery, and startup
or integration handoff. Do not assign another task to a settling agent.

`settling` alone is not timeout-worthy and does not generate generic health
attention. A durable `result_error` within settling may still produce direct
owner attention so the stored persistence recovery can be handled.

## `unknown`

Unknown is intentional fail-closed behavior. Unreadable, oversized, malformed,
or validation-failing mailbox state is reported with a bounded diagnostic and an
empty `available_actions` list. Do not substitute pane idleness, elapsed time,
model metadata, missing activity, a guessed session, or an old agent identity.

When physical identity is ambiguous for an otherwise valid direct-owned record,
Herdsman may emit one generic `unknown` attention event for that unresolved
episode. It does not add mutation actions, prove loss, or broaden `ask_owner`.
When exact physical evidence changes, re-evaluate the record from fresh state.

`lost` is different: a coherent Herdr inventory proves the expected pane,
session, and run-scoped alias are absent. It is not completion or task failure;
use direct-owner `close` to abandon the unresolved generation when the
applicable close preflight succeeds. Lost attention may repeat for the direct
owner while the assignment remains unresolved.

## Result precedence and actions

A durable terminal result or `result_error` takes precedence over physical
absence and projects as `settling` while delivery or recovery converges. A
failed inventory never proves `lost`; relocated or conflicting evidence is
`unknown`.

| Record    | Direct-owner actions                                                                                                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `live`    | `inspect`, eligible `transcript`, `steer`, `interrupt`, `reply`, and `close` when the applicable close preflight succeeds. |
| `lost`    | eligible `transcript` and `close` when the applicable close preflight succeeds.                                            |
| `unknown` | None.                                                                                                                      |

Owned descendants remain visible through proven durable ancestry but do not gain
direct control from that visibility.

## Inactivity fields

A qualifying `working` agent may also report `stale`, `inactive_ms`, and
`last_activity_at`. Qualifying progress includes model streaming and tool
execution boundaries (`tool_execution_start` and `tool_execution_end`), along
with the surrounding turn and message boundaries. Streaming tool updates alone
do not advance `last_activity_at`. This advisory does not change the state or
prove a hang. The first stale attention is eligible after ten minutes without
qualifying progress; if the same condition persists, reminders may repeat at
approximately `5m → 2m30s → 1m15s → 1m`, subject to the 30-second health scan.
Leave healthy or legitimately long-running work alone. Use `transcript` for
persisted evidence and `inspect` for live evidence; stale alone does not justify
`interrupt` or `close`.

## See also

- [Lifecycle](../concepts/lifecycle.md)
- [Recovery](../guides/recovery.md)
- [`agent` API](agent.md)
