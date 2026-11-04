# Use Coordinator profile directories

## Status

Accepted

## Context

Agent definitions and reserved profiles share the definition engine but have
different purposes. The former `roles/` paths made profile configuration look
nested in the Agent namespace even though the categories are siblings. Keep
Agent paths unchanged for interoperability with other Pi extensions, and give
the reserved profiles a canonical Coordinator namespace.

## Decision

Use sibling `agents/` and `coordinators/` directories for definition files:

| Scope              | Agents, unchanged                      | Coordinator profiles                         |
| ------------------ | -------------------------------------- | -------------------------------------------- |
| Bundled source     | `extension/agents/`                    | `extension/coordinators/`                    |
| Package            | `dist/agents/`                         | `dist/coordinators/`                         |
| Global             | `<agentDir>/agents/`                   | `<agentDir>/coordinators/`                   |
| Trusted project    | `.pi/agents/`                          | `.pi/coordinators/`                          |
| Private repository | `<git-common-dir>/pi-herdsman/agents/` | `<git-common-dir>/pi-herdsman/coordinators/` |

The existing five profile identities remain `flexible-lead`,
`orchestrator-lead`, `managed-lead`, `manager`, and `chief`. They continue to
configure existing Lead, Manager, and Chief behavior; profile files do not
grant or establish authority. Internal runtime role identifiers and the
shared definition engine remain unchanged.

Preserve the existing precedence `bundled < global < trusted project < private
repository`, project trust boundary, Chief global-only restriction, validation,
composition, provenance, and relative body-reference behavior. No legacy
`roles/` fallback is introduced. Coordinator discovery reports an actionable
migration error when active Markdown profiles remain in an applicable global,
trusted-project, or resolved private-repository legacy directory. Empty legacy
directories and `.example.md` templates are ignored; Agent discovery remains
independent. Do not automatically move, copy, or delete user files. Direct users
to move the profile files and their relative prompt assets to the matching
`coordinators/` location and to update symlinks.

Use “Coordinators” in the user-facing Definitions menu and documentation. Keep
the existing definition-management skill identity and invocation contract.

## Consequences

The path change is intentionally breaking for customized profiles; the
discovery diagnostic and migration guidance identify the required moves without
acting on user data. Agent-definition locations and Agent interoperability are
unchanged. The historical path descriptions in [ADR 0034](0034-separate-definition-namespaces.md)
and [ADR 0038](0038-private-repository-definition-overlays.md) are superseded
only for Coordinator directory names by this decision; their namespace,
precedence, trust, and authority decisions remain in force.
