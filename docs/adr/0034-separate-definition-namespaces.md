# Separate Agent and role-profile namespaces

## Status

Accepted

## Decision

Delegable Agent definitions and reserved role profiles use separate bundled,
global, and trusted-project directories. They retain the shared Markdown
definition engine, layering, and provenance. Category validation keeps reserved
role names out of Agent directories and other names out of role-profile
directories. Chief remains global-only.

Bundled Agents and Roles live in `extension/agents/` and `extension/roles/`
in source, and `dist/agents/` and `dist/roles/` in the package. Global
Agents use `<agentDir>/agents/`; global Roles use
`<agentDir>/pi-herdsman/roles/`. Trusted projects use `.pi/agents/` and
`.pi/pi-herdsman/roles/`, respectively.

This narrows ADR 0015's rejection of a separate directory: a distinct namespace
does not require a separate schema or composition engine. Its managed-Lead
launch-policy decision remains in force. ADR 0018's execution-profile and
runtime authority boundaries are unchanged.

## Rationale and consequences

Separate namespaces make delegation and role configuration distinct without
duplicating the definition mechanism. Existing role overrides in Agent
directories are not recognized as role profiles; there is no legacy fallback.

The Coordinator directory names recorded here are historical; [ADR 0039](0039-use-coordinator-profile-directories.md)
supersedes those path descriptions only. This ADR's separate-namespace,
shared-engine, validation, and Chief-scope decisions remain in force.
