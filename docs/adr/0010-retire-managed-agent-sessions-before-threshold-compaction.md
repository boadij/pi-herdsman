# Retire managed Agent sessions before threshold compaction

## Decision

When `contextRetirement` is enabled, Pi Herdsman will treat automatic context
pressure on an active managed Agent as a lifecycle boundary before normal
threshold compaction occurs.

When Pi requests automatic compaction for reason `threshold`, Herdsman will use
Pi's native pre-compaction lifecycle to persist the session's retirement state
and cancel that compaction.

The retired Agent keeps its uncompacted working context and may finish only the
current coherent operation, resolve work already in flight, perform work needed
for a reliable handoff, and complete the assignment with a self-contained
result. It must converge toward completion rather than expand the assignment or
begin unrelated work.

The retirement state is durable session state. While context retirement is
enabled, a retired managed session is not eligible for historical
`agent_continue`; follow-up work must use a fresh Agent with the relevant
handoff, result, and files.

Model-visible retirement guidance must remain durable conversation history.
When Pi defers appending queued guidance until after the active run, Herdsman
may bridge it into the next provider request once so retirement takes effect
without waiting for that append. This one-request bridge is not repeated
injection; later requests use durable history. Any later reinforcement should
extend the history rather than rewrite it, in accordance with ADR 0009.

Manual compaction does not trigger retirement.

Actual overflow remains a recovery case rather than normal preventive
compaction. Overflow records retirement but does not prevent Pi from using its
native emergency compaction behavior when that recovery is required.

Disabling `contextRetirement` remains an explicit opt-out from the retirement
policy, including enforcement of existing retirement markers.

## Rationale

The purpose of context retirement is to preserve the Agent's detailed working
state long enough to finish coherently and hand that state back to its owner.

Normal compaction intentionally replaces older conversation detail with a
summary. Allowing threshold compaction before retirement would therefore
discard some of the information that retirement exists to preserve.

Pi already exposes the correct native boundary: `session_before_compact` runs
before compaction and can cancel it. Herdsman can therefore interpret the
preventive threshold as a signal to retire the managed Agent rather than
introducing a parallel context-pressure mechanism.

This also preserves the behavior already established by Herdsman: preventive
threshold compaction is suppressed while the active assignment finalizes,
manual compaction is not treated as retirement, and overflow recovery remains
available.

Retirement guidance is behavioral context and should be visible to the model.
Pi may defer a queued message while a run is active, so Herdsman bridges the
instruction once into the next provider request when necessary. Durable
model-visible history represents the transition for subsequent requests and
follows ADR 0009; repeated transient injection would unnecessarily reduce
prompt-cache continuity.

Overflow is intentionally different from threshold pressure. At threshold,
Herdsman still has enough context capacity to finish deliberately. During a
true overflow, preserving every token can make another model request
impossible, so Pi's native emergency recovery must remain available.

## Alternatives considered

- Allow threshold compaction and retire afterward: rejected because the Agent
  would lose detail before producing the handoff retirement is intended to
  preserve.
- Terminate the Agent immediately when the threshold is reached: rejected
  because unfinished coherent work and valuable working state would be lost.
- Disable Pi compaction entirely for managed Agents: rejected because overflow
  recovery remains necessary and Pi already provides the appropriate
  cancellable lifecycle boundary.
- Continue injecting retirement guidance transiently into every provider
  request: rejected because a one-request bridge is sufficient to cover Pi's
  deferred append while preserving durable history and prompt-cache continuity.
- Cancel overflow compaction as well as threshold compaction: rejected because
  an actual overflow may require context reduction before any further provider
  request can succeed.

## Consequences

An active managed Agent that reaches the normal automatic threshold enters
retirement instead of being compacted.

Repeated threshold-compaction attempts during the same active retired
assignment remain suppressed. The retirement marker is written once.

The Agent may temporarily operate above Pi's normal preventive threshold, so
retirement behavior must minimize nonessential work and converge promptly on a
handoff.

The full pre-retirement context remains available unless a genuine overflow
requires Pi's recovery path.

Retirement instructions become part of durable model-visible session history.
A one-request bridge ensures prompt delivery when Pi has not appended queued
guidance before the next request; it is consumed once and does not become a
moving request-local suffix.

Completed retired sessions require fresh delegation for follow-up while context
retirement remains enabled.

The implementation continues to use Pi's native lifecycle contracts, consistent
with ADR 0008, and its model-visible context changes must follow ADR 0009.
