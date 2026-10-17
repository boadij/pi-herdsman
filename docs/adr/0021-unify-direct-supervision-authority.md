# Unify direct supervision capabilities independently of project assignments

[Documentation index](../README.md)

## Status

Accepted

## Context

Manager supervision covers eligible Leads throughout the Manager's verified
project worktree group, while `ProjectAssignment` identifies which Lead owns
managed project execution. The ordinary-supervision restrictions introduced
in [ADR 0017](0017-use-project-assignments-for-managed-lead-authority.md) and
refined through PRs #405 and #413 made direct-report observation and active
message delivery depend on assignment status, despite supervision being
verified independently.

## Decision

Verified direct supervision authorizes the same staff observation and
communication capabilities for assigned and ordinary Leads. This includes
bounded inspection, transcript reading when valid persisted session evidence is
available, and messaging; every operation still revalidates current identity
and authority.

Authorized supervisor messages use the same Pi-native cooperative steering
behavior regardless of project assignment. Steering is cooperative and does
not abort current work or interrupt an in-flight tool call.

`ProjectAssignment` remains the sole authority for managed project execution
and its lifecycle. Supervision alone does not grant project lifecycle
operations, project-result handoff, or accounting as managed work.

Exact-session ownership of Agents remains independent of supervision. A
supervisor does not acquire ownership of a Lead's Agent tree merely by
supervising that Lead.

This decision supersedes only the ordinary-supervision restrictions in ADR
0017, as refined by PRs #405 and #413, on inspection, transcript access, and
active-message steering. It does not supersede ADR 0017's exact-assignment
authority, ADR 0019's assignment-retirement rules, or ADR 0020's confirmed
worktree-removal requirements.

## Consequences

- Assigned and ordinary Leads in a verified direct-report scope have the same
  observation and communication capabilities, subject to current validation
  and transcript availability.
- Manager messages to ordinary Leads may cooperatively steer active work using
  Pi's native delivery behavior.
- Project execution and its lifecycle remain assignment-bound; no assignment
  is created or promoted by supervision.
- A Lead retains ownership of its Agent tree independently of who supervises
  it.
- No new permission system, durable record, or transport is required.
