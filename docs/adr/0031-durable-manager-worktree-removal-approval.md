# Durable Manager worktree-removal approval intent

[Documentation index](../README.md)

## Status

Accepted

## Context

ADR 0030 made Manager worktree-removal requests actionable without blocking
model coordination, but kept pending intent only in process memory. Reloading
Pi therefore hid a request even though it had not been dismissed or approved.

## Decision

Pending removal intent is represented by strictly parsed, versioned request and
resolution entries on the active Pi session branch. It survives reload of the
same session branch and is isolated from other sessions and branches. Exact
request IDs distinguish replacement requests and ensure that resolving one
request cannot consume another.

This state records intent only. It conveys no deletion authority and is not a
deletion transaction or cleanup queue. A human must explicitly review and
approve the exact current request. The current Manager authority, repository,
assignment, checkout identity, occupancy, cleanliness, operation locks, and
final removal conditions are revalidated through the existing guarded remover.
Herdr remains the physical remover and all existing uncertain-outcome and
assignment-reconciliation behavior remains in force. Dismissal, confirmation
cancellation, and explicit Manager leave consume the corresponding pending
intent. A new session does not inherit it.

No automatic deletion worker, durable cleanup service, cross-machine approval
bus, or general-purpose approval framework is introduced.

This supersedes only ADR 0030's decision that pending intent is process-local
and does not survive restart. Its repository-scoped preauthorization policy and
all safety decisions remain in force.

## Consequences

- Reloading the same session restores visible pending approval state without
  restoring an old Manager lease as authority.
- A consumed request cannot be replayed into deletion after a crash.
- Pending approvals remain scoped to one Pi session branch and are not shared
  across machines or independent sessions.
