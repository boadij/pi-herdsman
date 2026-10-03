# Use integration-agnostic orchestration primitives

## Decision

Pi Herdsman will expose integration-agnostic orchestration primitives rather
than embed provider-, model-, extension-, tool-, storage-, memory-, or
service-specific integrations in core.

This applies the project [product philosophy](../development/product-philosophy.md)
to architectural boundaries.

Herdsman owns coordination concerns that inherently belong to the orchestrator,
including managed-agent lifecycle, delegation, ownership, assignment delivery,
continuation, and supervision. When an external system needs to participate at
one of those boundaries, Herdsman may expose the smallest generic capability
required for that participation.

External state crossing such a boundary remains owned by the external
component. Herdsman should keep it opaque when practical and must not make core
behavior depend on its domain meaning.

A generic primitive must be justified by demonstrated need, such as multiple
independent consumers, established ecosystem practice, or a fundamental
Herdsman lifecycle requirement. Generalization stops at the narrowest shared
capability supported by that evidence.

Adjacent concerns remain separate unless Herdsman inherently owns them. For
example, lifecycle initialization does not itself justify generic RPC, metadata
transport does not imply secret management, and coordination does not imply
persistence of extension-owned state.

Optional integrations remain optional. Their absence must not alter normal
Herdsman operation.

This decision governs architectural ownership and abstraction boundaries. It
does not prescribe a specific extension API, transport, serialization format,
lifecycle hook, or implementation for any individual feature.

## Rationale

Herdsman coordinates Pi agents that may use different models, providers,
extensions, tools, storage systems, and external services. Encoding those
systems directly into core would make Herdsman's architecture grow with every
integration and couple orchestration semantics to dependencies it does not own.

At the same time, some external capabilities need access to lifecycle
boundaries controlled only by the orchestrator. A blanket refusal to expose
those boundaries would force integrations to duplicate orchestration or depend
on unstable implementation details.

The durable boundary is therefore capability-oriented: Herdsman exposes only
the orchestration primitive it uniquely owns, while external components retain
ownership of their domain semantics.

This keeps core small, allows unrelated integrations to compose through the same
primitive, and avoids turning one concrete integration request into a broader
framework without evidence.

## Alternatives considered

- Integrate important providers or extensions directly into Herdsman: rejected
  because each integration would add domain-specific dependencies, semantics,
  configuration, and lifecycle coupling to core.
- Avoid extension-facing orchestration capabilities entirely: rejected because
  some lifecycle boundaries are owned exclusively by Herdsman and cannot be
  reliably coordinated from outside.
- Build a comprehensive plugin or integration framework: rejected because it
  generalizes beyond demonstrated needs and risks duplicating capabilities
  already owned by Pi, Herdr, extensions, or external transports.
- Generalize from a single hypothetical future need: rejected because useful
  abstractions should follow concrete evidence rather than speculation.

## Consequences

New integration requests must first be reduced to the Herdsman-owned
orchestration capability they require.

Provider, model, extension, storage, and service names should not appear in
generic core contracts unless they are foundational Herdsman dependencies.

External state transported across Herdsman boundaries should remain opaque to
core and be interpreted only by its owner.

Herdsman should not persist external domain state merely because it transports
or coordinates it.

Fresh initialization, continuation, ongoing communication, persistence, and
credential transport remain distinct concerns unless concrete evidence shows
that Herdsman must own more than one of them together.

Nested orchestration should compose from the same generic primitives instead of
accumulating integration-specific inheritance rules.

When Pi or Herdr already provides an adequate primitive, Herdsman should use it
instead of creating a competing abstraction.

Future changes may extend this boundary only when concrete evidence shows the
narrower primitive is insufficient.
