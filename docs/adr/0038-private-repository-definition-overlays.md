# Add private repository definition overlays

## Status

Accepted

## Context

Developers may want personal Agent definitions and role profiles available in
all linked worktrees of one local clone without committing them to the shared
project configuration or applying them to unrelated repositories. The existing
definition resolver already composes bundled, global, and trusted project
layers using one schema and validation path.

## Decision

Add an optional private repository layer after trusted project definitions:

```text
bundled < global < trusted project < private repository
```

When a trusted project root is supplied, resolve its Git common directory and
read Agent definitions from `pi-herdsman/agents/` and eligible role profiles
from `pi-herdsman/roles/` beneath that directory. Linked worktrees therefore
share a private layer, while independent clones do not. Do not resolve the
layer without the existing project-trust decision, and keep Chief global-only.
The layer is discovery only: it does not create files or synchronize referenced
skills, scripts, or other workflow assets.

This extends ADR 0037's precedence only. Its trust, composition, validation,
managed-Lead target-worktree, and runtime authority boundaries remain in force.

## Consequences

Private definitions use the existing schema, overlay engine, provenance, and
effective validation. The synchronous Git lookup is bounded and uncached.
Private configuration remains local to the clone and is not portable to a
fresh clone unless separately recreated.

The Coordinator path recorded here is historical; [ADR 0039](0039-use-coordinator-profile-directories.md)
supersedes that path description only. The private-layer precedence, trust
gate, common-directory resolution, and other boundaries remain in force.
