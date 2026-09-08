# Customizing bundled agents

[Documentation index](../README.md)

Matching project and global definitions partially overlay lower-precedence
roles, in the order `bundled < project < global`.

This allows local customization while continuing to inherit future bundled
changes for omitted fields.

## Minimal model override

```markdown
---
name: reviewer
model: openai-codex/gpt-5.6-luna
thinking: high
---
```

The bundled reviewer body and omitted frontmatter remain inherited.

## Frontmatter merge rules

For a matching higher-precedence definition:

- omitted fields inherit;
- strings and booleans replace;
- arrays replace wholesale, including `[]`;
- the complete effective definition is validated after composition.

`enabled` is a boolean that defaults to `true`. Use it in a minimal override to
disable a bundled role without copying its body or other frontmatter:

```markdown
---
name: reviewer
enabled: false
---
```

The disabled row remains visible to the lead Pi session, while owner-visible
definition lists omit it. A delegating agent referencing a disabled agent can remain
discoverable, but is rejected during assignment or fresh agent startup with an
explicit disabled-agent reason.

## Body composition

An empty higher-precedence body inherits the lower-layer body.

A non-empty overlay body replaces it by default:

```markdown
---
name: reviewer
---

Use this completely different reviewer behavior.
```

Use `bodyMode: append` to preserve the lower-layer body and add local behavior:

```markdown
---
name: reviewer
bodyMode: append
---

Also verify database migrations.
```

When both bodies are non-empty, append mode produces one blank line between the
bundled and override bodies.

`bodyMode` is valid only when a definition overlays an existing lower-layer
definition. Interactive edits in the Definitions UI always write global
overrides.
It is consumed during definition composition and does not become runtime
frontmatter.

## Runtime system-prompt composition

`bodyMode` and `systemPromptMode` solve different problems:

```text
lower-layer body + overlay body
          ↓ bodyMode
effective definition body
          ↓ systemPromptMode
Pi base system prompt
```

`systemPromptMode: replace` sends the effective body as Pi's replacement system
prompt.

`systemPromptMode: append` appends the effective body to Pi's normal system
prompt.

Managed agents additionally receive shared herdr agent guidance at launch,
including the `ask_owner` contract. This shared guidance is infrastructure and
is not copied into every bundled role body.

## Add local body files

```markdown
---
name: reviewer
bodyMode: append
---

@./prompts/local-review-policy.md
```

The path is resolved relative to the declaring project or global file before
body composition, so each layer preserves its own declaring-file provenance.

References expand when each new agent generation is constructed. A session
continuation keeps the saved Pi history but uses the current effective
definition configuration for its new generation.

The Definitions details view re-resolves the selected name when opened, so
metadata and body references reflect current overlays even if configuration
changes while the menu is open.

See [Handoffs and files](handoffs.md).

## Local tools, skills, and extensions

Bundled definitions are portable by design. Add repository-specific
capabilities in a matching project definition, or user-specific final
capabilities in a matching global override.

Example:

```markdown
---
name: reviewer
bodyMode: append
tools: ["read", "bash", "my_local_tool"]
skills: ["/absolute/path/to/code-review/SKILL.md"]
extensions: ["/absolute/path/to/local-extension.ts"]
---

Use my local tool only when it materially improves the review.
```

`extensions` loads the extension code, while `tools` controls which registered
tool names are callable by the model. Extension-provided tools use the same
name-based policy as built-in and custom tools, so an extension tool omitted
from an explicit allowlist is unavailable to the model (and an exclusion wins).
This does not sandbox the extension: its handlers, commands, shortcuts,
providers, and other non-tool behavior may still run.

Pi Herdsman passes this native policy through rather than maintaining a second
tool registry. Provider or conversion integrations can have their own
presentation layer, so their displayed tool set may require separate
integration-level verification; loaded provider code is not sandboxed by this
setting.

An explicit `tools` list controls selection even when `noTools` or
`noBuiltinTools` also selects restrictive defaults, while `excludeTools` wins
over the list. Managed agents retain `ask_owner` as mandatory infrastructure
and remove it from explicit exclusions; this exception does not apply to
unmanaged Pi launches. Same-named tools cannot be permissioned by source, and
collision winner ordering is not promised. Launcher-injected agent and
Herdr-state extensions are separate from definition extensions and remain
available when `noExtensions` disables ordinary discovery.

For an integration-level smoke check, load the repository's
`scripts/tool-policy-diagnostic.mjs` extension and set `POLICY_EVIDENCE`,
`POLICY_LAUNCH`, `POLICY_ACTIVE`, `POLICY_PROVIDER`, and `POLICY_FORBIDDEN` to
the expected tool-name sets before launching Pi with the same `--tools` and
extension arguments as the target agent. The diagnostic asserts the launch
allowlist and active set, records callable provider names and tool-call
outcomes, fails on forbidden active/provider/call names, and can verify an
allowed control with
`POLICY_CONTROL`; it does not capture prompts or secrets. The hook observes
Pi's provider-request payload, not a provider's final HTTP or WebSocket
serialization.

The same diagnostic's no-network negative probe can be run with
`node scripts/tool-policy-diagnostic.mjs --dispatch-check`; it emits a
deterministic forbidden `exec_command` call into an empty tool context and
asserts Pi returns `Tool exec_command not found` without execution.

Remember that arrays replace the bundled array rather than append to it.
Explicitly include every value you want in the effective array.

Skill and extension paths are passed to Pi unchanged; unlike body `@file`
references, herdr does not resolve them relative to the definition file.

## Interactive agent settings

Lead Pi sessions with UI can use:

```text
/agents definitions
```

The native Definitions menu lists bundled, project, and global participation.
Project participation is marked `[project]`; a global override adds `*`, so
`[project] *` means both layers contribute. Select a
definition to open:

```text
Model
Thinking
Enabled
Details…
Back
```

Model and thinking each offer `Use default` plus their available values.
Selecting `Use default` removes only that field. The model chooser stores the
canonical provider/model token; thinking uses the selected model's supported
levels when available. `Enabled` toggles the definition.

Edits always write global overrides, and standalone custom definitions can be
edited through the same flow.

It changes only the selected top-level line in the global Markdown override and
preserves unrelated frontmatter, line endings, and body content.

Removing a saved field from a bundled definition restores its bundled value.
Removing a field from a standalone definition uses Pi's normal default. The
override file is not deleted.

Enable and disable write the scalar `enabled` field in the same global override.
Removing that field inherits the bundled value, or `true` when no source
declares it.

Changes affect future definition delegations and session continuations, whose
runtime configuration comes from the current effective definition. They do not
mutate an already-running agent or the lead Pi session.

## See also

- [Agent-definition schema](../reference/agent-definition-schema.md)
- [`/agents` commands](../reference/commands.md)
- [Agent definitions](agent-definitions.md)
