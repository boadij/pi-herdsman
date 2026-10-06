# Agent-definition schema

[Documentation index](../README.md)

This page is the canonical public schema for Markdown agent definitions.

## File format

A definition requires frontmatter beginning on the first line and a closing
frontmatter delimiter:

```markdown
---
name: scout
thinking: medium
tools: ["read", "bash"]
---

Prompt body.
```

Agent definitions use YAML frontmatter. Array fields accept normal YAML flow or
block sequences.

For example, block sequences are valid for array fields:

```yaml
---
name: reviewer
tools:
  - read
  - grep
skills:
  - "/absolute/path/to/code-review/SKILL.md"
---
```

Unknown frontmatter fields fail validation.

Malformed files fail discovery; Pi Herdsman does not silently drop one invalid
definition and return a partial roster.

## Sources and precedence

Bundled definitions:

```text
dist/agent-definitions/
```

Global definitions by default:

```text
~/.pi/agent/agents/
```

A matching project or global name overlays the lower-precedence definition.

An unmatched project or global definition is standalone. Project definitions
are loaded from `<cwd>/.pi/agents/` when Pi considers the project trusted.
Precedence is `bundled < project < global`.

All effective Agent definitions are sorted and validated together, including
every `agents` reference.

### Reserved managed Lead definition

`managed-lead` is a reserved definition used only when Manager starts or
resumes a project Lead. It uses the same bundled, project, and global overlay
engine, but it is excluded from the Agent roster: it cannot be selected by
`agent_delegate`, referenced from `agents`, or disabled. The Definitions UI
places it first in the flat definitions list and supports editing only its
`model` and `thinking` settings; it has no `Enabled` action.

For project work, the project layer is resolved from the delegated worktree when
that project is trusted. The effective definition is launch configuration only;
it is not persisted into the project assignment. A running Lead is not
hot-reconfigured when definition files change. Manager supervises project scope
and assignment boundaries; the assigned Lead owns technical decisions and
execution orchestration. Project assignment handoff and settlement behavior is
described in [Project orchestration](../guides/project-orchestration.md).

`managed-lead` does not support `enabled`, `agents`, or `permission`.
Its system prompt must use `append`; an override that selects `replace` is
rejected so project or global policy cannot remove the Lead runtime contract.
Other launch-policy fields in this schema retain their normal composition
semantics. Herdsman always preserves the Lead coordination tools required by the
runtime role even when an explicit tool allowlist or exclusion policy is used.

## Execution settings

`model` and `thinking` are independent optional overrides. An omitted field is
inherited according to this precedence:

| Operation                                       | Omitted `model` or `thinking`          |
| ----------------------------------------------- | -------------------------------------- |
| fresh `delegate`                                | current spawning controller session    |
| nested fresh `delegate`                         | current spawning managed-agent session |
| `continue`                                      | saved Pi session                       |
| fresh managed Lead from `staff_delegate`        | current Manager session                |
| restarted managed Lead from `staff_resume`      | saved Pi session                       |
| any operation with an explicit definition field | explicit definition value              |

Model and thinking resolve independently, so either field can be explicit while
the other inherits. A nested agent inherits from its managed parent, not from
the root lead. Pi clamps a thinking level to the selected model's capabilities.
Fresh-delegation settings are snapshotted at launch; changing the controller
does not change an active agent.

`enabled` controls Agent-definition availability. A disabled definition remains
in the lead roster so it can be enabled again, but owner-visible definition
lists omit it. `delegate` and `continue` reject a disabled definition. An
already active agent may finish and remains controllable according to its current
available actions; disabling a definition does not mutate that assignment.
`managed-lead` does not support `enabled`; its bundled definition is always
the fallback.

## Fields

