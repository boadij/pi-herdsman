# Customizing bundled agents

[Documentation index](../README.md)

Matching project and global definitions partially overlay lower-precedence
roles, in the order `bundled < project < global`.

This allows local customization while continuing to inherit future bundled
changes for omitted fields.

## Lead execution profiles

The reserved `flexible-lead` and `orchestrator-lead` definitions configure
ordinary, unassigned Lead sessions. The session's persisted execution mode
selects exactly one: `flexible` uses `flexible-lead`; `orchestrate` uses
`orchestrator-lead`. These are standalone runtime profiles, not Agents or
launch definitions, and they never inherit from or compose with one another.
They can customize instructions and ordinary tool selection only. Their
frontmatter supports `name`, `description`, `body`, `tools`, and
`excludeTools`; `bodyMode` is supported on matching overlays. Fields affecting
model, thinking, system-prompt launch mode, skills, extensions, context
inheritance, or Agent/permission policy are not supported.

The bundled `flexible-lead` leaves `tools` unspecified, preserving Pi's normal
ordinary tool baseline, and supplies flexible direct/delegated-work guidance.
The bundled `orchestrator-lead` selects `read`, `ls`, `find`, and `grep` and
guides the Lead to delegate bounded execution whenever an Agent can reasonably
own it. Example user overlay:

```markdown
---
name: orchestrator-lead
bodyMode: append
tools: ["read", "ls", "find", "grep", "bash"]
---

Use the repository's documented smoke command when validating integration work.
```

An explicit tool list selects registered ordinary tools; exclusions are then
applied. Herdsman-owned tools cannot be enabled through a profile, and required
Lead coordination tools are retained. A configured tool that is not registered
is simply unavailable. Profile resolution respects project trust. Definition
changes take effect when the profile is next resolved: at session start/resume,
or when a user explicitly selects an execution mode with `/lead` (including
reselecting the current mode).

Ordinary Leads persist their execution mode separately from role/authority
state and retain their ordinary tool baseline while a restrictive profile is
active. The user-wide `defaultLeadExecution` setting seeds future ordinary
sessions only; it does not replace a saved session choice. Assigned project
Leads use `managed-lead` instead.

## Managed project Lead

`managed-lead` is the reserved definition for Manager-created/assigned project
Leads. Every assigned Lead uses it, independently of the ordinary execution
mode. It follows the same `bundled < project < global` precedence, but it is launch
configuration rather than an Agent role: it is excluded from the Agent roster
and cannot be delegated to. It appears first in the flat Definitions list, with
Model, Thinking, and Details settings but no `Enabled` action. These settings
do not add it to Agent discovery or delegation.

The bundled default is orchestration-focused: it gives the Lead read-only
inspection tools plus mandatory Herdsman coordination tools. Executable project work is delegated to managed
Agents by default. Manager owns project supervision and assignment
boundaries; the Lead owns technical decisions and execution orchestration.
Herdsman automatically hands off the normal assignment response, deferring it
until delegated Agent work settles. See [Project orchestration](project-orchestration.md)
for the automatic result and `message_supervisor` coordination contract.
Managed Leads use it to contact their assigned Manager; ordinary Leads and
Managers use it to contact Chief. Override the same name
when a project or user deliberately needs a different prompt, model, thinking
level, tool policy, skill policy, or extension policy:

```markdown
---
name: managed-lead
model: openai-codex/gpt-5.6-luna
thinking: high
bodyMode: append
---

Also require an independent reviewer before accepting implementation output.
```

A project override lives at `<project>/.pi/agents/managed-lead.md` and is
resolved from the delegated worktree when the project is trusted. The global
override remains `~/.pi/agent/agents/managed-lead.md`.

`managed-lead` is an independent full launch definition, not an extension of
either ordinary runtime profile. For example, a minimal body customization is:

```markdown
---
name: managed-lead
bodyMode: append
---

Include the team's branch-validation checklist in the final handoff.
```

`managed-lead` does not support `enabled`, `agents`, or `permission`.
Its ordinary tool policy may be overridden, but Herdsman's mandatory Lead
coordination tools cannot be removed. Definition changes apply to future Lead
launches, not already-running Leads. Use `stop_lead` followed by
`resume_project` when a running project Lead must restart with changed launch
policy.

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

Omitting `systemPromptMode` defaults to `append`. `systemPromptMode: replace`
sends the effective body as Pi's replacement system prompt.

`systemPromptMode: append` appends the effective body to Pi's normal system
prompt.

Bundled Herdsman definitions use `append` so their specialization does not
replace Pi's normal prompt or runtime/tool guidance. Ordinary custom definitions
may explicitly choose `replace`; the reserved `managed-lead` role is
append-only and rejects `replace`.

