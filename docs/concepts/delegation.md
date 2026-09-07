# Delegation

[Documentation index](../README.md)

Delegation is bounded, direct, and ownership-local.

## Lead

The lead Pi session may delegate to any discovered effective agent definition.
The lead retains architecture, global scope, acceptance, integration, and final
decision authority.

## Delegating worker

A lead-launched worker becomes delegation-enabled when its effective definition
has a non-empty `workers` list and its tool policy permits the `worker` tool.
The worker receives only the definitions named by its effective `workers` list.

A delegating worker:

- delegates only to its permitted worker definitions;
- owns only its direct workers;
- integrates direct worker results into its own assignment;
- remains subordinate to the lead's approved objective.

Worker-started workers are leaves. Their effective metadata and launch policy
remove the `workers` allowlist and `worker` capability. This keeps the supported
structure bounded:

```text
lead
└── delegating worker
    └── worker
```

A lead may have many direct workers, and each direct worker that is explicitly
delegation-enabled may have its own direct workers. A delegation-capable worker
remains a worker at every depth; it is not a separate public role.

## Inferred `worker` capability

A non-empty `workers` field implies the `worker` tool when the definition uses
an explicit non-empty `tools` allowlist. An omitted tool allowlist keeps Pi's
default tool policy rather than creating a `worker`-only list.

Explicit denial wins:

- `excludeTools: ["worker"]` prevents inference.
- `noTools: true` prevents inferred `worker` unless `worker` is explicitly
  present in `tools`.
- An explicit exclusion wins over an explicit allow.

The exact field semantics live in the
[agent-definition schema](../reference/agent-definition-schema.md).

## Parallelism

Delegate genuinely independent or context-heavy work. Prefer workers for broad
file inspection, large logs or command output, and dataset analysis. Keep small,
tightly coupled work local.

Do not:

- delegate overlapping writers to one worktree;
- delegate review before the writer finishes;
- duplicate supplied reconnaissance;
- continue dependent work while a required worker is active.

A useful pattern is:

```text
delegating worker
├── scout: bounded reconnaissance
└── local independent analysis

worker result arrives
↓
delegating worker integrates both
```

## Clarification across ownership edges

A worker may ask its exact direct owner through `ask_owner`.

A delegating worker may ask its own direct owner when its unresolved direct
workers are themselves validly blocked on owner questions. Ordinary active
worker work or an undelivered worker result still blocks escalation. Questions
are not automatically forwarded through an ownership chain.

## Closing

Closing a delegating worker cascades through its directly owned workers first.
Cleanup remains ownership-safe: if a required worker cannot be proved or
closed, the delegating worker is preserved rather than destructively guessing.

## See also

- [`ask_owner` API](../reference/ask-owner.md)
- [Lifecycle](lifecycle.md)
- [Handoffs and files](../guides/handoffs.md)
