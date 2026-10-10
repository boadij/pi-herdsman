# Project orchestration

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

Use Manager when independent project work deserves separate Leads and Git
branches instead of more Agents inside one Lead's worktree.

Manager controls the Leads named by current project assignments; project scope
alone grants no authority over a Lead. Project Leads own technical decisions
and orchestrate execution through their Agent trees.

Manager-assigned project Leads use only the reserved `managed-lead` definition,
regardless of an ordinary Lead's saved execution preference. The bundled
default keeps direct Lead work read-only and delegates executable project work
to managed Agents while the Lead retains decomposition,
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

Start new work with `delegate_project`. Resume existing work with
`resume_project` using its branch. A verified Git inventory showing the
assignment's worktree checkout is absent retires that assignment and its
pending project messages; failed or ambiguous inventory preserves it. A retired
assignment cannot be resumed, but a new delegation may start managed work from
the remaining Git branch. Retirement does not delete branches or Pi sessions.

A Lead with a verified project assignment receives a native Pi session name
from its branch. Existing names, including names explicitly cleared in Pi, are
preserved; use Pi's `/name` command to choose or change a name.

Whenever Herdsman actually launches the project Lead process, it resolves the
current `managed-lead` definition from the target worktree plus the global
overlay. A trusted project may therefore configure the Lead that works on its
branch. A Lead that is already live is not hot-reconfigured; changed launch
policy takes effect on its next start.

See [`delegate_project`](../reference/staff.md#delegate_project) and
[`resume_project`](../reference/staff.md#resume_project).

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

While a Lead remains assigned, Herdsman automatically returns every completed
direct Lead response to the Manager role. If no Manager is available, the
handoff remains pending until a Manager can receive it. When managed Agent work
is active, the herd run owns that handoff until it settles; the response
summarizes outcome, validation, and important unresolved points. These nonterminal handoffs do not
close project work: assignments remain open through
review and requested corrections. Routine information that can wait should go
through the automatic result handoff. A managed Lead may use nonblocking
`message_supervisor` for a timely question, clarification, warning, or other
information the Manager needs before that boundary; the Lead may choose to wait
for a response through `message_staff`. A later automatic result may repeat
some information; separate messages and results are not deduplicated.

Automatic project reports transfer summary text only, not files. A result
reference mentioned in a report is informational; mentioning it does not itself
make that result available, though the Manager may already have its binding from
an earlier handoff. When asking the reporting Lead to revisit its own result,
the Manager can mention the reference in `message_staff.message` without
attaching it. Use `message_staff.files` to transfer relevant readable local
files or result references resolvable on the current Pi branch. A semantic
result reference is resolvable when the branch contains its direct Agent
completion or an explicitly imported binding; already-supplied canonical result
references may also be passed through. If the Manager needs an artifact for
review or onward delegation, the Lead explicitly transfers it through
`message_supervisor.files`.

Only a Lead turn confirmed as not aborted contributes a completed response.
Cancellation is reported as a factual, nonterminal project message without
including partial assistant output. A restored unfinished herd run has no
verified prior summary, so it uses a generic settlement handoff unless a later
Lead response settles successfully.
Managers should treat routine results as informational and act when useful
coordination is needed.

Use the current supervision state rather than repeatedly listing or inspecting
reports to poll for progress. Inspect live terminal or persisted transcript
evidence only when it materially matters.

## Pause and resume

`stop_lead` stops a Lead and its owned Agent execution tree while preserving
the assignment, Pi session, Git branch, and worktree. Resume the same work with
`resume_project` using its branch. `stop_lead` does not resolve project work.

See [`stop_lead`](../reference/staff.md#stop_lead) and
[`resume_project`](../reference/staff.md#resume_project).

## Retire project work

Successful Herdr worktree removal or verified checkout absence retires the
matching project assignment and any still-pending messages; the Git branch
remains. Failed or ambiguous inventory does not imply absence, so the
assignment is preserved until authoritative evidence is available. An assigned Lead can explicitly
release Manager control with `/takeover`; after confirmation, the assignment
and pending project messages are removed while its Pi session, conversation,
branch, worktree, running process, and owned Agents remain. The continuing
session becomes an ordinary Lead in `Orchestrate` mode using
`orchestrator-lead`. This does not change launch-time model, thinking,
extensions, skills, or context, and does not claim the work is complete or
accepted. Takeover and worktree removal are distinct explicit assignment
release paths; settlement, review, and user interaction do not release an
assignment.

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
the current Herdr runtime and directly supervises ordinary unassigned Leads,
including Leads sharing project scope with an active Manager. Managers control
only Leads named by current project assignments; their authority survives
Manager process replacement. A Manager does not become Chief and does not
forward assigned Leads into a parallel Chief control path.

Manually continuing the exact assigned Pi session within valid project scope
keeps it managed. Execution profiles configure behavior, not authority: only
the current exact `ProjectAssignment` establishes Manager control (see
[Coordination](../concepts/coordination.md)).

See [Coordination](../concepts/coordination.md) and
[Commands](../reference/commands.md).

## Reference

- [Staff tools](../reference/staff.md)
- [Supervisor tools](../reference/supervisor.md)
- [Peer tools](../reference/peer.md)
- [Status widget](../reference/status-widget.md)
