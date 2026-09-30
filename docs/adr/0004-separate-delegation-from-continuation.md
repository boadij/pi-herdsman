# Separate fresh delegation from historical continuation

## Decision

Pi Herdsman will expose fresh Agent delegation and historical Agent continuation as distinct operations.

Delegation creates a new definition-backed assignment. Continuation resumes an exact previously owned Pi session and restores its saved identity, definition, label, and working directory from durable history.

Continuation selectors must not allow callers to rename the session or override identity-defining fields that belong to the saved session.

## Rationale

Fresh work and historical continuation have different identity and validation semantics. Combining them behind one overloaded operation made it possible for caller-supplied fields to conflict with saved session identity and obscured which lifecycle rules applied.

Separating the operations keeps creation inputs explicit while making continuation an identity-preserving lookup rather than a second form of delegation.

## Alternatives considered

- Overload delegation with an optional session selector: rejected because fresh-assignment fields and historical-session identity become ambiguous or contradictory.
- Rediscover continuation targets from the user's global Pi session store: rejected because Herdsman already has the exact owned session history and global discovery includes unrelated sessions.

## Consequences

Fresh handoffs use delegation. Reuse of an existing managed Pi session uses continuation.

Continuation resolution must come from reachable Herdsman ownership history and validate the exact persisted Pi session before activation.

New features must not reintroduce caller-controlled identity overrides as continuation parameters.
