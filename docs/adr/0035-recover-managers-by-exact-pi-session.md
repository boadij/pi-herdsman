# Recover Managers by exact Pi session

## Status

Accepted

## Context

Chief needs to select a project Manager and later recover that Manager without
confusing repository identity, current runtime state, and project execution
authority. Existing decisions persist durable intent and derive runtime state
from current evidence ([ADR 0002](0002-persist-intent-and-derive-runtime-state.md));
project assignments and direct supervision also have distinct authority
([ADR 0017](0017-use-project-assignments-for-managed-lead-authority.md),
[ADR 0021](0021-unify-direct-supervision-authority.md)).

## Decision

Identify a project by its verified local Git common directory, not by its
remote URL or Herdr workspace. Separate local clones remain separate projects;
worktrees sharing one common directory identify the same project.

Keep one minimal durable Manager recovery reference per verified project. It
identifies the exact Pi session to consider for recovery, but is not evidence
that the session is running, holds a Manager lease, or occupies any particular
Herdr placement. It does not grant Manager authority or create a project
assignment. Validate current session, repository, role, and runtime authority
before treating the reference as resumable.

An explicit Chief request to start a Manager uses a one-shot handoff bound to
the exact new Pi session to select the Manager startup route. The handoff is
startup intent only: it does not establish Manager authority or replace
repository verification and the existing Manager authorization requirements.

Resume restores that same Pi conversation rather than creating a new one. It
does not automatically resume any Leads or Agents; existing project assignments
remain governed independently by their current authority and lifecycle rules.

Direct supervision remains distinct from project-assignment authority. This
decision does not change the supervision capabilities in ADR 0021 or the
assignment-based authority in ADR 0017.

## Rationale and consequences

The local Git common directory identifies the checkout group Herdsman can
verify, while a remote URL may be shared by independent clones and a workspace
is runtime placement. A minimal exact-session reference enables recovery
without persisting liveness or placement as truth, or introducing a parallel
project-assignment system. Restoring only the Manager conversation preserves
the explicit boundary between Manager recovery and resuming subordinate
execution.
