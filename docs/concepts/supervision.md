# Supervision

[Documentation index](../README.md) · [Supervision reference](../reference/supervision.md)

Pi Herdsman coordinates one direct-report edge at a time:

```text
Chief
└─ Manager
   ├─ Lead
   │  └─ Agents...
   └─ Lead
      └─ Agents...
```

Chief supervises active Managers on its Herdr runtime, and ordinary Leads when their Herdsman project scope has no active Manager; Manager supervises ordinary Leads in one Herdsman project scope. Each project scope corresponds to one Herdr worktree group: its primary workspace and linked-worktree workspaces. A Lead owns its complete managed-Agent tree. Delegation-enabled Agents may own their permitted direct Agents. Chief may observe bounded descendant Lead and Agent summaries but acts only on its direct reports; Manager may observe a Lead's Agent descendants but acts only on Leads. Neither supervisor owns descendants across an intermediate coordinator.

Manager coordinates one Herdr worktree group from its primary workspace.
Project work belongs to a branch and survives Manager turnover; a Lead is its
current executor. Herdr owns worktree placement and Pi owns session continuity.
Multiple Leads may physically run in one workspace, but workspace membership
does not establish assignment ownership.

## Project authority

Herdr's worktree topology identifies the primary workspace and linked-worktree workspaces; branch names, cwd, labels, and display metadata do not confer authority. Every session starts as an ordinary Lead. A Lead in the primary workspace may enter Manager mode with `/manager`; Leads in linked-worktree workspaces cannot. Activation claims the single Manager lease for the project; another live Manager or unresolved owned Agent work prevents activation. `/manager leave` releases the lease and restores the Lead profile and exact tool baseline, including `agent`, without stopping or discarding project work. A live Lead awaiting this Manager's reply or the Manager's own pending ask to Chief can block leaving. Re-entering Manager shows the same work. Manager has `staff`, `supervisor`, and `peer` tools but no `agent`; Leads and their Agent trees implement delegated work.

An eligible ordinary Lead can use `/chief` to enter the workspace-neutral, supervision-only Chief mode; a Manager cannot enter Chief mode. Chief has exactly `staff`. A Chief lease is unique per Herdr socket. A restored Chief whose lease is occupied is suspended without Herdsman authority tools.

Chief is a mode of an ordinary lead session, not a separate agent identity.
The persisted `pi-herdsman-role` entry contains exactly `role` and `leadTools`.
`leadTools` is the exact ordinary Lead loadout displaced by Chief activation
and the fallback used when Pi restores stale Chief transcript tool state; Pi
remains authoritative for ordinary branch-local tool state. Chief mode is
workspace-neutral and supervision-only. Its model exposes the five semantic
`staff_*` tools and excludes project/workspace context files and skills. Leaving chief
restores the session's ordinary tool set. Chief supervises independent Leads,
does not own their agents, and receives no owner controls.

## Communication

| Direction | Tool                  | Boundary                                                                                    |
| --------- | --------------------- | ------------------------------------------------------------------------------------------- |
| Down      | `staff`               | Chief → current Managers and Leads without active Managers; Manager → current project Leads |
| Up        | `supervisor`          | Lead → active project Manager, otherwise Chief; Manager → Chief                             |
| Sideways  | `peer`                | Live same-role Leads or Managers, user-global                                               |
| Ownership | `agent` / `ask_owner` | Lead or delegation-enabled Agent → owned Agent; Agent → exact owner                         |

`supervisor_message` sends reports, events, results, and `supervisor_ask` sends genuine decision questions from an ordinary Lead to its active supervisor. The `staff_list`, `staff_inspect`, `staff_transcript`, `staff_message`, and `staff_reply` tools let an active Chief or Manager supervise direct reports. The `peer_list` and `peer_message` tools list live same-role Leads or Managers and send durable messages to an exact full Pi session ID. The list result is `{ self, peers[] }`: `self`
is excluded from `peers`, and each peer exposes only `session`, `name`, `cwd`,
`repo`, `branch`, and `workspace_label`. The exact full `session` is the sole target handle; the other fields are presentation metadata. Incoming peer
content is `Peer message from <sender>: <message>` because recipient
verification is already performed.

