# Allow opt-in working-directory delegation

[Documentation index](../README.md)

## Status

Accepted

## Context

[PR #114](https://github.com/boadij/pi-herdsman/pull/114) removed unrestricted
working-directory selection so fresh Agents ran in their controller's
directory. [Issue #1048](https://github.com/boadij/pi-herdsman/issues/1048)
identified a need for ordinary Leads to launch fresh Agents elsewhere without
changing who owns or supervises them.

## Decision

Keep controller-directory inheritance as the default. User-wide opt-in adds
an optional execution directory to fresh root delegation on reload. Only an
ordinary Lead may select a different directory. Use the caller's roster and
reject definitions with project or private-repository sources for those
launches. Launch Pi with `--no-approve` so target trust cannot substitute
project resources for the caller's selected configuration.

Use existing ownership, placement and lifecycle contracts. Revalidate the
opt-in and directory before starting the Agent. Historical continuation
still restores the saved identity and directory under
[ADR 0004](0004-separate-delegation-from-continuation.md). The new input
belongs only to fresh delegation under
[ADR 0006](0006-use-operation-specific-semantic-tools.md).

## Consequences

- An execution directory is not a grant of ownership, workspace authority,
  or exclusive access.
- Pi can still load ordinary context files; disabling project resource
  approval is not sandboxing.
- Directory revalidation narrows but does not eliminate filesystem races.
