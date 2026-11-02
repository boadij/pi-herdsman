# Authorize verified Managers to access project evidence

## Status

Accepted

## Context

A Manager coordinates multiple Lead assignments in one verified project, but
semantic result and retained-evidence references do not themselves grant
access. Requiring a Lead to re-send every reference to its Manager duplicates
handoffs without a corresponding change in evidence ownership.

This decision builds on:

- [ADR 0003](0003-use-durable-ownership-for-agent-scope.md): supervision does
  not expand Agent ownership or grant access to another Lead's Agent tree.
- [ADR 0005](0005-use-files-for-explicit-evidence-handoffs.md): `files` remains
  the explicit channel for delivery across ownership roots.
- [ADR 0028](0028-reference-historical-assignment-evidence.md): semantic
  references identify evidence but do not authorize access.

## Decision

An active, verified Manager may read published results rooted in its current
project assignments and retained evidence accepted by those assignments,
including evidence whose nested Agent ancestry is verified. This is read access
to the exact current project scope, not broader Agent ownership, Lead
assignment authority, or access based on a reference alone. Invalid,
ambiguous, stale, or foreign evidence remains unavailable.

The Manager may explicitly deliver selected evidence to another recipient with
that operation's existing `files` parameter. Cross-root access by the recipient
begins only through that explicit transfer; sibling assignments do not
automatically share evidence. A retained text snapshot selected as required
evidence for a different assignment is copied as a new snapshot owned by the
receiving assignment. Immediate handoff does not change the source snapshot's
ownership or accepted requirements.

Before publication of an evidence-bearing operation, the runtime revalidates
the active Manager authority, exact repository scope, and applicable source and
destination assignments immediately before the authoritative publication.
That final validation and publication are synchronous with no asynchronous gap.
A completed publication remains valid if the Manager later loses its lease; an
incomplete or failed publication must not be reported as successful. This is a
synchronous final-validation boundary, not strict cross-process atomicity.

## Consequences

- Managers can inspect verified project evidence without requiring redundant
  Lead-to-Manager transfers.
- `files` remains explicit and is still required to deliver evidence across
  ownership roots; access does not imply inheritance or transfer.
- Durable Agent ownership, accepted evidence provenance, and assignment
  boundaries remain unchanged.
- No stronger transaction between Manager lease lifecycle and evidence
  publication is promised.
