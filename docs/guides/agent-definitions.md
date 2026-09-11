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
contents or make authorization decisions from it. Managed agents also publish
the conventional active-agent identity and subagent lineage metadata used by
compatible extensions. Permission policy is effective only when the
compatible permission extension is loaded in that Pi session. The permission
extension is optional; Pi Herdsman does not install or depend on it.

## Enable or disable a definition

Definitions are enabled by default. Set `enabled: false` in a matching project
or global overlay to make a definition unavailable without copying the bundled
bundled definition:

```markdown
---
name: reviewer
enabled: false
---
```

The lead effective roster and `/agents definitions` output keep disabled rows and
show their disabled status so the source can be re-enabled. A delegating agent
does not receive disabled definitions in its definition list. A delegating agent
referencing a disabled definition can remain discoverable, but is rejected during
assignment or fresh agent startup with an explicit disabled-definition reason
rather than silently dropping that definition.

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

Independent read-only reviewer.

### `scout`

Fast read-only codebase reconnaissance.

### `generalist`

General-purpose scoped execution agent.

The bundled definitions are portable defaults, not required workflow stages.
Project definitions are for repository-specific policy; global definitions are
for user-specific final policy.

## Create a standalone definition

Create a Markdown file in the global agents directory:

```markdown
---
name: docs-reviewer
description: Read-only documentation reviewer
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

With a non-empty explicit `tools` allowlist, `agent` is inferred unless
explicitly denied. See [Delegation](../concepts/delegation.md).

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

References are resolved from the Markdown file that declares them.

The bundled definitions are `generalist`, `implementer`, `researcher`,
`reviewer`, and `scout`. The session-start agent-definition roster and the
`agent list` result use the same metadata projection.

For exact expansion, deduplication, and caller-file precedence, see
[Handoffs and files](handoffs.md).

## Inspect effective definitions

A lead Pi session can use:

```text
/agents definitions
```

or the model can use:

```json
{ "action": "list" }
```

Both resolve the same effective roster.

The human `Definitions` menu includes bundled, project, and global
participation. Project participation is marked `[project]`; a global override
adds `*`, so `[project] *` means both layers contribute. Model, thinking, and
enabled settings can be changed through the menu, but edits always write global
overrides. `Use default` removes only that field and inherits the next lower
layer or Pi's normal default.

## Override an existing bundled role

Do not copy the complete bundled file just to change one property. Create a
matching partial global definition instead.

See [Customizing bundled agents](customizing-agents.md).

## See also

- [Agent-definition schema](../reference/agent-definition-schema.md)
- [`/agents` commands](../reference/commands.md)
- [Configuration](../reference/configuration.md)
