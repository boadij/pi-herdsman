# Agent states

[Documentation index](../README.md)

The public state is a safe-control projection built from live lifecycle and
durable assignment/convergence evidence. It is not a raw herdr lifecycle string.

| State      | Meaning                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `working`  | An assignment is active; `stale` remains an advisory field on this state.                                             |
| `blocked`  | Active assignment waits for an owner answer or another condition.                                                     |
| `settling` | Assignment handoff, completion/result delivery, launch, direct-agent gate, or cleanup is converging.                  |
| `unknown`  | Exact safe control state cannot be proved, including an idle restored conversation with an unresolved active request. |
| `lost`     | Physical execution is proven absent before a durable terminal result; the assignment remains unresolved.              |

## `available_tools` is authoritative

A live agent record in `list_agents` includes an `available_tools` snapshot.
Use only tools currently listed there; do not infer control eligibility
from `state` alone. `steer_agent` means active work accepts cooperative steering,
`interrupt_agent` means a currently working Pi operation may be preempted,
superseding earlier undelivered steering with replacement direction,
`reply_agent` means a correlated pending `ask_owner` is valid, and
`close_agent` means exact direct ownership and the current applicable close
preflight permit teardown. For a
Lead-owned parent, that preflight includes its owned descendant cascade.
`available_tools` never includes `delegate_agent`; an agent generation handles one assignment only. Every operation
revalidates identity, ownership, mailbox state, and lifecycle immediately before
mutation.

A delegating agent may be blocked while direct agent work is pending. That
projection alone does not prove the parent execution is live: an idle restored
parent is not steerable. `steer_agent` is listed only while the managed
execution is currently reported as working; `interrupt_agent` also requires a
currently working Pi operation. Stale or inactive fields are advisory and do
not automatically authorize or recommend interrupt. Descendant visibility does not imply authority;
records outside the controller's direct ownership can have an empty action list.
Directly owned live records may expose the applicable live controls; directly
owned live or proven `lost` records may expose `close_agent` when the applicable close
preflight currently succeeds. They may also expose the read-only `read_agent_transcript`
action when a materialized persisted Pi session file exists. Unknown records and
non-direct descendants remain fail-closed with no actions.

## `blocked` and owner questions

An agent waiting on a valid `ask_owner` reply projects as `blocked` after its ask
turn settles. Answer through the exact direct owner using `reply_agent` with the exact `agent` identity.

A delegating parent can also project as `blocked` while it waits for direct
children. This records the durable dependency, not proof that the parent process
is currently making progress. `steer_agent` is available only if the parent is
currently reported as working. Recovery attention for `blocked` is reserved for
a live Herdr runtime that reports `blocked` while an active request exists and
no `ask_owner` question is pending.

## `settling`

Examples include an uncompleted task handoff, pending final result delivery,
direct-agent gating, terminal cleanup, result persistence recovery, and startup
or integration handoff. Do not assign another task to a settling agent.

If owner-side revalidation or import of an explicitly forwarded result artifact
fails, the durable completion remains pending and undelivered; delivery retries
automatically and fails closed. While the state is `settling`, `list_agents`
exposes the current error as `cleanup_error`. Restoring access to the same
artifact permits delivery. Do not substitute evidence or acknowledge success.
There is no permanent-loss classification, retry limit, timeout, or automatic
escalation for this condition.

`settling` alone is not timeout-worthy and does not generate generic health
attention. A durable `result_error` within settling may still produce direct
owner attention so the stored persistence recovery can be handled.
An idle Pi lifecycle with an active request is not evidence of a pending
completion or a live managed execution; it projects as `unknown` unless an
explicit handoff, completion, or recovery operation is pending. A restored Pi
conversation preserves history, not the identity or liveness of its former
managed execution.

## `unknown`

Unknown is intentional fail-closed behavior. Unreadable, oversized, malformed,
or validation-failing mailbox state is reported with a bounded diagnostic and an
empty `available_tools` list. Do not substitute pane idleness, elapsed time,
model metadata, missing activity, a guessed session, or an old agent identity.

When physical identity is ambiguous for an otherwise valid direct-owned record,
Herdsman may emit one generic `unknown` attention event for that unresolved
episode. It does not add mutation actions, prove loss, or broaden `ask_owner`.
When exact physical evidence changes, re-evaluate the record from fresh state.

`lost` is different: a coherent Herdr inventory proves the expected pane,
session, and run-scoped alias are absent. It is not completion or task failure;
use direct-owner `close_agent` to abandon the unresolved generation when the
applicable close preflight succeeds. Lost attention may repeat for the direct
owner while the assignment remains unresolved.

## Result precedence and actions

A durable terminal result or `result_error` takes precedence over physical
absence and projects as `settling` while delivery or recovery converges. A
failed inventory never proves `lost`; relocated or conflicting evidence is
`unknown`.

| Record    | Direct-owner actions                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `live`    | `inspect_agent`, eligible `read_agent_transcript`, `steer_agent`, `interrupt_agent`, `reply_agent`, and `close_agent` when the applicable close preflight succeeds. |
| `lost`    | eligible `read_agent_transcript` and `close_agent` when the applicable close preflight succeeds.                                                                    |
| `unknown` | None.                                                                                                                                                               |

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
Leave healthy or legitimately long-running work alone. Use `read_agent_transcript` for persisted evidence and `inspect_agent` for live evidence; stale alone does not justify `interrupt_agent` or `close_agent`.
The stale episode is defined by its active request and last qualifying activity;
first-attention diagnosis is bounded, and repeated reminders do not automatically
repeat the live capture.

## See also

- [Lifecycle](../concepts/lifecycle.md)
- [Recovery](../guides/recovery.md)
- [Agent tools](agent.md)
