# Pi Herdsman documentation

[Repository README](../README.md)

This directory is the canonical product documentation for `pi-herdsman`.

Pi Herdsman is built around asynchronous orchestration: managed workers can continue
independently while the lead Pi session remains the user's interactive session.
The exact lifecycle semantics live on [Lifecycle](concepts/lifecycle.md).

The documentation follows one-source-of-truth ownership: every public concept
has one canonical page. Audience pages route readers to those pages instead of
copying their full contracts.

## Choose your path

### Use Pi Herdsman from the UI

Start with [Getting started](getting-started.md).

This path is for people who want to install Pi Herdsman, delegate work without
leaving the lead conversation, configure agent definitions and placement,
observe managed agents, focus their panes, and use lead controls
without reading the structured model-facing API first.

Continue with:

- [`/workers` commands](reference/commands.md)
- [Status widget](reference/status-widget.md)
- [Configuration](reference/configuration.md)
- [Agent definitions](guides/agent-definitions.md)
- [Customizing bundled agents](guides/customizing-agents.md)
- [Agent-definition schema](reference/agent-definition-schema.md)
- [Recovery](guides/recovery.md)

### Coordinate through agent APIs

Start with [Agent coordination API](agent-api.md).

This path is for model and agent coordination behavior: non-blocking assignment,
exact worker identity, lifecycle, delegation, owner clarification, handoffs, and
failure handling.

Continue with:

- [`worker` API](reference/worker.md)
- [`ask_owner` API](reference/ask-owner.md)
- [Workers and identity](concepts/workers.md)
- [Lifecycle](concepts/lifecycle.md)
- [Delegation](concepts/delegation.md)
- [Handoffs and files](guides/handoffs.md)
- [Worker states](reference/worker-states.md)
- [Errors](reference/errors.md)

For chief supervision of independent leads, read [Supervision](concepts/supervision.md)
and its [complete reference contract](reference/supervision.md).

### Develop Pi Herdsman

Maintainer-only material stays separate from both product paths:

- [Validation](development/validation.md)
- [Smoke testing](development/smoke-testing.md)
- [Documentation maintenance](development/documentation.md)

The repository directories still group pages by content type (`concepts`,
`guides`, `reference`, and `development`). The documentation index is
audience-first so readers do not need to understand that internal grouping
before choosing the material relevant to them.

## Canonical ownership

| Subject                               | Canonical page                                                  |
| ------------------------------------- | --------------------------------------------------------------- |
| Human UI first use                    | [Getting started](getting-started.md)                           |
| Agent/API first use                   | [Agent coordination API](agent-api.md)                          |
| Asynchronous orchestration            | [Lifecycle](concepts/lifecycle.md)                              |
| Worker identity                       | [Workers and identity](concepts/workers.md)                     |
| State transitions                     | [Lifecycle](concepts/lifecycle.md)                              |
| Delegation model                      | [Delegation](concepts/delegation.md)                            |
| Creating definitions                  | [Agent definitions](guides/agent-definitions.md)                |
| Overrides and prompt composition      | [Customizing bundled agents](guides/customizing-agents.md)      |
| `files`, body references, and results | [Handoffs and files](guides/handoffs.md)                        |
| Operator recovery                     | [Recovery](guides/recovery.md)                                  |
| `worker` request contract             | [`worker` API](reference/worker.md)                             |
| `ask_owner` contract                  | [`ask_owner` API](reference/ask-owner.md)                       |
| Pi Herdsman supervision concept       | [Supervision](concepts/supervision.md)                          |
| Chief and staff tools                 | [Supervision reference](reference/supervision.md)               |
| Frontmatter fields                    | [Agent-definition schema](reference/agent-definition-schema.md) |
| Public worker states                  | [Worker states](reference/worker-states.md)                     |
| `/workers` human commands             | [`/workers` commands](reference/commands.md)                    |
| Settings                              | [Configuration](reference/configuration.md)                     |
| TUI worker widget                     | [Status widget](reference/status-widget.md)                     |
| Error categories                      | [Errors](reference/errors.md)                                   |
| Repository checks                     | [Validation](development/validation.md)                         |
| Live acceptance                       | [Smoke testing](development/smoke-testing.md)                   |

When another page needs one of these subjects, it summarizes only enough to
establish context and links to the canonical page instead of restating the full
contract.

Root `SKILL.md` remains optional model-facing reinforcement of the
self-contained runtime operational contract plus deeper coordination guidance.
Runtime remains authoritative and does not depend on the skill.
