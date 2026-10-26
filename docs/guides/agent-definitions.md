# Agent definitions

[Documentation index](../README.md)

Agent definitions describe an agent's capabilities, not a required
workflow. They are Markdown files containing strict frontmatter plus an optional
prompt body.

This guide covers normal creation and selection. For the complete field contract,
see the [agent-definition schema](../reference/agent-definition-schema.md).

## Sources

Bundled definitions live in:

```text
dist/agent-definitions/
```

Global definitions live by default in:

```text
~/.pi/agent/agents/
```

Project definitions are optional and live in the current project:

```text
<cwd>/.pi/agents/
```

Pi Herdsman discovers project definitions when Pi considers the project
trusted. Precedence is:

```text
bundled < project < global
```

Global definitions remain final user policy. For example:

```text
.pi/
└── agents/
    └── reviewer.md
```

Project definitions apply only to their project cwd, and the Definitions UI
writes global overrides, never project files.

When Pi uses a custom agent directory, the global definitions live under that
agent directory's `agents/` subdirectory.

A project or global definition whose `name` matches a lower-precedence
definition overlays it. An unmatched definition is standalone.

Definition configuration and runtime Agent discovery are separate views. The
Definitions UI and Markdown files expose editable configuration and source
layers. The session-start `agent_definitions` capability summary and
`list_agents` result expose only definitions currently available to that
controller, not source paths or complete frontmatter. They support runtime
selection and validation, not configuration management. Identify definitions
by frontmatter `name`, inspect contributing files, and resolve effective
overlays when changing them; never infer identity from filenames.

