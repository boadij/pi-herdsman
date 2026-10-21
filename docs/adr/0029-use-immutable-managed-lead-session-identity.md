# Use immutable Managed Lead session identity

## Status

Accepted

## Decision

Persist one exact-session-bound `pi-herdsman-session-kind` custom Pi entry for
an initialized root session: ordinary or managed, with managed repository and
branch provenance. Read identity from all session entries, not the active
conversation branch. Matching malformed or conflicting identity fails closed;
copied foreign-session records confer no identity or authority. Identity is
initialized before role restoration, profile projection or coordination.

`ProjectAssignment` remains the sole authority for project execution. Derive
Managed Lead lifecycle as assigned, unavailable or retired from verified current
assignment and checkout evidence, without another status database or tombstone.
Retirement never changes session kind or exact Agent ownership. Missing or
contradictory evidence denies fresh work without granting ordinary tools;
independently authorized exact-owner recovery and pending deliveries remain.
Managed sessions cannot activate Manager/Chief or select ordinary profiles.
Ordinary direct supervision remains governed by ADR 0021.

Remove in-place takeover and its assignment-release path. Use Pi's native
fork/clone for independent ordinary continuation: new exact session IDs inherit
history, not project authority, Agent ownership, role or execution policy.
Bind existing role/profile records to their exact session IDs. Resume preserves
identity; tree navigation cannot change it. Native history copying neither
creates a separate Git checkout nor resets process-level configuration.

## Rationale and consequences

Identity, assignment authority, Agent ownership and verified runtime state are
independent concerns. Existing Pi entries, assignment locks and exact-owner
recovery suffice; no conversion service, ownership migration or copy system is
needed. Verified Herdr retirement, human-approved non-forced removal,
commit-before-cleanup ordering and pending Manager retirement context remain
as defined by ADRs 0019–0023. Retirement does not establish completion or safe
termination of a live Pi process.

This supersedes the takeover and post-takeover ordinary-profile decisions in
ADRs 0017 and 0018, and takeover references in ADRs 0012, 0013, 0019, 0020,
0022 and 0023. Their unrelated authority and retirement decisions remain.
