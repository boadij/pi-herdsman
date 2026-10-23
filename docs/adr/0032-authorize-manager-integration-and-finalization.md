# Authorize Manager integration and source-worktree finalization

[Documentation index](../README.md)

## Status

Accepted

## Context

Manager-driven local integration can avoid leaving completed managed-Lead
worktrees and assignments active after their work has been incorporated. The
existing lifecycle decisions deliberately keep removal and integration
separate: assignment retirement follows authoritative worktree removal or
absence, and neither Lead completion nor that retirement establishes that a
revision was accepted or merged ([ADR 0017](0017-use-project-assignments-for-managed-lead-authority.md),
[ADR 0019](0019-retire-project-assignments-when-worktrees-are-absent.md)).

Manager removal also has its own guarded authorization and repository-scoped
preauthorization; Herdr remains responsible for physical removal and does not
force it ([ADR 0020](0020-authorize-confirmed-manager-worktree-removal.md),
[ADR 0030](0030-project-scoped-manager-removal-approval.md),
[ADR 0031](0031-durable-manager-worktree-removal-approval.md)). Automatically
cleaning up a source worktree after integration therefore needs a distinct,
narrow authorization and positive evidence of integration. It must not turn
removal or assignment retirement into evidence of merge.

## Decision

An explicitly enabled Manager integration permission may authorize local
integration of an exact accepted source commit and automatic finalization of
its exact managed source worktree. This permission is separate from Manager
worktree-removal preauthorization, does not grant general removal authority,
and is disabled by default.

Integration is established only by verifying Git committed ancestry: the
target revision must contain the exact accepted source commit. A successful
command response, source-branch or checkout absence, Herdr removal, assignment
retirement, or Lead completion alone is not proof. The source assignment and
linked checkout must still be the exact authorized objects associated with
that accepted revision.

Automatic cleanup is authorized only after that integration evidence is
verified, and remains subject to the current integration permission and
fresh validation of the exact source and target. Physical removal uses the
existing guarded, non-forced Herdr removal path, followed by the existing
exact-assignment retirement reconciliation. It does not create a parallel
filesystem deletion or assignment-retirement mechanism. If integration is
verified but cleanup is not, the outcome must remain partial; it must not
report finalization as successful.

This is a narrow exception allowing integration-specific authorization to
trigger cleanup after verified ancestry. It does not supersede the existing
rule that checkout absence can retire an assignment without proving
completion, acceptance, or integration.

## Consequences

- Users must opt in to Manager integration; removal preauthorization neither
  enables nor is required for this separate permission.
- Only positive ancestry evidence for the exact accepted commit permits
  merge-triggered cleanup. Ambiguous or missing evidence fails closed.
- Existing Herdr removal safeguards, branch preservation, and assignment
  reconciliation remain authoritative.
- Worktree absence may still retire an assignment under ADR 0019, but that
  lifecycle fact cannot be reported as evidence that the work was integrated.
- Integration and cleanup may complete separately; a cleanup failure remains
  an honest partial outcome eligible for safe retry, not a false success.
