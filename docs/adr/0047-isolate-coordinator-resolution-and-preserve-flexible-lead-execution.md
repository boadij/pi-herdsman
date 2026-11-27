# Isolate Coordinator resolution and preserve ordinary Flexible Lead execution

## Status

Accepted

## Context

Coordinator profiles share the definition engine and overlays, but an
operation that resolves one profile does not need every other Coordinator
profile to be valid. Likewise, a valid ordinary Flexible Lead tool policy
should not be discarded because its independent Agent delegation roster is
invalid. Without these boundaries, unrelated configuration failures can
disable normal Pi execution or remove valid execution restrictions.

ADR 0039 requires discovery to reject files in unsupported Coordinator
locations with migration diagnostics. That runtime scan makes otherwise
irrelevant files a dependency of normal definition resolution.

## Decision

- Discover definitions only from the canonical category paths established by
  ADR 0045. Unsupported paths are not inspected, parsed, migrated, or used as
  compatibility sources.
- Resolve a specific Coordinator by category and frontmatter name through the
  existing layering engine. Validate and compose matching definitions only;
  still reject files whose identity cannot be established, invalid matching
  definitions, duplicates in an applicable scope, namespace violations, and
  forbidden project or private Chief overrides. Full inventory discovery
  remains strict and validates its complete result.
- Resolve an optional execution profile independently of its external Agent
  references only for a verified ordinary, unbound Flexible Lead. The profile's
  own structure, fields, tool policy, overlays, and body remain strictly
  validated. Current Agent discovery and applicable profile references are
  required before fresh delegation is authorized. Failure denies new
  delegation without discarding valid execution restrictions; verified
  ownership controls remain separate.
- If the selected optional Flexible Lead profile cannot be resolved during
  ordinary startup or branch restoration, a verified ordinary, unbound session
  keeps its existing saved native Pi tool baseline. Do not apply additions or
  exclusions from the unreadable profile, expand the baseline to every
  registered tool, or enable fresh delegation. This deliberately permits
  native tools that the unreadable profile may have intended to exclude: that
  policy cannot be reliably enforced when it cannot be read.
- The native-only failure behavior does not apply to invalid or conflicting
  session identity, quarantined or suspended sessions, invalid persisted
  execution state, assignments, exact-session profile bindings, managed
  sessions, or Manager and Chief roles. Those paths retain their existing
  fail-closed or strict behavior.
- A failed explicit profile refresh or mode transition leaves the previous
  valid policy and tool selection active. Repair and reapply through the
  existing Lead command; do not add a recovery role, persistent policy cache,
  or second lifecycle controller.

## Supersession

This decision supersedes ADR 0039's requirement to inspect unsupported
Coordinator locations and emit migration diagnostics, and the corresponding
runtime path scan. It does not change ADR 0045's canonical categorized paths,
category/name identity, exact-session bindings, or authority boundaries.
ADR 0034 and ADR 0038 continue to define namespace, trust, and overlay
precedence; their historical Coordinator path descriptions remain historical.
ADR 0015 and ADR 0018 remain in force for managed and supervisory authority.

## Consequences

- Invalid unrelated Coordinator execution fields no longer prevent a specific
  profile from resolving. Malformed or unidentifiable definitions remain
  conservative failures, and inventory discovery remains complete and strict.
- An invalid Flexible profile during ordinary startup or branch restoration
  cannot enforce unknown exclusions. The limited native fallback and disabled
  delegation must be visible in diagnostics and model-facing capabilities.
- Agent configuration changes cannot grant stale delegation authority: live
  root delegation policy and the existing Agent launch, acceptance, and
  publication checks resolve current definitions.
- Existing native Pi selection, exact-session identity, managed assignments,
  supervision, and tool-dispatch enforcement remain authoritative.
