# Persist durable intent and derive runtime state

## Decision

Pi Herdsman will persist durable coordination intent and identity, while deriving transient runtime state from current Pi and Herdr evidence.

Persisted assignments, ownership, ancestry, exact Pi session identity, and other durable facts remain authoritative across process and topology changes. Pane presence, process presence, placement, and live lifecycle state are observations and must be recomputed from current evidence rather than treated as durable truth.

Ambiguous or conflicting runtime evidence must fail closed. Herdsman must not invent ownership, placement, or liveness from stale observations.

## Rationale

Pi processes, Herdr panes, and runtime placement can disappear, move, restart, or become temporarily unobservable while the underlying assignment and ownership relationship still exists.

Persisting those transient observations as authoritative state creates stale-state failures and makes recovery depend on historical runtime details that may no longer be true.

Herdsman therefore separates what must survive from what can be observed again.

## Alternatives considered

- Persist live placement and process state alongside the assignment: rejected because those values become stale when Herdr or Pi runtime state changes.
- Reconstruct missing ownership from whatever runtime objects remain visible: rejected because incomplete or conflicting evidence can associate work with the wrong owner.

## Consequences

Recovery and presentation must derive current runtime state from coherent fresh evidence while preserving durable assignments that are merely lost or temporarily unknown.

Destructive operations must revalidate current evidence instead of trusting previously observed placement.

This boundary may require more explicit identity checks, but it avoids a second reconciliation authority and prevents stale runtime state from silently becoming policy.
