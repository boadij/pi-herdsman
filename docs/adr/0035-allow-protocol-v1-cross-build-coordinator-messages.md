# Allow protocol-v1 cross-build coordinator messages

## Status

Accepted

## Context

Build fingerprints provide useful compatibility evidence, but build equality is
too strict as the sole compatibility rule for ordinary coordinator messages.
This is a narrow exception to build-strict messaging compatibility, not a
change to authority or project execution rules.

## Decision

Ordinary coordinator messages may cross Herdsman build boundaries only when
each participant explicitly supports the same fixed messaging protocol, v1.
Build fingerprints remain diagnostic and continue to support same-generation
and local-consistency checks.

Message compatibility does not relax verification of authority, identity, or
scope. Project control and delegation remain build-strict. Strict
retained-message requirements and automatic project-result semantics are
unchanged.

There is no protocol negotiation, version range, adapter, configuration, or
migration.

## Rationale and consequences

An explicit shared messaging contract permits ordinary communication across
builds without treating build equality as proof of authority or changing
project execution semantics.

This decision complements [ADR 0002](0002-persist-intent-and-derive-runtime-state.md),
[ADR 0008](0008-prefer-native-pi-and-herdr-contracts.md),
[ADR 0014](0014-use-integration-agnostic-orchestration-primitives.md),
[ADR 0021](0021-unify-direct-supervision-authority.md), and
[ADR 0027](0027-deliver-complete-text-in-coordination-messages.md). Their
identity, compatibility, orchestration, authority, and delivery boundaries
remain in force.
