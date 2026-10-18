# Propagate explicit required assignment evidence

## Status

Accepted

## Decision

The current `ProjectAssignment` owns an explicit required-evidence set for a
verified managed project. Files explicitly supplied to `delegate_project` are
registered as required inputs. The Manager, assigned Lead, or an eligible
project-scoped managed Agent can add evidence through `update_assignment_evidence`;
the Manager identifies the assignment by branch, while the Lead and managed
Agent derive their verified assignment from runtime authority. A managed Agent
may remove only evidence it added locally; inherited evidence remains under the
project owner's authority.

Every new descendant assignment receives the effective required-evidence set
for its scope without relying on the delegating model to repeat those entries
in `files`. The accepted assignment carries a snapshot of that set. Later
changes do not silently rewrite an already-running child's assignment.

Required file evidence is preserved as a supported UTF-8 text snapshot up to
1 MiB. Unsupported, binary, or oversized files cannot be registered as
required evidence and fail explicitly. A supported preserved snapshot that
exceeds inline delivery limits may be delivered by reference. Agent results
retain their existing result binding rather than being copied.

Evidence registration is separate from messaging. `message_staff` remains a
communication operation and does not mutate assignment requirements.

Automatic required-evidence propagation is limited to verified managed
project assignments and their nested managed-Agent assignments. An ordinary
Lead's whole session is not an evidence scope. This decision does not introduce
inheritance of arbitrary conversation or attachments, and evidence
availability does not grant execution or control authority.

## Rationale

The existing `files` channel delivers evidence, but asking every delegating
model to remember every continuing requirement makes propagation unreliable.
Persisting only explicitly designated requirements on the authoritative
assignment makes delivery deterministic without creating a global artifact
registry or copying unrelated caller context.

The owner decides when a review or other artifact becomes a continuing
requirement. Keeping that decision distinct from messaging avoids treating
every communication as a change to project requirements. Snapshotting
supported text preserves the exact registered version while reusing the
existing file-preparation path for inline and reference delivery.

## Alternatives considered

- Automatically inherit all caller attachments or conversation context:
  rejected because it leaks unrelated context and obscures what a recipient
  received; see [ADR 0005](0005-use-files-for-explicit-evidence-handoffs.md).
- Rely on instructions to repeat requirements in every `files` argument:
  rejected because the reported failure is omission by the delegating model.
- Automatically retain every review result or message attachment: rejected
  because only the responsible assignment owner can decide which material
  becomes a continuing requirement.
- Define every ordinary Lead session as an assignment scope: rejected because
  the runtime has no safe task boundary for such sessions.
- Build a general project artifact database or retrieval system: rejected as
  unnecessary for the explicit assignment-level requirement.

## Consequences

- Required evidence is explicit assignment state and is delivered through the
  existing `files` preparation path.
- Owners can inspect the set and remove entries by exact evidence ID; an
  assigned managed Agent cannot remove inherited entries.
- New descendants inherit a snapshot, not live updates to an ancestor's
  evidence set.
- Initial project inputs must be supplied at `delegate_project` if they are to
  become required; Herdsman does not reconstruct omitted earlier context.
- Ordinary `files` behavior outside the required-evidence scope remains
  per-message, including reference-only files that are not snapshotted.
- Unsupported or oversized durable evidence must be handled as ordinary
  per-message evidence or reduced to supported text before registration.
- Removed evidence stops automatic propagation; this decision adds no artifact
  garbage collector or deletion of historical Pi-session evidence.
