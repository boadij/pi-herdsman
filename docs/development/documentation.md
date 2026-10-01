# Documentation maintenance

[Documentation index](../README.md)

Pi Herdsman documentation uses one canonical owner per public concept. Entry
pages route readers to those owners instead of growing parallel copies of the
same contract.

[ADR 0011](../adr/0011-use-progressive-disclosure-and-single-owner-documentation.md)
records the architectural decision behind this structure.

## Ownership rule

When another page needs an owned concept:

- summarize only enough to establish context
- link to the canonical page
- do not copy its complete contract or table
- delete stale duplicate wording instead of preserving compatibility prose

Runtime behavior and public source/tests remain authoritative when prose
disagrees.

## Canonical ownership

| Subject                                                | Canonical owner                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| Product positioning and repository first impression    | [`README.md`](../../README.md)                                      |
| First successful use                                   | [Getting started](../getting-started.md)                            |
| Model-facing API navigation                            | [Coordination API](../coordination-api.md)                          |
| Roles, authority, project scope, and system boundaries | [Coordination](../concepts/coordination.md)                         |
| Agent identity                                         | [Agents and identity](../concepts/agents.md)                        |
| Delegation and execution ownership                     | [Delegation](../concepts/delegation.md)                             |
| Asynchronous Agent lifecycle                           | [Lifecycle](../concepts/lifecycle.md)                               |
| Manager workflow                                       | [Project orchestration](../guides/project-orchestration.md)         |
| Creating Agent definitions                             | [Agent definitions](../guides/agent-definitions.md)                 |
| Overrides and prompt composition                       | [Customizing bundled Agents](../guides/customizing-agents.md)       |
| Handoffs, files, and result references                 | [Handoffs and files](../guides/handoffs.md)                         |
| Operator recovery                                      | [Recovery](../guides/recovery.md)                                   |
| Container deployment                                   | [Container deployment](../guides/container-deployment.md)           |
| `agent_*` contract                                     | [Agent tools](../reference/agent.md)                                |
| `ask_owner` contract                                   | [`ask_owner`](../reference/ask-owner.md)                            |
| `staff_*` and project-work contract                    | [Staff tools](../reference/staff.md)                                |
| `supervisor_*` contract                                | [Supervisor tools](../reference/supervisor.md)                      |
| `peer_*` contract                                      | [Peer tools](../reference/peer.md)                                  |
| Slash commands                                         | [Commands](../reference/commands.md)                                |
| Agent-definition fields                                | [Agent-definition schema](../reference/agent-definition-schema.md)  |
| Public Agent states                                    | [Agent states](../reference/agent-states.md)                        |
| Settings                                               | [Configuration](../reference/configuration.md)                      |
| TUI status presentation                                | [Status widget](../reference/status-widget.md)                      |
| Error categories                                       | [Errors](../reference/errors.md)                                    |
| Repository checks                                      | [Validation](validation.md)                                         |
| Live acceptance                                        | [Smoke testing](smoke-testing.md)                                   |
| Instruction/interface design                           | [Instruction and interface design](instruction-interface-design.md) |

## Page types

### Entry pages

The root README, documentation index, Getting Started, and Coordination API are
navigation and orientation surfaces.

They may contain the smallest useful example, but exhaustive behavior belongs
to the canonical concept, guide, or reference owner.

### Concepts

Explain mental models and invariants.

Do not enumerate every request field.

### Guides

Explain how to accomplish a task.

Use realistic workflow examples and link to reference for exhaustive semantics.

### Reference

Specify exact accepted values, state, precedence, and operation behavior.

Avoid tutorial narrative and product positioning.

### Development

Maintainer-only validation, smoke, and documentation-process material.

Do not mix these procedures into normal user setup.

### `SKILL.md`

`SKILL.md` is optional model-facing reinforcement of runtime behavior plus
strategy, rationale, examples, and recovery guidance. It is not a second
normative owner for public schemas or runtime semantics.

## Runtime and skill authority

Runtime model contracts own operational semantics.

When runtime guidance changes:

- update the authoritative runtime contract first
- update affected documentation or skill projections
- remove obsolete reinforcement
- keep runtime behavior sufficient when `SKILL.md` is not loaded

A high-salience invariant may appear at multiple model decision points when that
materially improves reliability, but every projection must preserve one
meaning. Do not add a synchronization framework merely to keep prose copies
aligned.

## Style

- Plain Markdown
- Relative repository links
- One H1 per file
- Short descriptive headings
- Current behavior only
- Progressive disclosure from outcome to exact contract
- Prefer a diagram or table only when it removes prose
- Spell the visible product `Pi Herdsman`, package/repository `pi-herdsman`, local coordination directory `.pi-herdsman`, configuration file `config.json`, and upstream dependency `herdr`
- No backlog task numbers in product docs
- Examples must match current accepted schemas
- Do not document unshipped backlog behavior as available
- Avoid em dashes in product documentation

## Cross-links

Every page under `docs/` links to the documentation index.

Use a `See also` section only for genuinely adjacent material. Do not create a
navigation manifest, generated docs framework, redirect layer, or duplicate
audience hierarchy while plain Markdown remains sufficient.

## Source verification

When implementation and prose disagree:

1. public source/test behavior is authoritative
2. current accepted runtime evidence can clarify integration behavior
3. stale prose is deleted rather than preserved as another contract

Particularly verify runtime implementation for `agent_*`, `ask_owner`,
`staff_*`, `supervisor_*`, `peer_*`, `/agents`, `/manager`, `/chief`, states,
definition composition, project work, recovery, and presentation behavior.

Use `package.json` for supported Pi versions and package resources.

## Link integrity

Before handoff, resolve every repository-relative Markdown link. Links must
target current repository pages and anchors.

## Update policy

A feature should normally change:

- its canonical reference page when exact behavior changes
- a concept when the mental model or invariant changes
- a guide when the user workflow changes
- an entry page only when the reading path or first-use experience changes
- README only when product positioning, first-use, or headline capability changes
- `SKILL.md` only when model-facing coordination guidance changes

Update only the surfaces whose ownership or reader path changed.
