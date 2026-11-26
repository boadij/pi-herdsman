# Authorize Chief to stop a verified supervised hierarchy

## Status

Accepted

## Context

[ADR 0021](0021-unify-direct-supervision-authority.md) keeps project lifecycle
authority separate from direct supervision and explicitly preserves each
Coordinator's ownership of its Agent tree. Chief needs one narrow lifecycle
operation to stop a selected verified hierarchy without acquiring project
assignment authority or Agent ownership.

## Decision

Chief may stop execution child-first within an explicitly selected, currently
verified supervised scope: one exact Manager and its eligible assigned and
ordinary supervised Leads; all Chief-supervised staff; or that staff scope
followed by a request for Chief's own graceful Pi shutdown. Ordinary Leads are
eligible only while their current direct or selected Manager supervision is
verified. Assigned Leads whose Manager authority is unavailable do not become
Chief targets.

Stopping a Coordinator includes only its own currently verified Agent tree.
Supervision does not transfer Agent ownership. This authority does not permit
Chief to create, mutate, or retire assignments; integrate Git; remove
worktrees; or control execution outside the selected verified scope. Project
work, branches, worktrees, Pi history, assignments, and Manager recovery
references remain intact.

Participating Coordinator starts, role activation/restoration, project work
delegation/recovery, and Agent delegation/continuation share a process-lock
admission boundary scoped to the current Pi profile and Herdr socket. The lock
serializes admission with shutdown; it does not replace narrower Manager,
assignment, session, Agent ownership, or Herdr lifecycle locks. An admitted
Coordinator child may complete startup only through its exact startup intent
while its admission claim and launch identity remain current. Uncertain or
incomplete observations block a complete result.

`staff` shutdown leaves Chief running. `all` requests graceful exit through
Pi's native shutdown contract only after descendants are verified settled; a
tool result reports the request, not externally observed process exit.

This decision supersedes only ADR 0021's restriction on supervision-only
execution control. All other assignment, ownership, project lifecycle, and
cross-profile authority boundaries remain in force.

## Consequences

- A stable target from current staff discovery selects the Manager; display
  names, repository paths, and arbitrary session IDs do not.
- The selected descendants stop before their owning Coordinators. A blocked
  child preserves its ancestor.
- Shutdown may temporarily block unrelated admissions in the same Pi
  profile/socket, but does not stop or mutate unrelated running work.
- Unknown, incompatible, unsettled, or changed identity produces a blocked or
  partial result rather than proof of absence.
- Native Chief shutdown may be deferred by Pi until queued work and the active
  operation settle. Only the external runtime can confirm process exit.