| Field                   | Accepted value                                                        | Omitted/default behavior                                                                                            | Runtime/composition behavior                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                  | non-empty string                                                      | required                                                                                                            | Effective definition identity.                                                                                                                                                                                        |
| `enabled`               | boolean                                                               | `true`                                                                                                              | `false` makes `delegate` and `continue` unavailable; it does not mutate an active agent.                                                                                                                              |
| `description`           | string                                                                | absent                                                                                                              | Display/selection description.                                                                                                                                                                                        |
| `model`                 | non-empty string                                                      | spawning controller for fresh `delegate`; saved session for `continue`                                              | Explicit value is passed as Pi model selection.                                                                                                                                                                       |
| `thinking`              | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `false` | spawning controller for fresh `delegate`; saved session for `continue`                                              | Explicit value wins; `false` launches as `off`.                                                                                                                                                                       |
| `systemPromptMode`      | `append` or `replace`                                                 | `append`                                                                                                           | Controls whether the effective body is appended to or replaces Pi's base system prompt. `replace` is an explicit escape hatch for ordinary custom definitions; `managed-lead` rejects it.                                    |
| `bodyMode`              | `append` or `replace`                                                 | `replace` for non-empty matching overlay body                                                                       | Valid only when overlaying an existing lower-precedence definition; consumed during body composition.                                                                                                                 |
| `noTools`               | boolean                                                               | Pi normal tool policy                                                                                               | `true` emits `--no-tools`; managed `ask_owner` remains infrastructure.                                                                                                                                                |
| `noBuiltinTools`        | boolean                                                               | Pi normal built-in tool policy                                                                                      | `true` emits `--no-builtin-tools`.                                                                                                                                                                                    |
| `tools`                 | array of non-empty strings                                            | no explicit allowlist                                                                                               | Passed to Pi as a source-agnostic tool-name allowlist; matching overlay replaces whole array.                                                                                                                         |
| `excludeTools`          | array of non-empty strings                                            | no explicit exclusions                                                                                              | Passed to Pi as source-agnostic tool-name exclusions; matching override replaces whole array.                                                                                                                        |
| `permission`            | mapping                                                               | absent                                                                                                              | Opaque interoperability policy for permission-aware extensions; Pi Herdsman does not evaluate it.                                                                                                                     |
| `noSkills`              | boolean                                                               | skills disabled unless `inheritSkills: true`                                                                        | Controls Pi native skill discovery; explicit `skills` values are still passed separately.                                                                                                                             |
| `inheritSkills`         | boolean                                                               | does not enable by itself unless `true`                                                                             | `true` changes omitted `noSkills` default so native skills remain available. Explicit `noSkills` wins.                                                                                                                |
| `skills`                | array of non-empty strings                                            | no explicit skill arguments                                                                                         | Each value is passed unchanged as a Pi skill path/resource.                                                                                                                                                           |
| `noExtensions`          | boolean                                                               | Pi normal extension policy                                                                                          | `true` emits `--no-extensions`, except when the launched model needs extension discovery. Launcher-injected herdr infrastructure remains.                                                                             |
| `extensions`            | array of non-empty strings                                            | no extra extension arguments                                                                                        | Each value is passed unchanged to Pi.                                                                                                                                                                                 |
| `agents`                | array of unique non-empty definition names                            | no direct agents                                                                                                    | Names direct definitions this agent may delegate to; every name must exist.                                                                                                                                           |
| `inheritProjectContext` | boolean                                                               | `true` only for definition name `delegate`; otherwise `false`                                                       | Controls project context-file inheritance.                                                                                                                                                                            |
| `inheritGlobalContext`  | boolean                                                               | follows effective `inheritProjectContext`                                                                           | Controls global context-file inheritance.                                                                                                                                                                             |

`permission` is reserved for compatible permission extensions. Pi Herdsman
accepts and preserves the mapping but does not validate its internal policy
schema or make authorization decisions from it.

Arrays supplied by an override replace the complete inherited array, including
an explicit `[]`.

When a delegating agent declares an agent definition in `agents`, that definition must
be enabled. A delegating agent referencing a disabled agent definition can remain
discoverable, but is rejected during assignment or fresh agent startup with an explicit
disabled-agent error rather than being silently removed from the delegating agent
definition.

Skill and extension paths are passed to Pi unchanged. herdr does not resolve
them relative to the definition file.

