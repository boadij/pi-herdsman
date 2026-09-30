# Project orchestration

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

Use Manager when independent project work deserves separate Leads and Git
branches instead of more Agents inside one Lead's worktree.

Manager coordinates. Leads implement.

## Enter Manager mode

Start Pi in the primary workspace of the Herdr worktree group and run:

```text
/manager
```

The current Lead must be eligible for Manager mode and must not still own
unresolved Agent work. Only one live Manager can hold authority for a project
scope at a time. No prior chat turn or existing linked worktree is required in
an ordinary Git primary workspace.

The Manager overview shows branch-based project work and live direct Leads. Project status is `active`, `paused`, `finished`, or `conflict`; a live Lead's runtime state is separate.

## Start project work

Ask Manager for one bounded objective:

```text
Implement the API change on branch feat/api-change.
```

Manager delegates the work to a Lead. The Git branch is the durable semantic
work handle; the Lead is the current executor. Internal assignment and result
UUIDs are not project-work handles.

A branch is optional when starting new work. If no branch is supplied, Pi
Herdsman can generate one. The first delegation can create the first linked
worktree. If an unoccupied worktree for the branch already exists, Herdsman
reuses it instead of creating another checkout.

The exact model-facing operation is
[`staff_delegate`](../reference/staff.md#staff_delegate).

## Run independent work in parallel

Independent branches can run concurrently:

```text
Manager
├─ feat/api-change → Lead → Agents
└─ feat/docs       → Lead → Agents
```

Keep overlapping writers out of the same worktree. Workspace membership does
not imply ownership, and Manager must not start another writer beside a Lead
that already occupies the relevant worktree.

Parallelism is optional. Use separate Leads when the work is genuinely
independent enough to justify separate branch and execution boundaries.

## Coordinate without polling

Lead progress, questions, and results return through the direct supervision
edge. Manager can message or reply to a Lead without taking over its work.

Do not repeatedly inspect or list reports just to check whether they finished.
Use the current supervision state, and inspect live terminal or persisted
transcript evidence only when that evidence materially matters.

Assigned Leads use `supervisor_result` for terminal completion.
`supervisor_message` is for nonterminal progress or coordination.

## Pause and resume

Closing a managed Lead pauses execution but preserves:

- the project assignment
- the Pi session
- the Git branch
- the Herdr worktree

Resume the same work by branch. Herdsman resumes the saved project session
instead of creating a second assignment.

If the assignment's checkout is unavailable, the work remains `paused`. Restore
or reopen that checkout and retry, or discard the assignment and delegate again.
Herdsman does not recreate established work from a historical base.

See [`staff_close`](../reference/staff.md#staff_close) and
[`staff_delegate`](../reference/staff.md#staff_delegate).

## Abandon an assignment

Discard project work only when the assignment itself should be abandoned.

Discard removes the Herdsman assignment only after current topology proves
execution has stopped. The Git branch, worktree, and files remain. A possible
current Pi executor or a result that appears during discard preserves the
assignment. Completed durable results cannot be discarded as if they never
happened.

See [`staff_discard`](../reference/staff.md#staff_discard).

## Leave and return

Run:

```text
/manager leave
```

Leaving Manager mode preserves project work. A live Lead can continue and even
finish while no Manager is active. A later Manager sees the same repository and
branch-based work and reconciles durable completion. Replacing the primary
workspace does not re-key the assignment; Herdsman derives the current Herdr
topology again.

Leaving can be blocked when doing so would strand an active direct-supervisor
question, such as a Lead waiting for this Manager's reply or the Manager's own
pending ask to Chief.

This is why project work belongs to the branch rather than to one Manager
session.

## Use Chief only for the next supervision layer

Chief is separate from project orchestration. It supervises Managers across the
current Herdr runtime and can directly supervise ordinary Leads only when their
project scope has no active Manager.

A Manager does not become Chief and does not forward its direct Leads into a
parallel Chief control path.

See [Coordination](../concepts/coordination.md) and
[Commands](../reference/commands.md).

## Reference

- [Staff tools](../reference/staff.md)
- [Supervisor tools](../reference/supervisor.md)
- [Peer tools](../reference/peer.md)
- [Status widget](../reference/status-widget.md)
