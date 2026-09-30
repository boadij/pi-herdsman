# Prefer native Pi and Herdr contracts

## Decision

Pi Herdsman will build against supported native Pi and Herdr contracts rather than maintain parallel wrappers, aliases, duplicated identity fields, or speculative compatibility behavior for superseded interfaces.

At integration boundaries, Herdsman should use the upstream contract directly, validate it strictly, and fail closed when required identity or protocol evidence is malformed or ambiguous.

Compatibility code is justified only by an explicit supported compatibility requirement, not by the possibility that an older or undocumented shape might still appear.

## Rationale

Parallel compatibility paths duplicate semantics and make it unclear which contract is authoritative. They also allow malformed or obsolete upstream data to be interpreted as valid Herdsman state.

Consolidating on the supported Pi and Herdr interfaces reduced redundant launch identity, unsupported aliases, obsolete wrappers, and fallback parsing while preserving the Herdsman-specific ownership and lifecycle rules layered above them.

## Alternatives considered

- Preserve aliases and wrappers for superseded upstream shapes: rejected because they create a second contract Herdsman must maintain and test.
- Accept partial or malformed upstream identity and reconstruct the missing meaning locally: rejected because identity-sensitive operations must not guess.

## Consequences

Version support must be explicit and truthful.

Upstream contract changes may require deliberate breaking changes in Herdsman rather than indefinite compatibility shims.

Herdsman-specific policy remains its responsibility, but it should not reimplement capabilities or identity semantics already provided authoritatively by supported Pi or Herdr versions.
