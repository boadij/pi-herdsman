# Propagate explicit required assignment evidence

## Status

Accepted

## Decision

The current `ProjectAssignment` owns an explicit required-evidence set for a
verified managed project. The initial task supplied to `delegate_project` is
snapshotted as `project-brief.txt`, alongside files explicitly supplied to
`delegate_project`, and is inherited as required evidence by descendants.
Ordinary `delegate_agent.task` text remains specific to that recipient and is
not retained or inherited. New requirements are retained through existing
handoffs, not a standalone model-facing evidence tool. A Manager uses
`message_staff(..., retain: true)` to retain the message text and files for the
target assigned Lead's project assignment. The immediate handoff uses the same
immutable retained file snapshots as the project evidence, so the recipient
and descendants receive the accepted versions. An assigned Lead uses
`delegate_agent(..., retain: true)` to retain supplied files for that project
assignment. An eligible managed Agent uses the same delegation parameter to
retain supplied files only in its local assignment for descendants. Omitted or
false `retain` leaves files scoped to the current handoff. Retention requires
verified assignment authority and eligible evidence and fails explicitly
rather than silently degrading to ordinary delivery. Persistence and handoff
are one logical operation; if persistence succeeds but delivery fails, the
operation is reported as partial success, distinguishing retained evidence
from a failed immediate handoff.

This supersedes the former separate evidence-registration interface. The
Manager targets the exact assigned Lead session; the Lead and managed Agent
derive their assignment from verified runtime authority. A managed Agent
cannot change the parent project's requirements or remove inherited evidence;
internal removal remains limited to exact evidence IDs under existing
ownership rules.

Every new descendant assignment receives the effective required-evidence set
for its scope without relying on the delegating model to repeat those entries
in `files`. This combines inherited and local requirements with the explicit
files for that handoff. File attachments are deduplicated by canonical path or
matching content digest, so an original file identical to its retained
snapshot is included only once; an explicit file with different, newer content
is preserved alongside the retained snapshot. Result evidence uses
result-binding deduplication. The accepted assignment carries a snapshot of
that set. Later changes do not
silently rewrite an already-running child's assignment. Project descendants
inherit project requirements; nested descendants also receive relevant
Agent-local additions, while siblings do not inherit one another's additions.
Forwarding inherited evidence preserves its original `sourceAssignmentId` and
does not transfer its ownership.

Required file evidence is preserved as a supported UTF-8 text snapshot up to
1 MiB. Unsupported, binary, or oversized files cannot be registered as
required evidence and fail explicitly. Small supported text is embedded;
content exceeding inline limits is delivered by reference to the preserved
snapshot, with an instruction to read it before proceeding. Result evidence
retains its existing semantic binding rather than being copied, embedding text
when it fits or referencing its resolved artifact otherwise. Configured inline
and mailbox budgets apply; required evidence is not silently omitted for
exceeding an inline threshold.

Automatic required-evidence propagation is limited to verified managed
project assignments and their nested managed-Agent assignments. An ordinary
Lead's whole session is not an evidence scope. An unassigned Lead or unrelated
session acquires no automatic evidence scope. This decision does not introduce
inheritance of arbitrary conversation or attachments, and evidence availability
does not grant execution or control authority. Continuation preserves the
accepted evidence snapshot and still requires valid ownership authority;
retired project assignments cannot be resumed.

## Rationale

The existing `files` channel delivers evidence, but asking every delegating
model to remember every continuing requirement makes propagation unreliable.
Persisting only explicitly designated requirements on the authoritative
assignment makes delivery deterministic without creating a global artifact
registry or copying unrelated caller context.

The responsible owner decides what evidence becomes a continuing requirement
at the moment of an existing coordination handoff. `retain: true` makes that
choice explicit without requiring a separate tool call or making every
message/delegation attachment durable. Snapshotting supported text preserves
the exact version while reusing the existing file-preparation path for inline
and reference delivery.

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
- Existing internal logic can identify and remove evidence by exact ID under
  assignment ownership; there is no standalone model-facing evidence
  management tool. An assigned managed Agent cannot remove inherited entries.
- A Manager removes project-owned requirements through the existing project
  assignment menu: inspect an exact entry under **Required evidence**, choose
  **Remove**, and confirm. Inherited baseline entries are protected. Removal
  deletes neither snapshots/source files nor evidence already accepted by
  Agents. This project UI cannot remove managed-Agent-local additions; neither
  assigned Leads nor managed Agents have a separate evidence-removal UI, and
  Agent-local removal remains internal only.
- New descendants inherit a snapshot, not live updates to an ancestor's
  evidence set.
- The initial `delegate_project` task and supplied files become required
  project evidence. Later `delegate_agent.task` text is recipient-specific and
  is not retained; requirements intended for descendants must be retained
  through the applicable coordination operation.
- Ordinary `files` behavior outside the required-evidence scope remains
  per-message, including reference-only files that are not snapshotted.
- Unsupported or oversized durable evidence must be handled as ordinary
  per-message evidence or reduced to supported text before registration.
- Removed evidence stops automatic propagation; this decision adds no artifact
  garbage collector or deletion of historical Pi-session evidence, and does
  not retroactively remove evidence already accepted by an Agent.
