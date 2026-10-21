# Deliver worktree retirement through pending Manager context

> **Session identity update:** [ADR 0029](0029-use-immutable-managed-lead-session-identity.md) supersedes all
> takeover and in-place ordinary-continuation decisions in this record.
> Other decisions remain subject to their noted supersessions.

## Status

Accepted

## Decision

The active-assignment namespace remains the authority boundary. Verified
worktree retirement atomically renames the exact assignment into pending context
storage outside that namespace, rather than deleting its evidence. This
supersedes only ADR 0022's worktree-retirement deletion decision; confirmed
`/takeover` retains exact assignment deletion and emits no retirement notice.
Commit-before-cleanup ordering and assignment-scoped handoff cleanup remain.

Pending retirement context belongs to the verified repository Manager role,
not a destination process. The existing inbox delivers factual context through
Pi without waking or steering the Manager. The same delivery path runs after
pre-turn reconciliation so the starting request includes newly discovered
retirement. Active runs are not interrupted.

Pi history owns delivered context, as in
[ADR 0016](0016-consume-project-messages-after-manager-delivery.md).
After retired-assignment handoff cleanup succeeds, exact notice receipts or
matching successful removal tool results prove awareness and permit consumption.
There is no permanent retirement log or separate acknowledgment database; a
crash between delivery and consumption can replay context to a replacement
Manager.

[ADR 0017](0017-use-project-assignments-for-managed-lead-authority.md)'s exact
assignment authority and [ADR 0019](0019-retire-project-assignments-when-worktrees-are-absent.md)'s
verified checkout-absence requirements are unchanged. Herdsman's retirement
operation does not itself delete Git branches or Pi conversations; external
actors may independently remove them. Retirement does not establish task
completion, acceptance, merge, or discard.
