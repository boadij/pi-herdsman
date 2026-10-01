# Keep semantic result references model-facing

## Decision

Pi Herdsman will keep semantic result references such as `result:<agent>#<index>` as the model-facing identity for reusable Agent results.

Canonical UUID-backed references such as `result:<request-id>` remain an internal storage and transport identity. They must not replace semantic references in model-visible completions, tasks, attachments, or ordinary coordination messages.

## Rationale

Raw UUIDs are already used throughout Herdsman for sessions, requests, runs, assignments, and other internal identities. Exposing additional UUIDs as result handles makes it harder for models to distinguish and correctly reuse the relevant identifiers. This problem was previously addressed by introducing semantic Agent result handles.

The semantic form conveys useful meaning directly:

`result:compatvalidation#1`

is easier for an Agent to recognize, discuss, select, and reuse than:

`result:6027ec74-219a-440b-af83-d6782fb4269f`

The semantic handle is therefore part of the model-facing UX, not merely presentation sugar.

## Required invariant

A result's semantic identity must remain stable across handoffs.

New semantic result references are unique within one Herdsman durable data
root and are never reused. Pi branch state determines whether a session may
resolve a semantic reference; it does not provide global identity allocation.
Allocation scope is the Herdsman data root, while availability remains scoped
to the current Pi branch and its explicitly imported evidence.

If a parent attaches `result:compatvalidation#1`, the receiving Agent must see that same reference associated with the attached evidence and must be able to forward that same reference later.

Internally, Herdsman may resolve the semantic reference to a canonical UUID-backed artifact, but that translation must not leak into model context or replace the semantic identity.

Conceptually:

`result:compatvalidation#1` -> hidden canonical result identity -> durable artifact

The model continues to interact only with `result:compatvalidation#1`.

## Architectural boundary

Semantic references are the model-facing addressing layer.

Canonical `result:<request-id>` references are the durable storage and internal transport layer.

Result provenance such as Agent label, definition, cwd, and Pi session identity describes where a result came from. Provenance does not replace or redefine the semantic result reference.

When a semantic result crosses a session boundary, Herdsman must preserve enough hidden binding information for the receiving session to resolve and subsequently forward the same semantic reference without exposing the canonical UUID.

Conflicting semantic mappings must fail closed rather than silently choosing, renaming, or shadowing one result. A conflict between newly created refs indicates malformed, tampered, or historical state rather than normal convergence of independent worktrees.

## Consequences

The implementation must not solve result handoff problems by exposing canonical UUID references to Agents, rewriting semantic references into UUIDs, or displaying both identities and asking the model to correlate them.

Internal metadata or durable session state may carry the semantic-to-canonical binding where necessary.

`files` remains the single model-facing evidence channel, and semantic result references remain valid values within it.

This decision intentionally prioritizes stable, meaningful model-facing identifiers over simplifying the implementation by exposing internal UUID identities.
