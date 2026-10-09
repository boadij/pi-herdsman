# Use a reserved layered definition for managed project Leads

## Decision

Manager-created project Leads use the reserved `managed-lead` definition for
Pi launch policy.

The definition uses the existing `bundled < project < global` composition
engine. A trusted project layer is resolved from the delegated worktree. The
reserved name is excluded from the Agent roster and cannot be delegated to or
referenced through an Agent `agents` allowlist.

The definition owns configurable launch behavior such as prompt body, model,
thinking, ordinary tools, skills, extensions, and context inheritance. The
bundled default selects no ordinary tools (`tools: []`); mandatory Lead
coordination tools are injected at launch, and overlays can enable direct
tools explicitly. Herdsman still owns and enforces project identity,
supervision, durable Agent ownership,
mandatory Lead coordination tools, handoff behavior, and project/worktree
lifecycle.

At the project boundary, Manager owns project supervision and assignment
boundaries; the assigned Lead owns technical decisions and execution
orchestration. Herdsman's assignment handoff is automatic: when the Lead
successfully delegates or continues managed Agent work, it waits for that herd
run to settle before reporting outcome, validation, and unresolved points.
Settlement and Manager review do not close the assignment.

The effective definition is resolved when Herdsman launches the Lead. It is not
persisted into `ProjectAssignment`, and a live Lead is not hot-reconfigured
when definition files change.

## Rationale

Herdsman already has a layered definition engine and Pi already provides native
launch flags for the settings that need to vary. Keeping a separate hard-coded
managed-Lead prompt/tool policy duplicates those capabilities and lets runtime
guidance drift from actual tool availability.

A reserved definition gives the managed Lead one composable configuration
source while preserving Herdsman's authority boundaries. Resolving it in the
target worktree lets branch-local project policy configure the Lead that
actually owns that work without adding a Manager-facing selector or new durable
state.

## Alternatives considered

- Keep managed-Lead policy in project-assignment prompt text: rejected because
  it duplicates configuration and relies on prose where native tool policy can
  express the boundary structurally.
- Add a separate managed-Lead configuration schema or directory: rejected
  because the existing definition format and precedence already cover the
  required launch settings.
- Persist the effective definition with each project assignment: rejected
  because definitions are launch configuration, while the assignment stores
  durable unresolved project intent.
- Hard-block execution tools in the Lead runtime: rejected because ordinary
  execution capability is intentionally overridable configuration; only
  coordination authority and mandatory role tools are runtime invariants.

## Consequences

The bundled `managed-lead` definition becomes the default managed project-Lead
operating policy. Project and global overlays can deliberately customize it.

Mandatory Herdsman Lead coordination tools are added to explicit tool
allowlists and protected from exclusions, using the same launch-composition
rule that preserves managed-Agent infrastructure.

Ordinary standalone Leads and Agent definitions keep their existing behavior.
Changing a managed-Lead definition affects the next Lead process launch; use the
existing stop/resume lifecycle when a running Lead must pick up changed policy.
