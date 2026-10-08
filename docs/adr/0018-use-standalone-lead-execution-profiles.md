# Use standalone Lead execution profiles

## Status

Accepted

## Decision

Ordinary Lead execution has two modes: `Flexible` and `Orchestrate`. Each maps
one-to-one to a standalone reserved definition: `flexible-lead` and
`orchestrator-lead`. The definitions do not compose or inherit from one
another. Flexible's bundled definition leaves ordinary tools unspecified so
Pi's normal selection remains the baseline; Orchestrate provides
orchestration-first instructions and a conservative ordinary-tool policy.

Manager-assigned Leads use only the standalone `managed-lead` launch
definition. Ordinary execution preference is session state separate from
role/authority state. A session's ordinary tool baseline is retained
independently of the currently projected profile so a restrictive profile
does not replace that baseline.

Execution profiles own only runtime execution instructions and ordinary tool
projection. Lead invariants remain runtime-owned. Pi's native active-tool and
structured-prompt-section APIs project the selected profile into the running
Lead session.

`ProjectAssignment` remains the sole source of Manager authority, and Agent
ownership remains governed by the existing durable ownership model. Confirmed
`/takeover` removes the assignment and pending project messages, then continues
the session as an ordinary Lead in Orchestrate mode. This does not reverse
authority or ownership semantics.

## Rationale

Ordinary Lead users need a direct choice between flexible work and an
orchestration-first strategy, while Manager-created project Leads retain their
existing launch-policy boundary. Keeping the three definitions independent
avoids introducing inheritance solely to share a small amount of instruction
text. Separating execution preference and its ordinary tool baseline from role
state prevents a runtime profile from changing authority or losing the user's
normal tool selection.

The existing definition engine and Pi runtime APIs provide the needed
configuration and projection mechanisms. This decision complements
[ADR 0015](0015-use-reserved-definition-for-managed-project-leads.md)
for managed-Lead launch policy and preserves
[ADR 0017](0017-use-project-assignments-for-managed-lead-authority.md) for
Manager authority.

## Consequences

- Runtime profiles may change execution instructions and ordinary active-tool
  selection, but not launch-time model, thinking, extensions, skills, or
  context inheritance.
- Manager-assigned Leads remain governed by `managed-lead`, irrespective of an
  ordinary execution preference.
- A confirmed takeover releases Manager authority and applies ordinary
  Orchestrate execution without restarting the Pi process or changing its
  launch-time properties.
- Project assignments and durable Agent ownership remain independent of Lead
  execution mode.
