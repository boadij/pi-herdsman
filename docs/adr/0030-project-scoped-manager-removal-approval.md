# Project-scoped Manager worktree-removal approval

[Documentation index](../README.md)

## Status

Accepted

## Context

ADR 0020 requires an independent human confirmation for each Manager worktree
removal. That prevents blocking model calls, but makes an explicit Manager
request non-actionable without repeating the request through another command.

## Decision

Human confirmation remains the default. A human may preauthorize removal for
one verified repository using Herdsman-owned configuration; this permission is
not inherited from global configuration or repository content. The opt-in
waives only the extra confirmation, never Manager authority, exact assignment
and checkout validation, occupancy or cleanliness checks, Herdr's non-forced
removal, or assignment reconciliation.

Without preauthorization, a model request records process-local pending intent
and returns without waiting or attempting removal. Pending intent is not
permission, does not survive Manager/session lifecycle changes or restart, and
must be consumed by a fresh human action that revalidates the exact target.

This supersedes only ADR 0020's requirement for an independent confirmed
human action for every actual Manager removal. All other safety and retirement
decisions in ADR 0020 remain in force.

## Consequences

- Unanswered requests do not block Manager coordination or retain locks.
- Pending intent cannot authorize deletion by itself.
- Repository policy is separate from ordinary project settings and has no
  repository-content-controlled or global-inherited value.
- Herdr remains the sole physical worktree-removal authority.
