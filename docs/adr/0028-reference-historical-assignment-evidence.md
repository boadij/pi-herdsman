# Reference historical assignment evidence

## Status

Accepted

## Decision

Required evidence remains part of the accepted assignment and retains its
existing owner, source assignment, immutable version, and authorization scope.
Its presentation is decided for each handoff: the task and explicitly selected
current files are delivered first, while previously accepted requirements are
listed by stable semantic reference rather than automatically embedded.
Explicitly selecting an accepted requirement through `files` makes that exact
version current for the handoff without retaining it again or changing its
ownership.

Retained text snapshots have stable `evidence:<name>#<index>` references,
allocated uniquely within the Herdsman data root. Agent results retain their
existing `result:<agent>#<index>` references. References identify immutable
evidence but do not authorize access; retrieval is limited to evidence accepted
by the requesting assignment. A scoped, read-only `read_evidence` operation
provides bounded access to authorized references. Internal storage paths and
UUIDs are not model-facing identities.

This decision supersedes ADR 0025 only where it specifies embedding small
historical required evidence by default. Its decisions about evidence
ownership, retention, assignment scope, and inheritance remain in force, as
modified by ADR 0026. ADR 0001's semantic result identity, ADR 0005's explicit
`files` handoffs, and ADR 0027's complete-text coordination messages remain
unchanged.

## Rationale

Automatically embedding historical requirements makes every new assignment
repeat potentially unrelated content and obscures the distinction between
current task evidence and continuing requirements. Stable references preserve
discoverability and access without making handoff presentation change the
accepted evidence set. Explicit selection promotes a particular accepted
version for immediate inline delivery.

## Consequences

- Historical requirements are reference-only by default, regardless of size;
  no recency ranking or inline-count policy applies.
- Current explicit files and evidence newly retained by the handoff use the
  existing complete-content preparation and size validation.
- Unknown, foreign, ambiguous, or invalid references are not treated as paths.
- Continuation preserves the saved accepted evidence identities and scope.
- Durable evidence created before semantic references were introduced receives
  stable identities through a non-destructive transition; existing accepted
  evidence and provenance are not rewritten or discarded.
- This does not inherit arbitrary conversation or attachments, change result
  bindings, or weaken ordinary coordination-message delivery requirements.
