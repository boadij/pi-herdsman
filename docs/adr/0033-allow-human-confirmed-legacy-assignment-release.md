# Allow human-confirmed legacy assignment release

[Documentation index](../README.md)

## Status

Accepted

## Context

[ADR 0019](0019-retire-project-assignments-when-worktrees-are-absent.md)
continues to require authoritative evidence before automatic retirement. Some
historical assignments lack checkout provenance, so surviving unrelated
worktrees can make automatic reconciliation conservatively retain them.

## Decision

An active, lease-verified Manager may explicitly relinquish one legacy
assignment when its checkout provenance is unavailable, the exact assignment
and Manager remain unchanged, fresh Git and Herdr observations are valid, no
checkout uses the assignment branch, and no live target execution is known.
The human must type `forget <branch>` after being told that unobserved execution
cannot be ruled out.

This operation does not claim that the physical checkout is absent. It does not
remove worktrees, stop processes, or change Agent ownership. It retires only the
exact durable assignment using the existing work-project and assignment locks,
retirement path, pending Manager context, and assignment-scoped message cleanup.
Unavailable observations, conflicting identity, a matching checkout, known
live target execution, cancellation, stale assignment, or changed Manager
authority preserve the assignment. Worktree-removal preauthorization does not
apply.

## Consequences

Automatic reconciliation remains the default and is unchanged. Human
confirmation authorizes release of Manager project authority, not proof of
execution absence or physical checkout deletion. The acknowledged residual
risk is that execution not represented by current observations may continue
after authority release.
