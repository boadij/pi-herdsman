# Authorize confirmed Manager worktree removal

> **Session identity update:** [ADR 0029](0029-use-immutable-managed-lead-session-identity.md) supersedes all
> takeover and in-place ordinary-continuation decisions in this record.
> Other decisions remain subject to their noted supersessions.

[Documentation index](../README.md)

## Status

Accepted

## Context

[ADR 0013](0013-use-herdr-worktree-removal-for-project-retirement.md) assigns
physical Git-worktree removal to Herdr, but also prohibits a Manager-facing
removal interface. A direct, explicitly confirmed Manager/user entry point can
improve accessibility without introducing another physical deletion
implementation or assignment-retirement path.

## Decision

Herdsman may expose an explicitly requested and human-approved Manager/user
entry point for removing a project checkout. Herdsman validates the exact
current Manager assignment and checkout authority; Herdr remains the physical
worktree lifecycle authority and performs checkout removal without force.

Model-facing worktree-removal requests must not wait for human confirmation.
They return a confirmation-required outcome without initiating removal. Actual
removal is performed only through an explicitly confirmed human action, after
fresh validation of the exact current target.

After authoritative checkout removal, project assignments and pending project
messages continue to retire under [ADR 0019](0019-retire-project-assignments-when-worktrees-are-absent.md).
Exact Manager assignment authority and fail-closed identity validation remain
mandatory.

Worktree removal is distinct from Herdr workspace closure, stopping a Lead, and
assignment-only release through the assigned Lead's confirmed `/takeover`.
Removal preserves the Git branch and Pi conversation; it does not imply task
completion or acceptance.

This supersedes only ADR 0013's prohibition on a Manager-facing removal
interface. It does not supersede ADR 0013's decision that Herdr owns physical
worktree removal or its branch-preservation rationale.

## Consequences

- Confirmation-required results are neither removal outcomes nor durable
  pending-removal records; they confer no authority on a later human action.

- Manager/user access does not add a Git or filesystem deletion authority to
  Herdsman; Herdr remains responsible for removing the worktree.
- Removal requires interactive human approval and current exact assignment
  validation.
- Assignment retirement remains governed by ADR 0019 and existing
  reconciliation; no separate assignment-release path or persistent cleanup
  state is introduced.
- Workspace closure, Lead stopping, and `/takeover` remain separate operations.
