# Delegation

[Documentation index](../README.md)

Delegation is bounded, direct, and ownership-local.

## Lead

An eligible root Pi session may delegate directly. A Lead with an omitted
`agents` field may use any available effective Agent definition; an explicit
list restricts it to those names, and an empty list disables fresh delegation.
Manager and Chief may use only the definitions listed in their effective
`agents` profile; an omitted or empty list disables fresh direct delegation.
Fresh delegation includes both new assignments and continuations. This policy
applies to direct children only and is independent of
ordinary `tools` and does not grant staff authority. The exact session that
starts an Agent owns it; supervising another session does not confer ownership
of that session's Agents. Existing owners can continue managing their own work
even when fresh delegation is disabled.

The Lead retains architecture, global scope, acceptance, integration, and
final decision authority for its assignment.

## Delegating agent

A managed Agent may delegate to the definitions in its effective
`agents` allowlist only when delegation is enabled by its tool policy. Every
managed agent receives `await_owner` and `notify_owner`; qualifying delegating agents also receive
Agent ownership tools. See the [agent-definition schema](../reference/agent-definition-schema.md#managed-agent-coordination-tools)
for the exact eligibility, exclusion, and mandatory-tool rules.

A delegating agent:

- delegates only to its permitted agent definitions;
- owns only its direct agents;
- integrates direct agent results into its own assignment;
- remains subordinate to the lead's approved objective.

Nesting is bounded by the global `maxAgentDepth` setting (see
[Configuration](../reference/configuration.md)). Agents are numbered by
generation below the root controller: an agent started by a Lead, Manager, or
Chief has depth 1, its direct agents have depth 2, and so on. An agent whose
depth has reached `maxAgentDepth` is a leaf: its effective metadata and launch
policy remove the `agents` allowlist and delegation tools. With the default
`maxAgentDepth` of `2` the structure is:

```text
root controller (Lead, Manager, or Chief)
└── delegating agent        (depth 1)
    └── agent               (depth 2, leaf)
```

A root controller may have many direct agents, and each direct agent below the
limit that is explicitly delegation-enabled may have its own direct agents. A
delegation-capable agent remains an agent at every depth; it is not a separate
public role. `maxAgentDepth: 1` makes every agent a leaf; `maxAgentDepth: 4`
allows chains of four agents. Delegation at every level still requires the
launching agent's definition to list `agents`, and each level may delegate only
to definitions in its own allowlist. When a delegated agent's result is
delivered and cleaned up, any agents it still owns are closed with it, as they
are for a root controller. Questions from `await_owner`, results, stop, and
continuation always go through the direct owner, so each level behaves the
same whatever its depth. Lowering `maxAgentDepth` never removes running
agents: they stay manageable, but agents at the new limit can no longer start
further agents.

Physical placement is presentation only and never determines ownership. A
Lead's placement setting controls direct agents: `tab` shares one tab per lead,
`subtree` gives each direct agent a fresh tab, and `split` stays in the caller's
tab. Manager and Chief launches use their actual session cwd and the existing
definition trust and cwd rules, not an inferred supervised-project placement.
Nested delegation always splits inside the owner's current tab, regardless of
the setting.

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

## Delegation and parallelism

Delegate bounded execution work when an Agent can reasonably own it and the
handoff is useful. Keep trivial or inseparable work local.

Independence determines concurrency, not whether work is delegable. Run
independent assignments in parallel; keep dependent assignments ordered.
Prefer Agents for broad file inspection, large logs or command output, and
dataset analysis.

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

For a project Lead, Herdsman propagates its normal assignment response to the
Manager. Successfully delegated or continued managed Agent work delays that
response until the herd settles, so it can report outcome, validation, and
unresolved points. This is result propagation, not project closure; see
[Project orchestration](../guides/project-orchestration.md).

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

An agent may notify its exact direct owner without blocking through
`notify_owner`, or request an answer required to proceed through `await_owner`.

A delegating agent with no unresolved direct-agent work follows normal
`await_owner` eligibility. If unresolved direct agents exist, every unresolved
child must itself be validly blocked on an owner question. Ordinary active work
or an undelivered result still blocks escalation. Questions are not
automatically forwarded through an ownership chain.

## Closing

Closing a delegating agent cascades through its directly owned agents first.
Cleanup remains ownership-safe: if a required agent cannot be proved or
closed, the delegating agent is preserved rather than destructively guessing.

## See also

- [`await_owner` API](../reference/await-owner.md)
- [`notify_owner` API](../reference/notify-owner.md)
- [Lifecycle](lifecycle.md)
- [Handoffs and files](../guides/handoffs.md)