`flexible-lead`, `orchestrator-lead`, `managed-lead`, `manager`, and `chief`
are reserved role definitions. They use the layered definition engine but are
not Agents available through discovery or delegation. The first two configure
ordinary Lead runtime instructions and ordinary tools; `managed-lead` configures
launch policy for Manager-assigned project Leads; `manager` and `chief`
customize supervisory role instructions and ordinary tools. They appear under the separate `Role profiles` destination in canonical role
order; ordinary definitions appear under `Agent definitions`. Runtime profiles offer Details only;
`managed-lead` offers Model, Thinking, and Details. See
[customizing role profiles](customizing-agents.md#manager-and-chief-profiles).

### Permission-aware extensions

Agent definitions may include a `permission:` mapping for compatible
permission-aware Pi extensions.

[`pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system)
can consume the same global or trusted project-local agent definition as Pi
Herdsman:

```yaml
---
name: reviewer
tools: ["read", "ls", "find", "grep"]
permission:
  "*": deny
  read: allow
  ls: allow
  find: allow
  grep: allow
---
```

Pi Herdsman accepts and preserves `permission:` but does not evaluate its
contents or make authorization decisions from it. Managed agents publish the
conventional `<active_agent name="<definition>"/>` identity signal and
subagent lineage metadata used by compatible extensions. Herdsman separately
projects current semantic identity and direct-owner context in its
`pi_herdsman_agent` prompt section; this is not an authorization signal.
Permission policy is effective only when the
compatible permission extension is loaded in that Pi session. The permission
extension is optional; Pi Herdsman does not install or depend on it.

## Enable or disable a definition

Definitions are enabled by default. Set `enabled: false` in a matching project
or global overlay to make a definition unavailable without copying the bundled
definition:

```markdown
---
name: reviewer
enabled: false
---
```

The `/agents definitions` UI keeps disabled rows and shows their disabled
status so the source can be re-enabled. Disabled definitions are omitted from
the runtime `agent_definitions` capability summary for Leads and delegating
agents. A definition that requires a disabled or otherwise unavailable child
is also omitted from that summary; a delegating agent referencing such a child
is rejected during assignment or fresh agent startup with an explicit reason
rather than silently dropping the reference.

`delegate` and `continue` reject disabled definitions with an
actionable error. An already active agent may finish and remains controllable
according to its current available actions; disabling a definition does not
mutate that assignment.

## Bundled roster

### `implementer`

Focused source-edit agent for an explicitly approved implementation.

### `researcher`

Focused current/external research agent. Read-only local policy. It also
allows the default web tool names exposed by `pi-web-access`:
`web_search`, `fetch_content`, `get_search_content`, and `source_check`.
Web access is optional. Install it with:

```text
pi install npm:pi-web-access
```

Pi Herdsman does not depend on or install `pi-web-access`. Without those tools,
the researcher retains local inspection capabilities and reports unavailable
external evidence. Normal Pi extension discovery is intentionally enabled for
this role so an installed compatible extension can provide the tools. If
`pi-web-access` is configured with different public tool names, replace the
researcher's `tools` array through a matching project or global overlay.
Extension code itself is not sandboxed by the callable-tool allowlist.

### `reviewer`

Independent read-only internal team reviewer. Findings inform the delegator's
decisions, not user or supervisor approval.

### `scout`

Fast read-only codebase reconnaissance.

### `generalist`

General-purpose scoped execution agent.

The bundled definitions are portable defaults, not required workflow stages.
Project definitions are for repository-specific policy; global definitions are
for user-specific final policy.

### Write useful descriptions

Write `description` for the delegator: state what the Agent can do, when to use
it, and a meaningful boundary where another capability fits better. Prefer
concrete tasks over generic role labels. Descriptions guide selection; they do
not grant tools or dictate workflows. Keep them accurate when overrides change
capabilities, and qualify optional integrations.

## Create a standalone definition

Create a Markdown file in the global agents directory:

```markdown
---
name: docs-reviewer
description: Read-only documentation reviewer for correctness, navigation, and examples; use to verify documentation changes before publication
model: openai-codex/gpt-5.6-luna
thinking: medium
systemPromptMode: replace
noSkills: true
noExtensions: true
tools: ["read", "ls", "find", "grep"]
---

Review documentation for correctness, navigation, duplication, and broken
examples. Do not edit files.
```

Read-only behavior must be enforced by the effective tool policy, not only by
prompt text. For normal filesystem inspection, explicitly allow `read`, `ls`,
`find`, and `grep`, and omit mutation-capable tools such as `bash`,
`powershell`, `edit`, and `write`. Disable extension discovery when the role
does not need extension-provided capabilities.

The `name` is authoritative; the filename itself is not the public definition
name.

## Allow direct agents

```markdown
---
name: coordinator
tools: ["read", "bash"]
agents: ["scout", "researcher"]
---

Coordinate the assigned analysis and integrate direct agent results.
```

The effective roster is validated atomically. Every `agents` name must exist.
Bundled role descriptions communicate each role's purpose and selection boundary;
the active controller contract remains authoritative for delegation behavior.

A non-empty `agents` list is required but does not alone enable delegation;
the effective tool policy also governs eligibility. Every managed agent retains
mandatory `ask_owner`, and Agent-started agents are leaves. See
[Delegation](../concepts/delegation.md) for the ownership model and the
[agent-definition schema](../reference/agent-definition-schema.md#managed-agent-coordination-tools)
for the exact tool-policy rules.

## Add body files

A body line that consists only of one supported reference includes that file:

```markdown
---
name: docs-reviewer
---

Use the following additional policy.

@./prompts/docs-policy.md
```

Supported forms:

```text
@./relative.md
@../relative.md
@/absolute/path.md
@~/home-relative.md
```

On Windows, the native backslash forms are also supported, including
`@.\relative.md`, `@..\relative.md`, `@~\home-relative.md`, rooted paths,
drive-rooted paths, and UNC paths. References use the host platform's native
path resolution rules.

References are resolved from the Markdown file that declares them.

Startup discovery and `list_agents` provide runtime Agent capabilities, not a
complete configuration view. For their exact contract, see the
[`list_agents` reference](../reference/agent.md#list_agents); use the workflow
below to inspect and manage definition configuration.

For configuration management, inspect bundled, trusted project, and global
Markdown layers in precedence order (`bundled < project < global`), identify
the target by frontmatter `name`, resolve overlays, and edit the smallest
correct project or global file. Never edit bundled definitions. Use
`list_agents` after an edit when available to invoke normal discovery and
validation, but do not treat its reduced summary as the full effective
configuration or claim runtime validation when the tool is unavailable.

For exact expansion, deduplication, and caller-file precedence, see
[Handoffs and files](handoffs.md).

## Inspect effective definitions

A lead Pi session can use:

```text
/agents definitions
```

or the model can use:

```json
{}
```

Both use effective definition discovery, but the Definitions UI exposes
configuration (including disabled definitions and reserved role profiles where
applicable), while `list_agents` returns only currently available capabilities
within the caller's scope.

For model-assisted definition management, ask Pi directly or explicitly invoke
`/skill:agent-definitions`. The bundled skill uses the same
project/global Markdown definitions and existing Herdsman validation rather than
a separate configuration interface.

The human `Definitions` menu separates ordinary definitions under `Agent
definitions` from reserved profiles under `Role profiles` (in canonical role
order). Runtime profiles provide Details only. Each row identifies its contributing source or
sources as `bundled`, `project`, and/or `global`. Model, thinking, and enabled
settings can be changed through the menu, but edits always write global
overrides. `Inherit current session` removes only that field. Unset model and
thinking fields inherit the spawning controller for fresh delegation, while
continuation restores the saved session's settings. Contextual help updates for
the selected row.

## Override an existing bundled role

Do not copy the complete bundled file just to change one property. Create a
matching partial global definition instead.

See [Customizing bundled agents](customizing-agents.md).

## See also

- [Agent-definition schema](../reference/agent-definition-schema.md)
- [`/agents` commands](../reference/commands.md)
- [Configuration](../reference/configuration.md)
