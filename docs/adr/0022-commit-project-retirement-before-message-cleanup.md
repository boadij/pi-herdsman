# Commit project retirement before message cleanup

## Status

Accepted

## Decision

Removal of the exact current `ProjectAssignment`, including assignment-directory
synchronization, commits retirement. Compare identity and remove authority under
the existing global assignment-authority lock, inside the caller's branch lock.
Pending-message cleanup follows that commit and removes only records whose
`fromSessionId` identifies the retired assignment. A cleanup error is reported
without reversing or misreporting committed retirement.

Verified Manager initialization recovers interrupted cleanup from existing
assignment and message records, independently of worktree topology. Recovery
validates record identity against its storage path and holds the global
authority lock across comparison and deletion. It never acquires a branch lock
or restores authority. Uncertain records fail closed.

## Rationale

[ADR 0016](0016-consume-project-messages-after-manager-delivery.md) keeps messages
pending-only; [ADR 0017](0017-use-project-assignments-for-managed-lead-authority.md)
makes assignments the sole authority; [ADR 0019](0019-retire-project-assignments-when-worktrees-are-absent.md)
defines retirement eligibility. Deleting messages before authority can lose a
handoff when retirement fails. Branch-wide cleanup can erase replacement work.
Existing exact session identities and durable records suffice for safe cleanup,
without transaction journals, tombstones, or another persistence schema.

## Limits

If unlink succeeds but directory synchronization fails, propagate the error and
preserve messages; do not recreate authority or claim confirmed retirement.
Filesystem power-loss durability remains platform-dependent. Recovery is
opportunistic at Manager initialization, not a recurring cleanup service.
Retirement does not assert successful task completion or remove sessions,
branches, worktrees, conversations, or Agent ownership.
