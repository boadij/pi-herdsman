# Delegation

[Documentation index](../README.md)

Delegation is bounded, direct, and ownership-local.

## Lead

The lead Pi session may delegate to any discovered effective agent definition.
The lead retains architecture, global scope, acceptance, integration, and final
decision authority.

## Delegating agent

A lead-launched agent becomes delegation-enabled when its effective definition
has a non-empty `agents` list. It receives all nine semantic `agent_*`
coordination tools and may delegate only to definitions named in that list.
Every managed agent also receives `ask_owner`.

A delegating agent:

- delegates only to its permitted agent definitions;
- owns only its direct agents;
- integrates direct agent results into its own assignment;
- remains subordinate to the lead's approved objective.

Agent-started agents are leaves. Their effective metadata and launch policy
remove the `agents` allowlist and delegation tools. This keeps the supported
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

For example, the logical ownership tree and a subtree layout are separate:

```text
logical ownership             physical subtree layout

lead                          [lead]
├── implementer        →      [implementer]
│   └── scout                  ├─ implementer
└── reviewer                    │  └─ scout
                               └─ [reviewer]
```

Physical layout never determines ownership; the durable owner/session
relationships do.

## Agent tool policy

A non-empty effective `agents` list enables all nine coordination tools:
`agent_list`, `agent_delegate`, `agent_continue`, `agent_steer`,
`agent_interrupt`, `agent_reply`, `agent_close`, `agent_inspect`, and
`agent_transcript`. An omitted or empty list means the agent is a leaf, with
`ask_owner` as its only mandatory Herdsman tool. Normal `tools` and
`excludeTools` settings configure ordinary execution tools and cannot remove
these role-required tools.

When `tools` is omitted, no `--tools` option is emitted and Pi's configured or
default selection is preserved. An explicit `tools` allowlist is augmented
with the required coordination tools for a delegating agent and with
`ask_owner` for every managed agent.

The exact field semantics live in the
[agent-definition schema](../reference/agent-definition-schema.md).

## Parallelism

Delegate genuinely independent or context-heavy work. Prefer agents for broad
file inspection, large logs or command output, and dataset analysis. Keep small,
tightly coupled work local.

Do not:

- delegate overlapping writers to one worktree;
- delegate review before the writer finishes;
- repeat work already assigned to an active agent;
- delegate substantially overlapping work to multiple active agents;
- continue work that depends on an active agent result;
- inspect, transcript, list, or steer active agents merely to check progress or completion.

Each unresolved unit of work has exactly one executor.

Delegating a scope transfers execution ownership of that scope to the delegated
agent until the assignment resolves. The delegator retains responsibility for
coordination and may continue work it still owns, but it does not execute the
delegated scope or assign substantially overlapping work elsewhere.

After delegation succeeds, the delegated scope is no longer part of the
controller's execution scope. The controller may continue only concrete,
necessary work clearly outside that scope that it still owns; otherwise it ends
the turn and waits for automatic result or attention delivery.

After the assignment resolves, the delegator may integrate, validate,
synthesize, or assign follow-up work from the result.

A useful parallel pattern is:

```text
controller
├── agent A: independent reconnaissance
├── agent B: separate independent analysis
└── local: bounded independent controller work

local work becomes sufficiently complete
↓
controller ends its turn

agent result or attention resumes the controller
↓
controller integrates and reassesses
```

Parallelism is optional. Do not create additional assignments or local side work
merely to keep the controller active. For the full turn-navigation model, see
[Asynchronous orchestration](lifecycle.md#asynchronous-orchestration).

## Clarification across ownership edges

An agent may ask its exact direct owner through `ask_owner`.

A delegating agent with no unresolved direct-agent work follows normal
`ask_owner` eligibility. If unresolved direct agents exist, every unresolved
child must itself be validly blocked on an owner question. Ordinary active work
or an undelivered result still blocks escalation. Questions are not
automatically forwarded through an ownership chain.

## Closing

Closing a delegating agent cascades through its directly owned agents first.
Cleanup remains ownership-safe: if a required agent cannot be proved or
closed, the delegating agent is preserved rather than destructively guessing.

## See also

- [`ask_owner` API](../reference/ask-owner.md)
- [Lifecycle](lifecycle.md)
- [Handoffs and files](../guides/handoffs.md)
