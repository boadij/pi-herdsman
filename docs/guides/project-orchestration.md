# Project orchestration

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

Use Manager when independent project work deserves separate Leads and Git
branches instead of more Agents inside one Lead's worktree.

Manager coordinates project assignments. Project Leads orchestrate and
integrate execution through their Agent trees.

Manager-created project Leads are launched from the reserved `managed-lead`
definition. The bundled default keeps direct Lead work read-only and delegates
executable project work to managed Agents while the Lead retains decomposition,
architecture, scope, technical direction, integration, conflict resolution,
acceptance, and final technical decisions. Project and global overlays can
deliberately customize that launch policy; see
[Customizing bundled agents](customizing-agents.md#managed-project-lead).

## Enter Manager mode

Start Pi in the primary workspace of the Herdr worktree group and run:

```text
/manager
```

Optionally, enable `Manager auto-start` in `/agents` to have a session with no
persisted role intent attempt the existing Manager startup path when it starts
in the project's primary workspace. The preference does not persist Manager
intent; explicit session roles take precedence, and an ineligible or contended
attempt remains an ordinary Lead.

The current Lead must be eligible for Manager mode and must not still own
unresolved Agent work. Only one live Manager can hold authority for a project
scope at a time. No prior chat turn or existing linked worktree is required in
an ordinary Git primary workspace.

Manager's work projection reports `active`, `paused`, or `conflict`. A live
Lead's runtime state is separate from project status.

## Start and resume project work

Ask Manager for a bounded objective:

```text
Implement the API change on branch feat/api-change.
```

Manager delegates the work to a Lead. The Git branch is the durable semantic
work handle; the Lead is the current executor. Internal assignment IDs are not
project-work handles. A branch is optional when starting new work. If omitted,
Pi Herdsman can generate one. The first delegation can create the first linked
worktree, and an unoccupied existing worktree for the branch is reused.

Start new work with `staff_delegate`. Resume existing work with
`staff_resume` using its branch. If its worktree is missing, Herdsman recreates
it from the existing branch and resumes the exact persisted Pi session when
available. The saved session cwd is used when history exists; if the branch
itself is unavailable, recreation fails closed.

Whenever Herdsman actually launches the project Lead process, it resolves the
current `managed-lead` definition from the target worktree plus the global
overlay. A trusted project may therefore configure the Lead that works on its
branch. A Lead that is already live is not hot-reconfigured; changed launch
policy takes effect on its next start.

See [`staff_delegate`](../reference/staff.md#staff_delegate) and
[`staff_resume`](../reference/staff.md#staff_resume).

## Run independent work in parallel

Independent branches can run concurrently:

```text
Manager
├─ feat/api-change → Lead → Agents
└─ feat/docs       → Lead → Agents
```

Keep overlapping writers out of the same worktree. Workspace membership does
not imply ownership, and Manager must not start another writer beside a Lead
that already occupies the relevant worktree. Use separate Leads when work is
independent enough to justify separate branch and execution boundaries.

## Coordinate and review

The assigned Lead's normal response to the initial project assignment is the
automatic handoff: Herdsman records it as a project message for the current or
a replacement Manager. If the Lead successfully delegates or continues
managed Agent work, the herd run owns that handoff until it settles, and the
settled response should summarize outcome, validation, and important unresolved
points. An unsuccessful delegation leaves the local assignment-response path
available. Later conversational replies, including routine thanks or
acknowledgments, stay local and are not automatically promoted. The handoff is
advisory, not project
completion: the assignment remains open through review and requested
corrections. Leads use `supervisor_message` only for material coordination
requiring the Manager's attention, decision, or action, not routine
acknowledgment or a duplicate handoff. Messages sent with this tool are retained
with the assignment, including when no Manager is active, and are available to
a replacement Manager. Lead settlement and Manager review do not retire the
assignment.

Use the current supervision state rather than repeatedly listing or inspecting
reports to poll for progress. Inspect live terminal or persisted transcript
evidence only when it materially matters.

## Pause and resume

`staff_stop` stops a Lead and its owned Agent execution tree while preserving
the assignment, Pi session, Git branch, and worktree. Resume the same work with
`staff_resume` using its branch. `staff_stop` does not resolve project work.

See [`staff_stop`](../reference/staff.md#staff_stop) and
[`staff_resume`](../reference/staff.md#staff_resume).

## Retire project work

Successful Herdr worktree removal retires the matching project assignment and
its retained messages; the Git branch remains. A worktree that is merely
missing does not imply retirement, so the assignment remains recoverable with
`staff_resume` when its branch is available.

## Leave and return

Run:

```text
/manager leave
```

Leaving Manager mode preserves project assignments. Current Herdr topology is
derived again when work is observed or resumed. A later Manager can continue
the same repository and branch-based work.

## Use Chief only for the next supervision layer

Chief is separate from project orchestration. It supervises Managers across
the current Herdr runtime and can directly supervise ordinary Leads only when
their project scope has no active Manager. A Manager does not become Chief and
does not forward its direct Leads into a parallel Chief control path.

See [Coordination](../concepts/coordination.md) and
[Commands](../reference/commands.md).

## Reference

- [Staff tools](../reference/staff.md)
- [Supervisor tools](../reference/supervisor.md)
- [Peer tools](../reference/peer.md)
- [Status widget](../reference/status-widget.md)
