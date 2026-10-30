# Separate assignment handles from checked-out branches

## Status

Accepted

## Context

Managed project work has a branch-scoped public selector, an exact Pi session,
and a physical Git checkout. Treating the branch currently checked out in that
worktree as all three identities makes an ordinary branch switch look like a
different or missing assignment. It can also confuse the source selected for
integration with the assignment used to address the Lead.

This decision refines the branch-scoped assignment semantics in
[ADR 0017](0017-use-project-assignments-for-managed-lead-authority.md) and
[ADR 0029](0029-use-immutable-managed-lead-session-identity.md). It does not
replace exact-session authority or the retirement boundary in
[ADR 0019](0019-retire-project-assignments-when-worktrees-are-absent.md).

## Decision

Keep these facts distinct:

1. **Assignment handle:** the repository plus the original assignment branch
   is the durable, branch-scoped selector used by Manager project operations.
   It remains unchanged when the Lead checks out another branch.
2. **Managed session:** authority remains bound to the exact assigned Pi
   session and its immutable managed-session identity. A matching branch name
   does not authorize another session.
3. **Physical checkout:** the assignment's linked worktree is established
   independently from verified checkout provenance and current Git/Herdr
   observations. A branch name, directory label, or repository match alone is
   not proof that a session occupies the assigned checkout.
4. **Checked-out branch:** the named branch currently at that verified
   checkout's `HEAD` is mutable observed Git state, not assignment identity.
   A branch switch, rename, or deletion does not by itself transfer authority
   or retire the assignment. Missing or contradictory placement evidence
   remains unknown or conflicting and fails closed.
5. **Branch-sensitive operations:** operation targets continue to use the
   assignment handle, but integration acts on the actual named source branch
   at the verified checkout and validates the accepted source SHA. Detached
   or changed source state cannot be silently substituted. Removal remains
   authorized against the exact assigned checkout and existing approval,
   cleanliness, occupancy, and Herdr safeguards; it is not permission to
   remove whichever checkout happens to use the assignment branch name.
6. **Retirement:** retire the exact assignment only after successful removal
   of its checkout or authoritative verification that the checkout is absent.
   A changed checked-out branch is not evidence of absence; failed, partial,
   or ambiguous inventory preserves the assignment.

Resume reuses the existing verified checkout and exact Pi session without
switching its Git branch, replacing the session, or re-keying the assignment.

## Consequences

- Branch-scoped Manager selectors remain stable across branch changes.
- Exact session and physical checkout evidence remain independent authority
  checks; uncertainty does not grant actionability.
- Integration and removal remain branch-sensitive where their effects require
  it, while assignment lookup remains stable.
- Assignment retirement continues to follow ADR 0019's verified-absence
  boundary; no completion or acceptance is inferred from retirement.
