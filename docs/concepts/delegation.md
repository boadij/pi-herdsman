# Delegation

[Documentation index](../README.md)

Delegation is bounded, direct, and ownership-local.

## Lead

The lead Pi session may delegate to any discovered effective agent definition.
The lead retains architecture, global scope, acceptance, integration, and final
decision authority.

## Delegating agent

A lead-launched agent becomes delegation-enabled when its effective definition
has a non-empty `agents` list and its tool policy permits the `agent` tool.
The agent receives only the definitions named by its effective `agents` list.

A delegating agent:

- delegates only to its permitted agent definitions;
- owns only its direct agents;
- integrates direct agent results into its own assignment;
- remains subordinate to the lead's approved objective.

Agent-started agents are leaves. Their effective metadata and launch policy
remove the `agents` allowlist and `agent` capability. This keeps the supported
structure bounded:

```text
lead
└── delegating agent
    └── agent
```

A lead may have many direct agents, and each direct agent that is explicitly
delegation-enabled may have its own direct agents. A delegation-capable agent
remains an agent at every depth; it is not a separate public role.

Physical placement is presentation only and never determines ownership. The
lead's placement setting controls direct agents: `tab` shares one tab per lead,
`subtree` gives each direct agent a fresh tab, and `split` stays in the caller's
tab. Nested delegation always splits inside the owner's current tab, regardless
of the setting.

## Inferred `agent` capability

A non-empty `agents` field implies the `agent` tool when the definition uses
an explicit non-empty `tools` allowlist. An omitted tool allowlist keeps Pi's
default tool policy rather than creating an `agent`-only list.

Explicit denial wins:

- `excludeTools: ["agent"]` prevents inference.
- `noTools: true` prevents inferred `agent` unless `agent` is explicitly
  present in `tools`.
- An explicit exclusion wins over an explicit allow.

The exact field semantics live in the
[agent-definition schema](../reference/agent-definition-schema.md).

## Parallelism

Delegate genuinely independent or context-heavy work. Prefer agents for broad
file inspection, large logs or command output, and dataset analysis. Keep small,
tightly coupled work local.

Do not:

- delegate overlapping writers to one worktree;
- delegate review before the writer finishes;
- duplicate supplied reconnaissance;
- continue dependent work while a required agent is active.

A useful pattern is:

```text
delegating agent
├── scout: bounded reconnaissance
└── local independent analysis

agent result arrives
↓
delegating agent integrates both
```

## Clarification across ownership edges

An agent may ask its exact direct owner through `ask_owner`.

A delegating agent may ask its own direct owner when its unresolved direct
agents are themselves validly blocked on owner questions. Ordinary active
agent work or an undelivered agent result still blocks escalation. Questions
are not automatically forwarded through an ownership chain.

## Closing

Closing a delegating agent cascades through its directly owned agents first.
Cleanup remains ownership-safe: if a required agent cannot be proved or
closed, the delegating agent is preserved rather than destructively guessing.

## See also

- [`ask_owner` API](../reference/ask-owner.md)
- [Lifecycle](lifecycle.md)
- [Handoffs and files](../guides/handoffs.md)