Tool names and `*` patterns are governed by Pi's native name-based policy on
the Pi 1.0.4 baseline, regardless of
whether a tool is built in, registered by an extension, or supplied as a
custom/SDK tool or supplied through MCP. Both `tools` and `excludeTools`
accept these selectors; only `*` is special and matches any characters.
When both fields apply, an exclusion wins over an allowlist.
Names do not need to exist when a definition is discovered: unknown names are
accepted and can match a tool registered later. Pi Herdsman does not provide
source-qualified permissions, such as an extension path plus tool name.
Managed definitions use `agent` as a delegation-policy sentinel instead; it is
not passed as a callable tool name, and leaf projection removes it from
explicit `tools`.

An explicit `tools` allowlist takes precedence over the default-selection
switches `noTools` and `noBuiltinTools`; `excludeTools` removes matching
ordinary tool names. Managed agents and managed project Leads always retain their role-required
Herdsman coordination tools, which are protected from exclusions. When `tools`
is omitted, Pi Herdsman does not emit `--tools`, preserving Pi's
configured/default tool selection. When `tools` is explicitly set, the
selected allowlist is closed across Pi callable tool sources and augmented
with the runtime role's mandatory tools. Unselected tools do not become callable
merely because additional MCP servers, extensions, or custom tools are configured.
An explicit empty policy disables ordinary tools. `noBuiltinTools: true` alone
does not close the policy; other normal Pi tool sources remain available.
Exact exclusions naming mandatory tools are ignored. Wildcard exclusions
matching any mandatory Herdsman tool are invalid and reject launch: Pi exclusions
cannot express everything matching a pattern except required infrastructure.
Unmanaged Pi launches do not receive these managed-role exceptions.

Loading extension code and exposing its tools are separate concerns. An
extension listed in `extensions` is loaded, while its registered tools still
must pass `tools` and `excludeTools` to be model-callable. Tool filtering is
not extension sandboxing: loaded extensions may still run handlers, commands,
shortcuts, providers, initialization, and other non-tool behavior.

Pi's native tool policy is the callable boundary verified for the documented
integration. A provider or conversion integration may add its own presentation
layer, so provider-visible tool descriptions should not be treated as a Pi
Herdsman permission registry or as proof that extension code is sandboxed. Pi Herdsman
passes the native policy through; it does not independently guarantee every
provider presentation boundary.

Tools with the same name are not independently permissionable by source, and
the winner for a name collision is not a supported ordering contract.

`noExtensions` disables ordinary extension discovery, but launcher-injected
Pi Herdsman agent and Herdr-state extensions remain mandatory infrastructure.
Explicit `extensions` entries remain separate launch inputs and are passed to
Pi normally. Launcher-injected infrastructure remains separate from the
definition's extension and tool policy.

One launch-derived exception applies, and only to an inherited model. Fresh
delegation inherits the spawning controller's model, and when that model's
provider is registered by an extension, discovery stays available for that
launch even when `noExtensions` is `true`, because a child denied discovery
cannot resolve a model whose provider only an extension supplies. A model
pinned in the definition is passed to Pi as written and keeps the definition's
own extension policy, so a definition that pins such a model must set
`noExtensions: false` itself.

## Managed-agent coordination tools

A managed agent must have a non-empty effective `agents` list to be
delegation-enabled. That condition is necessary but not sufficient: delegation
is disabled when `excludeTools` contains `agent`, when `noTools: true` unless
the explicit `tools` list contains `agent`, or when `tools` is explicitly
empty. Otherwise, a non-empty `agents` list enables all nine coordination
tools: `agent_list`, `agent_delegate`, `agent_continue`, `agent_steer`,
`agent_interrupt`, `agent_reply`, `agent_close`, `agent_inspect`, and
`agent_transcript`. Thus omitted `tools` permits delegation, and explicit
ordinary tools permit it unless one of those opt-outs applies. An omitted or
empty `agents` list always makes the agent a leaf. Every managed agent receives
`ask_owner`.

The tool name `agent` is configuration-policy evidence only; it is not
registered or callable. In `tools`, it opts into delegation when `noTools: true`
is set. `excludeTools: [agent]` opts out. When a definition is projected as a
leaf, `agent` is removed from its `tools` list.

