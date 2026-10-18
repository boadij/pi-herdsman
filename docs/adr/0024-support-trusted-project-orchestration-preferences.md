# Support trusted project orchestration preferences

## Status

Accepted

## Decision

Durable Herdsman coordination state remains under the resolved Pi agent data
directory, and the global Herdsman configuration remains the source of user
defaults. A trusted project's Pi settings may override only the
`autoActivateManager` and `contextRetirement` preferences in
`<project>/.pi/settings.json`, under `piHerdsman`. Explicit project values
override global values; omitted values inherit them.

These preferences configure behavior but do not establish authority or persist
lifecycle intent. Manager authority and Agent ownership continue to use their
existing contracts. Agent-definition precedence is unchanged. This is a narrow
exception for two project preferences, not a general project-configuration
framework.

This decision narrows ADR 0007's rejection of splitting Herdsman configuration
across project and global settings. Its decision to keep durable coordination
state and the global configuration under Pi agent data remains in force.

## Rationale

Manager auto-start and context retirement are project-sensitive orchestration
preferences, while the global file remains the user's default. Pi's trusted
project settings provide a native, scoped place for those overrides without
moving durable coordination state or changing authority and lifecycle-state
ownership.

## Consequences

- Only trusted project settings can override these two preferences.
- Global values continue to apply when the project is untrusted or a property
  is omitted.
- Other Herdsman configuration fields remain global-only.
- Project and global Agent-definition composition is unaffected.
- No additional durable state or generalized inheritance mechanism is added.
