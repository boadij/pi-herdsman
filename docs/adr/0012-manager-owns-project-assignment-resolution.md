# Manager owns project assignment resolution

## Decision

- An existing project assignment represents unresolved project work; absence of
  the assignment means the work is resolved.
- Only the Manager's `staff_complete` or `staff_discard` operation removes a
  project assignment.
- Settled project herd runs may automatically emit nonterminal handoffs to the
  Manager; these handoffs do not resolve the project assignment.
- Project Lead messages are nonterminal coordination and review handoffs.
- Messages from an assigned Lead to Manager are retained with the project and
  remain available across Manager absence and turnover.
- Supervisor decisions and responses use normal messages rather than persisted
  ask/reply correlation.
- Stopping project execution does not resolve its assignment.

## Rationale

Project implementation commonly includes multiple review and correction
rounds, so implementation readiness is not equivalent to fulfilled work. The
Manager owns the project-level acceptance or abandonment decision; a Lead
reports progress and hands work back for review. Retaining assigned Lead
messages at project scope allows coordination to survive Manager turnover
without making delivery depend on a Manager session.

Persisted ask/reply correlation and Lead-declared terminal results add protocol
state that does not represent project ownership or completion. Assignment
existence provides the durable lifecycle, while runtime placement remains
derived from current Pi and Herdr evidence, consistent with
[ADR 0002](0002-persist-intent-and-derive-runtime-state.md).

## Alternatives rejected

- Let the Lead declare project completion: rejected because implementation
  readiness cannot decide project fulfillment across review rounds.
- Persist correlated supervisor questions and replies: rejected because normal
  messages carry decisions without a second state machine.
- Infer completion automatically from Lead status or message content: rejected
  because the Manager must make the terminal project decision.
- Persist worktree placement in the assignment: rejected because Pi session
  metadata and current Herdr topology provide the reconstruction evidence.

## Consequences

Manager must use `staff_complete` to accept fulfilled work;
`staff_discard` remains the explicit abandonment operation. `staff_stop`
preserves an open assignment. Retained project messages may be delivered to a
replacement Manager, and project-message history is removed when its assignment
is resolved.
