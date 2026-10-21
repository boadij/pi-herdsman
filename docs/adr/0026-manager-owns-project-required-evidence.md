# Manager owns project required evidence

## Status

Accepted

## Decision

The Manager alone owns project-wide required evidence. Initial project
creation retains the project brief and supplied files; retained Manager staff
messages can add requirements. The Manager's existing exact-ID removal
operation remains subject to inherited-evidence protections.

Root Leads have no evidence-retention capability through delegation.
Ordinary `files` are per-handoff evidence. Eligible managed Agents may retain
local evidence for their own descendants, without changing project requirements.

This supersedes the assigned-Lead project-retention authority in
[ADR 0025](0025-propagate-explicit-required-assignment-evidence.md).
Immutable storage, automatic inheritance, and accepted assignment snapshots
remain unchanged. Existing evidence is neither migrated nor pruned.

## Rationale

Project requirements and acceptance belong to the Manager. Removing the
Lead's project writer prevents task-specific handoffs from becoming permanent
requirements, rather than relying on instructions to discourage promotion.

## Consequences

The latest Manager retention update selects the current batch for later
eligible descendants; earlier required entries remain historical references.
Accepted Agent sessions freeze that selection for exact continuation. Receipts
for successful Agent delegation describe only evidence in the acknowledged
task and do not claim it was consumed. Presentation changes do not transfer
Manager authority.

Leads can forward findings directly for immediate correction. Promoting new
continuing requirements needs an additional evidence handoff to the Manager,
who decides whether to retain them through existing staff messaging.
No approval protocol or new tool is introduced.