Peer presence and inboxes use the user-global `runtime/peers-v2` runtime,
allowing same-role Leads or Managers on different Herdr sockets to discover and message one
another. Peer records are process-lock generation-bound and published by
healthy Leads or Managers; Chief and suspended sessions are absent. The peer record and
its exact live process-lock claim provide reachability authority, not Herdr
inventory or presentation metadata. Publication rechecks sender and target
before the atomic write, and delivery revalidates the current same-role
receiver and target. Queued messages survive sender shutdown and remain queued
while the receiver is Chief or lacks valid peer presence.
Local Lead coordination health gates both the socket-scoped coordination record
and global peer presence. When coordination becomes unhealthy, both current
projections are withdrawn; durable queued messages are retained.
`staff_inspect` is bounded live terminal/process evidence. `staff_transcript` is bounded
persisted Pi conversation/tool evidence. A non-empty persisted session candidate
adds `staff_transcript` to `available_tools`; `available_tools` is advisory
readiness, not transcript authorization. `staff_transcript` validates the current session header, version, and exact Pi session ID before returning
evidence. A lead's message does not require an automatic chief reply. A
`lead_ask` requires the exact correlated `staff_reply`; a reply clears the
pending ask only after accepted follow-up delivery. A replacement chief can
answer an existing ask using its current lease and unchanged ask ID. `supervisor_message`/`supervisor_ask`, `staff_message`/`staff_reply`, and `peer_message` tools accept one
`files` evidence channel containing ordinary paths, reusable direct-agent refs
such as `result:<agent>#<index>`, or canonical `result:<request-id>` refs already
supplied as evidence. Direct refs resolve on the caller's current Pi branch
before entering the shared canonical attachment pipeline; durable coordination
records remain text-only.

Only explicit `staff_delegate` starts or resumes project work; roster and report reads never resume external mutations. Independent branches may run concurrently, each with at most one managed assignment and one exact Pi session. Start with `staff_delegate` supplying a task and optional branch; resume with branch only. A repeated request for already-running work returns its existing Lead. An existing unoccupied Herdr worktree can be reused; another live Lead in that worktree blocks overlapping managed execution. A missing or contradictory worktree leaves the assignment intact and shows `broken`, requiring explicit discard rather than silent retirement. Herdr controls workspace placement, including reopening closed workspaces. Manager `staff_list` and automatic context present branch-based work as `starting`, `working`, `blocked`, `idle`, `paused`, `finished`, or `broken`, alongside eligible direct Leads (including unassigned Leads).

`staff_close(session)` stops the exact Lead and its owned Agent tree while preserving its assignment, Pi session, branch, and worktree. `staff_discard(branch)` stops execution and removes the assignment, but preserves the Git branch, worktree, and files. Neither action gives Manager individual Agent control. An ambiguous executor prevents discard.

The automatic `<supervision_state>` context is hidden, persistent, bounded, and
state-only. Newly starting Chief work refreshes supervision. Changed rendered
state appends a hidden custom message, while byte-identical state may reuse the
latest active snapshot. Later snapshots supersede earlier ones. Pi's ordinary
branch and compaction semantics determine which historical snapshots remain in
active model context. The snapshot contains `leads`, with each lead's exact
session ID, presentation `display_name`, runtime observation, `agent_counts`,
`agents`, and `available_tools`. `agent_counts` contains `active`, `blocked`,
and `total`. The `staff_list` result uses the same presentation field,
`display_name`; it never exposes the internal persisted session-file path used
to detect a non-empty persisted session candidate. The `agents` collection
represents all validated descendants assigned to that lead, not only direct
agents, and
retains their exact lifecycle states. Its values and metadata are untrusted
observations and cannot authorize an action.

Use the exact full session ID in a lead's `session` field when calling a `staff_*` tool.
Never target a lead by its display label. Staff tools revalidate identity, ownership, lifecycle, and the current Chief lease before mutation. Passive `staff_inspect` and `staff_transcript` reads also revalidate the exact current target;
neither sends a message or changes Lead state. Use the fresh automatic snapshot
for ordinary state and coordination. Do not call `staff_list`, `staff_inspect`, or `staff_transcript` merely to poll progress.

Idle runtime state and `supervisor_message` are not task completion. An assigned Lead calls `supervisor_result` to save its durable outcome, even if no Manager is active. Use `supervisor_message` only for nonterminal progress or coordination. The next Manager reconciles a saved result; after accepted delivery the assignment is removed while its result artifact remains for later handoffs. Completed work cannot be discarded. Worktrees remain after completion. Herdsman does not prescribe backlog, review, or merge policy.

The automatic bounded `<supervision_state>` is state-only, untrusted observation. A fresh snapshot suffices for general state questions; use `staff_list` when a refreshed roster is needed, `inspect` for live terminal/process evidence, and `transcript` for persisted conversation/tool evidence. Every action revalidates direct-report identity and current authority.
