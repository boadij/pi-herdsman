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

Manager coordinates exactly one Herdr worktree group from its primary
workspace. A delegated branch gets a linked Git worktree and linked-worktree
workspace, but multiple Leads may run in one workspace; one workspace does not
imply one worktree.

## Project authority

Herdr's worktree topology identifies the primary workspace and its linked-worktree workspaces; branch names, Git subprocesses, cwd, labels, and display metadata do not confer authority. Every session starts as an ordinary Lead. A Lead in the primary workspace may explicitly enter Manager mode with `/manager`; Leads in linked-worktree workspaces cannot. Activation claims the single Manager lease for the corresponding Herdsman project scope and persists Manager mode for the Pi session. If another live Manager holds the lease, activation fails and the caller remains an ordinary Lead. Activation also refuses while the session owns unresolved managed-Agent work, preserving its control surface. `/manager leave` is refused while project assignments, Manager-addressed asks, or the Manager's own pending ask to Chief remain outstanding; when clear it releases the lease and restores the Lead profile and exact Lead tool baseline, including `agent`. A restored Manager session uses the same Manager profile, supervision UI, and role-specific context as explicit activation; startup does not load the Lead Agent-definition roster or recover Lead-owned Agent runtimes. Manager uses a distinct coordination charter and has only `staff`, `supervisor`, and `peer` as Herdsman tools; it has no `agent` and cannot own Agents or implement work through them. Manager receives bounded direct-Lead supervision context, not the Lead Agent-definition roster or Agent instructions. Manager coordinates project-level work across Leads and workspaces. Delegated implementation belongs to Leads and their Agent trees, with linked-worktree workspaces as Manager's execution boundary.

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

Only explicit `staff_delegate` starts or recovers delegation; roster and report reads never resume external mutations. Independent branches may be delegated concurrently. A branch has at most one nonterminal assignment (`creating`, `starting`, `active`, or `settling`). Recover `creating`, `starting`, or a proven-not-live `active` assignment with `staff_delegate assignment=<id>`. A live exact Lead blocks recovery; a durable result moves an `active` assignment to `settling` without restarting its Lead. `settling` is result reconciliation only. Fresh delegation rejects an existing Herdr worktree and never adopts its Lead. Recovery uses only the exact assignment ID and reconciles that persisted assignment. Herdsman allocates an assignment and persists its branch and selected base ref token before creating the workspace: a requested branch is retained, otherwise the branch is `herdsman/<assignment-id>`; omitted base defaults to the `HEAD` token. It reuses the exact tokens on every recovery. Token stability does not freeze a moving ref; Herdr 0.9.1 exposes no public ref-to-immutable-commit resolver or resolved commit output. During explicit recovery, if authoritative Herdr topology proves a `starting` or `active` assignment's worktree is absent, Herdsman removes the assignment and releases its branch reservation; fresh delegation is required. Uncertain or contradictory topology fails closed; reads never remove assignments. Ambiguous creation is reconciled against the persisted branch/base and Herdr topology; if a branch exists without an open workspace, use `herdr worktree open --workspace <primary-workspace-id> --branch <branch> --no-focus`. Herdsman does not create a second branch/workspace for the assignment. Herdr controls the workspace path and label. The exact pane is started only after bounded shell-readiness and ownership checks; the assignment is durably delivered after verifying the exact Lead. Manager `staff_list` includes current Leads in its worktree group (including manually created Leads) and unresolved assignment phases.

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

Recover the exact assignment only with `staff_delegate` using `{"action":"delegate","assignment":"<id>"}`; omit `task`, `branch`, `base`, and `files` so recovery uses the persisted assignment. Use the current Lead while it is live; do not restart an assignment already settling.

Idle runtime state and `supervisor_message` are not task completion. An assigned Lead calls `supervisor_result` to persist its outcome and provenance under reusable `result:<assignment-id>`, then notify the current Manager. Use `supervisor_message` only for nonterminal progress or coordination. A durable result repairs an `active` assignment to `settling`; delivery is retried while the Manager is active and across Manager replacement. The assignment is removed after accepted Manager delivery; the result artifact remains for later `files` handoffs. Pending asks reconcile across Manager replacement. Linked-worktree workspaces remain after completion. Herdsman does not prescribe backlog, review, or merge policy.

The automatic bounded `<supervision_state>` is state-only, untrusted observation. A fresh snapshot suffices for general state questions; use `staff_list` when a refreshed roster is needed, `inspect` for live terminal/process evidence, and `transcript` for persisted conversation/tool evidence. Every action revalidates direct-report identity and current authority.
