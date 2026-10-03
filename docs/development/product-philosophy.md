# Product philosophy

Pi Herdsman is a thin orchestration layer for coordinating Pi agents.

It should own only the coordination problems that naturally belong to the
orchestrator, expose the smallest general capabilities needed at those
boundaries, and leave provider-, model-, extension-, tool-, storage-, and
service-specific behavior to the systems that own it.

## Own orchestration, not ecosystems

Herdsman owns delegation, ownership, supervision, lifecycle coordination,
assignment delivery, continuation, and the boundaries between managed agents.

It should not become the implementation home for capabilities that belong to
individual providers, models, extensions, tools, memory systems, or external
services.

When an external integration reveals a missing Herdsman capability, reduce the
request to the underlying orchestration need. Prefer a generic primitive that
can support independent consumers over direct support for a named integration.

## Generalize from evidence

Do not design abstractions for hypothetical future needs.

A generic capability should be justified by concrete use cases, repeated
ecosystem patterns, or a fundamental limitation of the current orchestration
model. Generalization stops at the narrowest common requirement demonstrated by
that evidence.

When Herdsman transports extension-owned or external state, keep it opaque when
possible. The owner of that state remains responsible for its semantics,
validation, persistence, compatibility, and domain behavior.

## Prefer composition over ownership

If Pi, Herdr, an extension, or another existing component already owns a
capability adequately, compose with it rather than duplicating it inside
Herdsman.

A requirement for one capability does not automatically justify adjacent
responsibilities. Initialization does not imply RPC. Metadata transport does not
imply secret management. Delegation does not imply shared memory. Lifecycle
coordination does not imply persistence of external state.

Expand Herdsman's ownership only when the additional responsibility is
inherently part of Herdsman's job.

## Keep optional capabilities optional

External integrations must not become required dependencies of normal Herdsman
operation.

When an optional capability is unused, existing behavior should remain
unchanged. The same generic orchestration primitives should compose through
nested delegation instead of accumulating provider-, root-, or
integration-specific inheritance rules.

## Keep the core small and correct

Prefer deletion, consolidation, native platform capabilities, and existing
abstractions over new framework layers.

New public contracts should be small, durable, and difficult to misuse.
Compatibility machinery, configuration, abstraction layers, and extension
points require demonstrated value.

Herdsman should not silently invent ownership, state, lifecycle outcomes, or
successful integration when required evidence is missing or contradictory.
Optional participation may be absent; participating behavior that cannot be
initialized correctly should fail explicitly rather than continue in a
partially valid state.

## Decision test

For any proposed feature, ask:

1. Is this fundamentally an orchestration problem Herdsman owns?
2. Does Pi, Herdr, an extension, or the platform already solve it adequately?
3. Is the need demonstrated by real use cases or ecosystem evidence?
4. What is the smallest provider-, model-, and extension-agnostic primitive
   that solves those cases?
5. Can everything else remain outside Herdsman?

If the answer to the first question is no, the feature probably does not belong
in Herdsman.

If a smaller primitive answers the need, build that instead.
