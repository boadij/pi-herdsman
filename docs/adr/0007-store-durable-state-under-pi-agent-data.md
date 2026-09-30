# Store durable Herdsman state under Pi agent data

## Decision

Pi Herdsman will store recoverable persistent state under the resolved Pi agent data directory, inside a single `pi-herdsman/` namespace.

Durable coordination state, configuration, and reusable result artifacts belong under that root. Truly temporary prompt snapshots and generic overflow data may remain in operating-system temporary storage.

The Pi agent directory, including `PI_CODING_AGENT_DIR` when set, determines the storage root.

## Rationale

Recoverable coordination state must survive operating-system temporary-directory cleanup and ordinary process restarts.

Keeping Herdsman persistence under Pi's resolved agent-data location gives it the same user-level lifetime and relocation semantics as the Pi sessions it coordinates. Consolidating the state under one Herdsman namespace also avoids multiple competing configuration and persistence roots.

## Alternatives considered

- Store recoverable coordination state in the operating-system temp directory: rejected because temp storage does not provide the required lifetime.
- Split Herdsman configuration across Pi project/global settings and separate runtime paths: rejected in favor of one Herdsman-owned source of truth.

## Consequences

Persistent paths must be derived from Pi's agent directory rather than hard-coded user directories or OS-specific locations.

An absent Herdsman configuration uses defaults; removed legacy configuration locations do not require fallback reads or migration unless a future decision explicitly adds one.

Temporary data must not be promoted to durable authority merely because it is convenient to write there.
