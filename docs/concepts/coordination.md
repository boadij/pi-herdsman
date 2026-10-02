# Coordination

[Documentation index](../README.md) · [Project orchestration](../guides/project-orchestration.md)

Pi Herdsman separates supervision, execution ownership, and physical placement.
Those relationships intentionally do not collapse into one global Agent tree.

## Roles

```mermaid
flowchart TD
    C[Chief] -->|supervises| M[Manager]
    M -->|coordinates| L1[Lead]
    M -->|coordinates| L2[Lead]
    L1 -->|owns| A1[Agent]
    A1 -->|may own| A2[Agent]
    L2 -->|owns| A3[Agent]
```

The same model in text:

```text
supervision: Chief -> Manager -> Lead
ownership:                    Lead -> Agent -> Agent
```

When a project has no active Manager, Chief may directly supervise its ordinary
Leads. A Chief never gains Agent ownership through that fallback.

### Lead

Every normal session starts as a Lead. A Lead owns its assigned objective and
its direct Agents. A delegation-enabled Agent may in turn own only the Agents
its definition permits.

A Lead and its recursively owned Agent hierarchy form a **herd**.

### Manager

Manager is a dedicated project-coordination mode. It coordinates ordinary Leads
inside one Herdsman project scope and has no `agent` capability of its own.

Project execution belongs to Leads and their Agent trees. Manager can inspect
and communicate with direct Leads, but it does not acquire ownership of their
Agents.

### Chief

Chief is an optional workspace-neutral supervision mode for one Herdr runtime.
It acts on current Managers and on ordinary Leads whose project scope has no
active Manager.

Chief can observe bounded descendant summaries but acts only on direct reports.

### Agent

An Agent performs one bounded delegated assignment for its exact owner.
Delegation-enabled Agents may own permitted direct Agents. Managed Agents do not
participate in Manager, Chief, staff, supervisor, or peer authority.

## Project scope

A Herdsman **project** is the coordination scope corresponding to one Herdr Git
worktree group: its primary workspace plus linked-worktree workspaces.

Manager authority is scoped to that group. A Lead in the primary workspace may
enter Manager mode; a Lead in a linked-worktree workspace remains a Lead. An
ordinary Git primary workspace does not need an existing linked worktree before
Manager activation; the first project delegation can create one.

Workspace membership is physical placement, not assignment ownership. Multiple
Leads can share a workspace, and a branch can have a worktree without implying
that every session in that workspace owns its work.

## Project work belongs to a branch

Manager-delegated project work is durable and keyed by repository plus semantic
Git branch.

Within one repository, the branch is the public work handle. A Lead is the
current executor. The assignment's exact Pi session ID is an internal executor
identity; exact session IDs are used only when acting on a live Lead.

Because durable work is not keyed by a Manager or primary workspace identity, a
replacement Manager or replacement primary workspace for the same repository
does not create a new project assignment. Current Herdr topology is derived
again when the work is observed or resumed.

```text
project work
    ├─ branch feat/a → current Lead → Agent tree
    └─ branch feat/b → current Lead → Agent tree
```

The assignment is the durable indicator that project work remains open. It
survives Manager turnover and runtime loss; current Herdr placement is derived
again when the work is observed or resumed. When a project herd run settles,
Herdsman handles the normal Manager handoff automatically. Leads summarize the
outcome, validation, and important unresolved points in their normal response;
the handoff is advisory and does not resolve the assignment. Assigned Lead
messages are also retained with the project and remain available to a
replacement Manager. Project retirement follows the Herdr worktree lifecycle;
see [Project orchestration](../guides/project-orchestration.md) for the
workflow.

`staff_stop` pauses execution while preserving the assignment, Pi session,
branch, and worktree. Successful Herdr worktree removal retires the matching
assignment and its retained project messages while preserving the Git branch.
A worktree that is merely missing does not retire the assignment; it remains
recoverable through `staff_resume`.

For the task-oriented workflow, see
[Project orchestration](../guides/project-orchestration.md). Exact operations
live in [Staff tools](../reference/staff.md).

## Direct edges only

Coordination crosses one authority edge at a time:

| Direction | Interface              | Boundary                                             |
| --------- | ---------------------- | ---------------------------------------------------- |
| Down      | `staff_*`              | Chief -> direct Manager/Lead, Manager -> direct Lead |
| Up        | `supervisor_*`         | Lead -> Manager or Chief, Manager -> Chief           |
| Sideways  | `peer_*`               | Lead <-> Lead or Manager <-> Manager                 |
| Ownership | `agent_*`, `ask_owner` | owner <-> directly owned Agent                       |

A supervisor may observe bounded descendant state without gaining descendant
control. Questions and messages are not implicitly forwarded through
intermediate coordinators.

## Usage follows ownership

Session usage accounting follows the Agent ownership graph, not the supervision
graph. `/agents stats` starts with the current Pi session and walks only
transitively owned managed-Agent sessions whose exact persisted identity can be
verified.

Manager/Chief staff, peer Leads, other worktrees, and unrelated Pi sessions are
not attributed through supervision relationships. This keeps usage accounting
aligned with the same durable ownership boundary used for Agent control.

See [Commands](../reference/commands.md#agents-stats) for the exact presentation
and coverage rules.

## System responsibilities

| System          | Responsibility                                                                       |
| --------------- | ------------------------------------------------------------------------------------ |
| **Pi**          | Session history, turns, model interaction, and conversation continuity               |
| **Pi Herdsman** | Assignment ownership, coordination, project-work semantics, and authority validation |
| **herdr**       | Processes, panes, tabs, workspaces, placement, and Git worktree topology             |
| **Git**         | Branches, commits, and repository state                                              |

Physical layout and display metadata are evidence or presentation, not
coordination authority. Control requires current validated identity and fails
closed when evidence is stale, missing, duplicated, or ambiguous.

## Role transitions

`/manager` enters Manager mode from an eligible Lead in the primary workspace.
`/manager leave` returns to Lead while preserving project work.

`/chief` enters Chief mode from an eligible ordinary Lead. A Manager cannot
activate Chief. `/chief leave` returns to Lead.

Both special roles restore the Lead tool baseline when they are left. Exact
eligibility and command behavior are documented in
[Commands](../reference/commands.md).

## See also

- [Project orchestration](../guides/project-orchestration.md)
- [Delegation](delegation.md)
- [Agents and identity](agents.md)
- [Staff tools](../reference/staff.md)
- [Supervisor tools](../reference/supervisor.md)
- [Peer tools](../reference/peer.md)
