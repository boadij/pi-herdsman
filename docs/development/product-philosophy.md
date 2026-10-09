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

## Make power progressive and native

Herdsman should be useful before users understand Herdsman.

Preserve familiar Pi and Herdr workflows, defaults, concepts, controls, and
configuration wherever they already fit the need. Introduce Herdsman-specific
vocabulary or parallel interaction patterns only for orchestration concepts the
underlying systems do not already express adequately.

Give users an obvious path to discover important capabilities, then reveal
complexity only when the current task requires it. Prefer progressive
disclosure and contextual explanation over requiring users to learn roles,
commands, settings, or architecture before they can begin useful work.

Do not build separate beginner and expert systems. The same underlying
capability and state should support both a discoverable path for learning and
direct commands or configuration for experienced users. Advanced workflows may
expose more control, but should compose from the same contracts rather than
forking product semantics.

Optional power should remain unobtrusive until needed. Installing or enabling
Herdsman should not force users away from familiar Pi workflows unless the
orchestration behavior they explicitly choose requires it.

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

Treat performance and efficiency as design goals across runtime, model-facing
interactions, and development workflows. As workloads and Agent counts grow,
avoid unnecessary latency, token use, computation, I/O, and resource
consumption. Prefer eliminating work over adding caches or infrastructure,
and justify optimization complexity with evidence. Never trade correctness,
reliability, security, or recovery for speed.

## Decision test

For any proposed feature, ask:

1. Is this fundamentally an orchestration problem Herdsman owns?
2. Does Pi, Herdr, an extension, or the platform already solve it adequately?
3. Is the need demonstrated by real use cases or ecosystem evidence?
4. What is the smallest provider-, model-, and extension-agnostic primitive
   that solves those cases?
5. Can everything else remain outside Herdsman?
6. Can the capability stay unobtrusive until needed, then be discoverable
   through a familiar path with direct access for experienced users?

If the answer to the first question is no, the feature probably does not belong
in Herdsman.

If a smaller primitive answers the need, build that instead.
