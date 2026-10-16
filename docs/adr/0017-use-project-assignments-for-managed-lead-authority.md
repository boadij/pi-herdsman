# Use project assignments for managed-Lead authority

> **Lifecycle update:** [ADR 0019](0019-retire-project-assignments-when-worktrees-are-absent.md)
> supersedes the retirement conditions described below: verified checkout
> absence also retires assignments. Exact-assignment authority and confirmed
> `/takeover` remain unchanged; the current runtime implements the later policy.

## Status

Accepted

## Decision

`ProjectAssignment` is the sole durable source of Manager authority over
managed project execution. A Lead is assigned only when exactly one current
assignment for the repository names that exact Pi session. Active Managers
also supervise eligible ordinary Leads throughout their verified Herdr
worktree group for bounded discovery and communication. This derived
supervision grants no project assignment, lifecycle, Agent ownership,
automatic result delivery, or execution-control authority. Missing or
ambiguous assignment or topology evidence fails closed.

Authorized Manager messages may start a normal turn in an idle ordinary Lead.
Messages do not steer an active ordinary Lead or grant project execution
authority. Ordinary Leads retain their own execution and Agent ownership, and
responses are not automatically handed off as project results.

The relationship belongs to the project Manager role, not an individual
Manager process, so it survives Manager replacement. Lead ownership of its
Agent tree remains separate from Manager supervision: Managers never own Lead
Agents; `stop_lead` may stop only an assigned Lead's owned Agent tree as part
of stopping project execution. An ordinary Lead has one effective
supervisor: its verified active project Manager, otherwise Chief when eligible.
Assigned Leads do not fall back to Chief when Manager is unavailable.

Every completed direct turn by an assigned Lead automatically returns its
meaningful assistant response to the Manager role as a nonterminal project
message. When a herd run owns the work, its settlement remains the single
automatic handoff for that run; direct turn settlement does not produce a
second handoff. These results do not resolve project work. A managed Lead may
use nonblocking `message_supervisor` for a timely question, clarification,
warning, or other information the Manager needs before the normal result
boundary. Routine information that can wait should be included in the automatic
result instead; the two messages are not deduplicated.

The assigned Lead may explicitly release Manager authority with confirmed
`/takeover`. Takeover removes the current project assignment and its pending
project messages while preserving the Pi session and conversation, branch,
worktree, running process, and Lead-owned Agent tree. It does not assert that
work is complete, accepted, merged, or discarded. Successful Herdr worktree
removal remains a distinct assignment-retirement event (see
[ADR 0013](0013-use-herdr-worktree-removal-for-project-retirement.md)).
Settlement, Manager review, user interaction, and idle state do not release an
assignment.

Manually continuing the exact assigned Pi session keeps it managed. The
`managed-lead` definition remains launch policy and does not establish or
release authority. Status derives its contextual `· managed` marker from the
current assignment; Agent ancestry remains ownership-only.

## Rationale

Project assignments already represent durable project work and identify its
exact Lead executor. Using that existing record avoids deriving authority from
transient topology or introducing another persisted ownership flag. The same
durable edge naturally survives Manager turnover and exact-session
continuation.

Pi provides a deterministic direct-turn boundary but no trustworthy semantic
review-readiness signal. Returning each completed direct response therefore
avoids prompt-dependent completion inference. Herd-run settlement remains the
existing coalescing boundary for Agent-backed work. Routine result noise is
accepted; Managers should treat routine results as informational.

Takeover expresses only that Herdsman Manager orchestration no longer owns the
Lead as project work. Keeping the session and worktree allows the user to
continue independently without inventing a second user-owned assignment
state.

## Consequences

- Manager reports include assigned Leads and eligible ordinary Leads in its
  verified project worktree group. Ordinary reports allow communication only;
  private inspection and project lifecycle actions remain assignment-bound.
- An ordinary Lead with a verified active project Manager is not a Chief direct
  report; Chief fallback applies only when Manager absence is verified.
- An assigned Lead remains managed across Manager absence, replacement, user
  interaction, and manual continuation until takeover or successful Herdr
  worktree removal.
- Direct responses wake the Manager role; herd runs still emit one settled
  handoff rather than per-turn Agent results.
- Takeover removes assignment and pending messages but does not stop or restart
  any process, remove a worktree, alter a branch, or stop Lead-owned Agents.
- No new persisted managed flag, takeover tombstone, inferred-completion state,
  or Manager session identifier is added.
- Launch configuration is not hot-rewritten after takeover; it applies on a
  future normal process start.
