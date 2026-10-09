# Retire project assignments when worktrees are absent

[Documentation index](../README.md)

## Status

Accepted on 2026-10-09; implementation pending in
[issue #330](https://github.com/boadij/pi-herdsman/issues/330).
At this decision point, `v0.22.1` still implements the earlier
event-only retirement and missing-worktree recovery rules.

## Context

A `ProjectAssignment` is a durable Manager-to-Lead authority edge, but it is
not a long-term backlog or record of finished project work. On 2026-10-09,
four assignments remained `paused` after the user removed their worktrees
using Herdr's Remove Worktree action. The exact failure boundary was not
established.

[ADR 0013](0013-use-herdr-worktree-removal-for-project-retirement.md) relies
on observing a successful Herdr removal event and intentionally preserves
assignments when a checkout is otherwise missing, allowing
`resume_project` to recreate it. Herdr events are not durable, so a missed
notification can leave an assignment indefinitely, even after the checkout
has been deleted. That recovery policy does not match the intended meaning
of project assignments as *currently managed work*.

## Decision

A project assignment remains managed only while its associated Git worktree
exists. A stopped Lead, closed Herdr workspace, or replaced Manager does
not end the assignment while the checkout still exists. Lead settlement,
review, and ordinary conversation are also nonterminal.

Retire the matching assignment and its still-pending project messages when
either of these is authoritative:

- Herdr reports successful removal of the matching linked worktree.
- Complete, trustworthy repository/worktree evidence establishes that the
  assignment's checkout no longer exists, even if a removal event was missed
  or the checkout was removed outside Herdr.

A missing *open workspace* is not a missing *worktree*. A failed or partial
inventory, disconnected Herdr instance, ambiguous repository or branch
identity, or out-of-scope machine is not proof of deletion. In-flight
worktree creation or restoration must not be mistaken for an abandoned
checkout. Until absence is verified, preserve the assignment and fail
closed rather than deleting it speculatively.

Retirement must target the exact current assignment; concurrent replacement
assignments and unrelated projects remain protected. It ends Manager
authority for that assignment without deleting its Git branch, Pi session,
conversation, or unrelated work. It does not imply that the task was
completed, accepted, merged, or discarded.

After authoritative checkout absence retires an assignment,
`resume_project` cannot reconstruct that *retired assignment*. A later
delegation can start new managed work from the remaining Git branch. The
branch and historical conversation are not erased.

## Rationale

Checkout existence expresses whether the user is still maintaining that
branch as a managed working area. Treating the assignment as current work,
rather than a durable project archive, makes the Manager overview useful
and repairs orphaned assignments after missed lifecycle notifications,
restarts, and manual checkout removal.

This deliberately gives up automatic recovery of an old assignment after
confirmed checkout deletion. Retaining Git history and Pi conversations
preserves useful work without retaining obsolete Manager authority.

## Alternatives and boundaries

- **Require an observed Herdr removal event:** insufficient because events
  can be lost and external checkout removal has no Herdsman notification.
- **Retire on workspace closure or observation failure:** unsafe because the
  checkout may still exist or evidence may be temporarily unavailable.
- **Require manual orphan cleanup:** useful as a separate user-control
  capability if needed, but not a substitute for correct automatic lifecycle
  reconciliation.

This supersedes ADR 0013's event-only retirement and missing-checkout
recovery decisions, and extends the retirement boundary in
[ADR 0017](0017-use-project-assignments-for-managed-lead-authority.md).
ADR 0017's exact-session authority checks and confirmed `/takeover` path
remain unchanged. The existing user-facing guides and runtime contracts
must be updated alongside the implementation; this ADR alone does not
change shipped behavior.