Managed agents additionally receive shared herdr agent guidance at launch,
including the `ask_owner` contract. This shared guidance is infrastructure and
is not copied into every bundled role body. Managed project Leads instead use
the effective `managed-lead` body plus the ordinary Lead runtime charter and
dynamic project coordination context.

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
continuation keeps the saved Pi history and uses the current effective
definition configuration for its new generation; omitted model and thinking
fields retain the saved session's settings.

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
over ordinary names. Managed agents retain `ask_owner` and, when applicable,
Agent coordination tools as mandatory infrastructure. Managed project Leads
retain their required Agent, supervisor, and peer coordination tools. These
role-required names are restored to explicit allowlists and removed from
exclusions; unmanaged Pi launches receive no such exception. Same-named tools
cannot be permissioned by source, and collision winner ordering is not promised.
Launcher-injected agent and Herdr-state extensions are separate from definition
extensions and remain available when `noExtensions` disables ordinary
discovery.

For an integration-level smoke check, load the repository's
`scripts/tool-policy-diagnostic.mjs` extension and set `POLICY_EVIDENCE`,
`POLICY_LAUNCH`, `POLICY_FORBIDDEN`, and (for closed mode) `POLICY_ACTIVE` to
the expected tool-name sets before launching Pi with the same `--tools` and
extension arguments as the target agent. For ambient mode, leave
`POLICY_LAUNCH` empty, omit `POLICY_ACTIVE`, and set
`POLICY_FORBIDDEN_MODE=present`; closed mode defaults to `absent`. The
diagnostic records active and provider-visible tool names plus tool-call
outcomes, checks that the disposable probe is absent or present as selected,
and can verify an allowed control with
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

The native Definitions menu is a flat list, with `flexible-lead`,
`orchestrator-lead`, and `managed-lead` first in that order. Each
definition identifies its contributing source or sources as `bundled`,
`project`, and/or `global`. Select a definition to open:

```text
flexible-lead / orchestrator-lead: Details…
managed-lead: Model / Thinking / Details…
ordinary Agent: Model / Thinking / Enabled / Details…
```

Ordinary Agent launch settings are:

```text
Model
Thinking
Enabled
Details…
```

Model and thinking each offer `Inherit current session` plus their available
values. Selecting `Inherit current session` removes only that field. The model chooser stores the
canonical provider/model token; thinking uses the selected model's supported
levels when available. `Enabled` toggles the definition.

Edits always write global overrides, and standalone custom definitions can be
edited through the same flow.

It changes only the selected top-level line in the global Markdown override and
preserves unrelated frontmatter, line endings, and body content.

Removing a saved model or thinking field inherits the spawning controller for a
fresh delegation, or the saved session for a continuation. The override file
is not deleted.

Enable and disable write the scalar `enabled` field in the same global override.
Removing that field inherits the bundled value, or `true` when no source
declares it.

Changes affect future assignments. Fresh `delegate` assignments inherit unset
execution fields from their spawning controller; `continue` restores saved
session settings. They do not mutate an already-running agent or the lead Pi
session.

## See also

- [Agent-definition schema](../reference/agent-definition-schema.md)
- [`/agents` commands](../reference/commands.md)
- [Agent definitions](agent-definitions.md)

## Optional Pi Codex Conversion context sharing

The Herdsman adapter for Pi Codex Conversion (PCC) is optional and supports
Remote storage only. PCC's `shareSubagentContext` setting remains authoritative.
Load the adapter in both the delegating controller and each participating fresh
managed child; it is shipped at
`dist/integrations/pi-codex-context-sharing.js` but is not loaded by default.
For a normal npm Pi installation, reference it explicitly, for example:

```text
~/.pi/agent/npm/node_modules/pi-herdsman/dist/integrations/pi-codex-context-sharing.js
```

When a managed Agent definition uses `noExtensions: true`, list both PCC and the
Herdsman adapter in that definition's `extensions`:

```yaml
---
name: shared-worker
noExtensions: true
extensions:
  - "~/.pi/agent/npm/node_modules/@howaboua/pi-codex-conversion/dist/index.js"
  - "~/.pi/agent/npm/node_modules/pi-herdsman/dist/integrations/pi-codex-context-sharing.js"
---
```

An explicit `tools` allowlist must independently permit the tools needed by the
current PCC execution mode. The adapter does not modify tools or PCC execution
mode; consult PCC for mode-specific requirements. PCC restores the saved
context identity on continuation, so no adapter rebind is needed. Local and
Tree storage are not supported because they require ongoing context routing.
