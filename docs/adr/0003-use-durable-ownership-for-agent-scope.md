# Use durable ownership for managed Agent scope

## Decision

Pi Herdsman will use its durable ownership graph to determine which managed Agents belong to an exact Pi session and which operations that owner may perform on them.

Physical visibility in Pi or Herdr does not establish ownership. A root controller (Lead, Manager, or Chief) sees and controls only Agents reachable through valid durable ownership from its exact Pi session, including recursively owned descendants. A managed Agent sees and controls only its own descendants. Supervising a Lead does not grant access to that Lead's Agent tree.

The active role and effective configuration determine permission to start new Agent work. Durable ownership determines access to existing work; removing fresh-delegation permission does not remove ownership or recovery access.

Missing, foreign, ambiguous, cyclic, or otherwise unproven ancestry must not be projected into an unrelated owner's herd.

## Rationale

Runtime discovery can show sessions and processes without proving who owns them. Treating visibility as ownership risks exposing or controlling another Lead's work and makes authority depend on transient topology.

Herdsman already records ownership when delegation occurs. That durable relationship is the narrowest source of truth for scope and authorization and survives physical loss or temporary runtime ambiguity.

## Alternatives considered

- Infer ownership from currently visible Pi or Herdr topology: rejected because visibility does not prove delegation authority.
- Project unresolved or ambiguous ancestry into a nearby Lead for convenience: rejected because it can cross ownership boundaries.

## Consequences

Listing, continuation, cleanup, recovery, and other managed-Agent operations must validate durable ownership edges rather than perform global session discovery and guess relationships.

A physically lost Agent can remain part of its owner's herd when durable ancestry is still valid.

Unknown ownership remains unknown instead of being repaired heuristically.
