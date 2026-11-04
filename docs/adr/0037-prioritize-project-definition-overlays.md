# Prioritize trusted project definition overlays

## Status

Accepted

## Decision

Definition layers compose in this order:

```text
bundled < global < trusted project
```

Bundled definitions establish shipped defaults, global definitions establish
reusable user-wide defaults, and trusted project definitions are the final
project-specific layer. This applies to Agents and eligible role profiles.

The existing field and body composition, validation, project-trust checks,
Chief global-only restriction, managed-Lead target-worktree resolution, and
Herdsman-owned authority boundaries remain unchanged. In particular, this
decision supersedes ADR 0015's ordering statement only; it does not alter its
managed-Lead architecture.

## Consequences

Conflicting trusted project values now override global values. Global
definitions are defaults, not immutable policy. No migration or compatibility
behavior is provided.
