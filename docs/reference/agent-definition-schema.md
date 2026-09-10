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
are loaded from `<cwd>/.pi/agents/` only when trusted project settings set
`piHerdsman.projectAgents` to `true`. Precedence is `bundled < project < global`.

All effective definitions are sorted and validated together, including every
`agents` reference.

`enabled` controls definition availability. A disabled definition remains in the
lead roster so it can be enabled again, but owner-visible definition lists omit
it. Definition and session delegations reject a disabled definition. An already
active agent may finish and remains controllable according to its current
available actions; disabling a definition does not mutate that assignment.

## Fields

| Field                   | Accepted value                                                        | Omitted/default behavior                                          | Runtime/composition behavior                                                                           |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `name`                  | non-empty string                                                      | required                                                          | Effective definition identity.                                                                         |
| `enabled`               | boolean                                                               | `true`                                                            | `false` makes definition and session delegation unavailable; it does not mutate an active agent.       |
| `description`           | string                                                                | absent                                                            | Display/selection description.                                                                         |
| `model`                 | non-empty string                                                      | Pi default/current launch behavior                                | Passed as Pi model selection.                                                                          |
| `thinking`              | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, or `false` | Pi default/current launch behavior                                | `false` launches as `off`.                                                                             |
| `systemPromptMode`      | `append` or `replace`                                                 | `append` only for definition name `delegate`; otherwise `replace` | Controls effective body versus Pi base system prompt.                                                  |
| `bodyMode`              | `append` or `replace`                                                 | `replace` for non-empty matching overlay body                     | Valid only when overlaying an existing lower-precedence definition; consumed during body composition.  |
| `noTools`               | boolean                                                               | Pi normal tool policy                                             | `true` emits `--no-tools`; managed `ask_owner` remains infrastructure.                                 |
| `noBuiltinTools`        | boolean                                                               | Pi normal built-in tool policy                                    | `true` emits `--no-builtin-tools`.                                                                     |
| `tools`                 | array of non-empty strings                                            | no explicit allowlist                                             | Passed to Pi as a source-agnostic tool-name allowlist; matching overlay replaces whole array.          |
| `excludeTools`          | array of non-empty strings                                            | no explicit exclusions                                            | Passed to Pi as source-agnostic tool-name exclusions; matching override replaces whole array.          |
| `permission`            | mapping                                                               | absent                                                            | Opaque interoperability policy for permission-aware extensions; Pi Herdsman does not evaluate it.      |
| `noSkills`              | boolean                                                               | skills disabled unless `inheritSkills: true`                      | Controls Pi native skill discovery; explicit `skills` values are still passed separately.              |
| `inheritSkills`         | boolean                                                               | does not enable by itself unless `true`                           | `true` changes omitted `noSkills` default so native skills remain available. Explicit `noSkills` wins. |
| `skills`                | array of non-empty strings                                            | no explicit skill arguments                                       | Each value is passed unchanged as a Pi skill path/resource.                                            |
| `noExtensions`          | boolean                                                               | Pi normal extension policy                                        | `true` emits `--no-extensions`. Required herdr agent infrastructure remains injected by the launcher.  |
| `extensions`            | array of non-empty strings                                            | no extra extension arguments                                      | Each value is passed unchanged to Pi.                                                                  |
| `agents`                | array of unique non-empty definition names                            | no direct agents                                                  | Names direct definitions this agent may delegate to; every name must exist.                            |
| `inheritProjectContext` | boolean                                                               | `true` only for definition name `delegate`; otherwise `false`     | Controls project context-file inheritance.                                                             |
| `inheritGlobalContext`  | boolean                                                               | follows effective `inheritProjectContext`                         | Controls global context-file inheritance.                                                              |

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

Tool names are governed by Pi's native name-based policy, regardless of
whether a tool is built in, registered by an extension, or supplied as a
custom/SDK tool. When both fields apply, an exclusion wins over an allowlist.
Names do not need to exist when a definition is discovered: unknown names are
accepted and can match a tool registered later. Pi Herdsman does not provide
source-qualified permissions, such as an extension path plus tool name.

An explicit `tools` allowlist takes precedence over the default-selection
switches `noTools` and `noBuiltinTools`; `excludeTools` still removes matching
names. Thus a managed agent may receive both `--no-tools` and an explicit
`--tools ask_owner`. Pi Herdsman protects that mandatory `ask_owner` capability in
managed launches and removes it from explicit exclusions. Unmanaged Pi
launches do not receive this exception.

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

## Tool inference for `agents`

A non-empty `agents` list declares potential agent definitions; effective
delegation also requires permitted `agent` capability and a controller depth
that allows delegation.

This capability is projected by controller depth. Lead-launched definitions
retain their declared agent allowlist and effective `agent` tool. An
agent-launched agent receives no agent allowlist and no effective `agent`,
even when its definition is delegation-enabled at the lead. Explicit tool
allowlists, empty arrays, `noTools`, and exclusions remain fail-closed.

When it has an explicit non-empty `tools` allowlist and does not already contain
`agent`, Pi Herdsman appends `agent` to the effective allowlist unless denied.

Rules:

| Configuration                                   | Effective inference                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------- |
| `agents` omitted or `[]`                        | no inferred `agent`                                                       |
| non-empty `agents`, `tools` omitted             | keep Pi default tool policy; do not materialize an `agent`-only allowlist |
| non-empty `agents`, explicit non-empty `tools`  | append `agent`                                                            |
| `excludeTools` contains `agent`                 | explicit denial wins                                                      |
| `noTools: true`, no explicit `agent` in `tools` | no inferred `agent`                                                       |
| `noTools: true`, explicit `tools: ["agent"]`    | explicit allow is preserved                                               |
| explicit allow plus explicit exclusion          | exclusion wins                                                            |

`ask_owner` is separate mandatory managed agent infrastructure and is not this
inference rule.

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

Before bundled/global body composition, relative references are resolved from
the definition file that declared them.

When a new agent generation is constructed:

1. references are processed in body order; `~/` is resolved beneath the
   current user's home directory;
2. targets are canonicalized with `realpath`;
3. each canonical file is included once;
4. a caller `delegate.files` canonical overlap wins and removes the body copy;
5. each accepted source must be a bounded readable regular UTF-8 file without
   NUL bytes;
6. included text replaces that reference line;
7. included text is not recursively expanded.

Every new agent generation expands the effective body and its file references
once at launch. Session continuation preserves the Pi session history while
using the current effective definition configuration.

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
```

The final effective body and shared guidance are delivered through private
temporary prompt snapshots. The active-agent tag is appended directly as
interoperability metadata for compatible Pi extensions.

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

Because `agents` is non-empty and the explicit `tools` list does not deny it,
the effective tools include `agent`.

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
