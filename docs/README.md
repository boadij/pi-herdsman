# Pi Herdsman documentation

[Repository README](../README.md)

Choose the shortest path that matches what you are trying to do. Exact behavior
lives on one canonical concept or reference page so entry pages stay small and
do not drift into competing contracts.

## New to Pi Herdsman?

Start with [Getting started](getting-started.md).

It covers installation, the first asynchronous Agent delegation, `/herdsman`,
configuration, and where to go next.

## Orchestrate project work

Use [Project orchestration](guides/project-orchestration.md) to coordinate
independent branch-based work through Manager and multiple Leads.

Read [Coordination](concepts/coordination.md) when you need the underlying role,
authority, project-scope, and ownership model.

## Understand Agents

- [Agents and identity](concepts/agents.md)
- [Delegation](concepts/delegation.md)
- [Lifecycle](concepts/lifecycle.md)
- [Handoffs and files](guides/handoffs.md)
- [Recovery](guides/recovery.md)

## Customize Pi Herdsman

- [Agent definitions](guides/agent-definitions.md)
- [Customizing bundled Agents](guides/customizing-agents.md)
- [Agent-definition schema](reference/agent-definition-schema.md)
- [Configuration](reference/configuration.md)
- [Container deployment](guides/container-deployment.md)

## Use the coordination API

Start with [Coordination API](coordination-api.md), then use the focused
references for exact contracts:

- [Agent tools](reference/agent.md)
- [`ask_owner`](reference/ask-owner.md)
- [Staff tools](reference/staff.md)
- [Supervisor tools](reference/supervisor.md)
- [Peer tools](reference/peer.md)
- [Agent states](reference/agent-states.md)
- [Errors](reference/errors.md)

Human-facing surfaces are documented separately:

- [Commands](reference/commands.md)
- [Status widget](reference/status-widget.md)

## Develop Pi Herdsman

Maintainer-only material stays separate from product use:

- [Product philosophy](development/product-philosophy.md)
- [Validation](development/validation.md)
- [Smoke testing](development/smoke-testing.md)
- [Documentation maintenance](development/documentation.md)
- [Instruction and interface design](development/instruction-interface-design.md)

The repository directories are organized by content type. The index is
task-first so readers do not need to understand that structure before finding
the right page.
