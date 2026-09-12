# Agent coordination API

[Documentation index](README.md) · [Human UI path](getting-started.md) · [supervision reference](reference/supervision.md)

This is the entry point for model and agent-facing Pi Herdsman coordination.
Pi Herdsman is opinionated about coordination semantics, not the workflow built on
top of them. The API provides assignment, control, lifecycle, clarification, and
handoff primitives without prescribing a planning, implementation, or review
process.

Exact request schemas, states, lifecycle rules, and error behavior remain on
their canonical pages.

If you only want to configure, observe, focus, or stop agents from Pi's TUI,
begin with [Getting started](getting-started.md) instead.

For an active chief supervising independent leads, use the [`staff` and
`chief` contracts](reference/supervision.md).

## Prerequisites

Installation and supported versions are owned by
[Getting started](getting-started.md#1-install). The lead Pi session
must run inside [herdr](https://github.com/herdrdev/herdr).

## First use

The exact controller contract is the [`agent` API](reference/agent.md).
Start by inspecting the current roster and authoritative visible agents:

```json
{ "action": "list" }
```

Then delegate to a fresh agent by definition:

```json
{
  "action": "delegate",
  "definition": "implementer",
  "task": "Implement the approved change"
}
```

`delegate` is non-blocking orchestration. It returns after the agent has accepted
the assignment, not when the agent finishes.

The owner remains free to make useful progress, coordinate other independent
work, or end its turn normally. It must not poll the agent. Completion or an
`ask_owner` question is delivered back to the exact owner asynchronously.

The detailed lifecycle contract, including result delivery, one-assignment
cleanup, blocked work, settling, and delegating-agent completion, is owned by
[Lifecycle](concepts/lifecycle.md).

The examples above establish the first-use path only. Use the
[`agent` API](reference/agent.md) for exact accepted fields, validation,
control eligibility, session continuation, fork behavior, and return shapes.

## Understand agent identity

Read [Agents and identity](concepts/agents.md) for the identity model behind
controller operations. The logical agent identity is exposed as `agent` for
live control; physical herdr and Pi identifiers are validation evidence.

For the exact public state vocabulary, see
[Agent states](reference/agent-states.md).

## Delegate deliberately

Read [Delegation](concepts/delegation.md) for lead and delegating-agent
ownership and delegation limits.

An agent that genuinely needs an owner decision uses the separate
[`ask_owner` API](reference/ask-owner.md). The exact owner answers through the
controller's `reply` action; ordinary active agent work is not an owner
question.

## Pass evidence through handoffs

Read [Handoffs and files](guides/handoffs.md) for `files`, result references, body
references, and coordination artifacts. That guide owns the evidence-transfer
workflow; the `agent` reference owns the accepted request fields.

## Handle failures conservatively

Use [Errors](reference/errors.md) for exact public error categories and
[Recovery](guides/recovery.md) for operator recovery procedures. Do not infer
control authority from the status widget or from stale physical-process
observations.

## Human UI is a separate surface

The lead TUI exposes `/agents`, the status widget, definition
configuration, layout selection, focus navigation, and emergency Stop all.
Those are human-facing surfaces and are documented separately:

- [`/agents` commands](reference/commands.md)
- [Status widget](reference/status-widget.md)
- [Configuration](reference/configuration.md)
- [Getting started](getting-started.md)

They do not replace the structured agent coordination contracts linked above.