`tools` and `excludeTools` configure ordinary execution tools, not this
mandatory role infrastructure. They cannot remove required coordination tools
or `ask_owner`. When `tools` is omitted, Pi Herdsman emits no `--tools` option
and Pi's configured/default selection remains in effect. An explicit `tools`
allowlist is augmented with the managed agent's mandatory role tools; the
configuration-only `agent` name is excluded from that allowlist.

## Body composition

The body is text after the closing `---`, trimmed at its outer boundaries.

For matching project and global overlays:

```text
empty overlay body
    → lower-layer body

non-empty overlay body, bodyMode omitted/replace
    → overlay body

non-empty overlay body, bodyMode append
    → lower-layer body + "\n\n" + overlay body
```

Standalone definitions cannot declare `bodyMode`.

## Body file references

A body line is a reference only when the complete trimmed line matches:

```text
@./relative/path
@../relative/path
@/absolute/path
@~/home-relative/path
```

On Windows, native backslash forms are also accepted, including `@.\relative`,
`@..\relative`, `@~\home-relative`, rooted paths, drive-rooted paths, and UNC
paths. References use the host platform's native path classification and
resolution rules.

Before bundled/global body composition, relative references are resolved from
the definition file that declared them.

When a new agent generation is constructed:

1. references are processed in body order; `~/` (or `~\` on Windows) is
   resolved beneath the current user's home directory;
2. targets are canonicalized with `realpath`;
3. each canonical file is included once;
4. a caller `delegate.files` canonical overlap wins and removes the body copy;
5. each accepted source must be a bounded readable regular UTF-8 file without
   NUL bytes;
6. included text replaces that reference line;
7. included text is not recursively expanded.

Every new agent generation expands the effective body and its file references
once at launch. Session continuation preserves the Pi session history while
using the current effective definition configuration; model and thinking follow
the execution-settings precedence above.

## Runtime prompt order

For a newly constructed managed agent, the effective launch composition is:

```text
Pi base system prompt
    ↓ effective body via systemPromptMode
selected project/global context-file additions
    ↓
shared herdr agent guidance
    ↓
<active_agent name="<definition>"/>
    ↓ generic identity signal for compatible extensions
<pi_herdsman_agent>
identity: <definition>:<label>
direct_owner: lead | <owner-definition>:<owner-label>
</pi_herdsman_agent>
```

Omitting `systemPromptMode` defaults to `append`, preserving Pi's normal system
prompt and runtime/tool guidance alongside the role-specific body. Ordinary
custom definitions may explicitly select `replace`; the reserved
`managed-lead` role is append-only and rejects that setting.

The effective body and shared guidance are delivered through private temporary
prompt snapshots. Managed agents retain the generic literal
`<active_agent name="<definition>"/>` interoperability signal for compatible
extensions. Separately, the managed-Agent runtime supplies a structured
`pi_herdsman_agent` section with the current semantic identity and direct owner.
`direct_owner` is model-facing context only; exact ownership and routing
continue to use internal Pi session identity. A continued generation
recomputes its direct owner from the current caller rather than restoring the
historical owner.

## Complete override example

```markdown
---
name: reviewer
description: Review implementation changes
model: openai-codex/gpt-5.6-luna
thinking: high
bodyMode: append
systemPromptMode: replace
noTools: false
noBuiltinTools: false
tools: ["read", "bash"]
excludeTools: []
noSkills: false
inheritSkills: true
skills: ["/absolute/path/to/code-review/SKILL.md"]
noExtensions: false
extensions: ["/absolute/path/to/local-extension.ts"]
agents: ["scout"]
inheritProjectContext: true
inheritGlobalContext: false
---

Additional local review instructions.

@./prompts/review-policy.md
```

Because `agents` is non-empty, and none of the delegation opt-outs apply, this
managed agent receives all nine coordination tools and `ask_owner`, in
addition to the explicitly selected ordinary tools.

To disable a bundled role without copying its definition, use a minimal global
override:

```markdown
---
name: reviewer
enabled: false
---
```

The `/agents definitions` menu exposes the same enable and disable operations.
Removing the `enabled` line inherits the bundled value; when no source declares
the field, the effective value is `true`.

## See also

- [Customizing bundled agents](../guides/customizing-agents.md)
- [Handoffs and files](../guides/handoffs.md)
- [Delegation](../concepts/delegation.md)
