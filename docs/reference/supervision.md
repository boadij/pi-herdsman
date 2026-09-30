# Supervision reference

[Documentation index](../README.md) · [Concept](../concepts/supervision.md) · [Peer reference](peer.md)

Supervision normally follows Chief → Manager → Lead; without an active Manager, Chief directly supervises ordinary Leads. Lead → Agent is ownership, not supervision. Staff actions search only the caller's current direct-report roster; descendant summaries do not grant descendant actions.

## Roles and authority

| Session       | Herdsman tools                                                                    | Authority                                                                                     |
| ------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Chief         | `staff` only                                                                      | Current Managers, and ordinary Leads without an active project Manager, on this Herdr runtime |
| Manager       | `staff`, `supervisor`, `peer` plus ordinary project tools; no `agent`             | Project work and ordinary Leads in one Herdr worktree group                                   |
| Lead          | `agent`, `supervisor`, `peer` plus ordinary tools; no `staff`                     | Its owned Agent tree                                                                          |
| Managed Agent | `ask_owner` and definition tools; `agent` only when delegation-enabled; no `peer` | Directly delegated permitted Agents only                                                      |

Every session starts as an ordinary Lead. Herdr worktree topology identifies the primary workspace and linked-worktree workspaces by workspace IDs and repo key. A Lead in the primary workspace may enter Manager mode with `/manager`; Leads in linked-worktree workspaces cannot. Activation claims the exclusive Manager lease for that worktree group. If another live Manager holds the lease, activation fails and the caller remains an ordinary Lead. Activation also fails while the session owns unresolved managed-Agent work. `/manager leave` preserves project work and restores Lead instructions and the exact Lead tool baseline, including `agent`. A Lead waiting for this Manager's answer, or the Manager's own pending ask to Chief, can still block leaving. Re-entering Manager mode shows the same project work. Manager has no `agent` tools and cannot own Agents or implement work through them. It receives bounded automatic project-work and direct-Lead state. Delegated implementation belongs to Leads and their Agent trees; Manager authority requires the current lease and exact identity, not Herdr display metadata.

Manager is available in an ordinary Git repository's primary Herdr workspace;
existing linked-worktree membership is not required. The Git branch is the
semantic project-work handle. Project assignment and result UUIDs remain
internal, separate from the exact Pi session IDs used for direct Lead actions.

An eligible ordinary Lead may activate `/chief`; a Manager cannot. Chief is a separate workspace-neutral session mode with one active lease per Herdr socket. The persisted `pi-herdsman-role` entry records `role: "lead"|"manager"|"chief"`; `leadTools` retains the exact ordinary Lead loadout needed when leaving either special role. Chief does not receive project context or Agent control. `/chief leave` restores ordinary Lead tools. An occupied lease on Chief resume suspends Chief authority. Chief and Manager activation fail while owned managed-Agent work cannot safely be excluded.

Coordinator state is private, atomic, bounded, and tied to the exact Pi session and initialization generation. It identifies `role: "lead"|"manager"` and may contain one pending supervisor ask. The runtime is socket-scoped under `runtime/supervision-v2/`; project Manager descriptors, assignments, coordinators, and transport inboxes live there. Missing, stale, duplicate, malformed, or ambiguous live/coordination evidence fails closed. Metadata such as `pi_herdsman_role=manager` is display-only. Runtime state (`idle|working|blocked|done|unknown`) is observation, not completion or authorization. Agent counts use `active`, `blocked`, and `total`; active includes working, starting, and settling descendants.

## Chief and Manager coordination

Chief is a mode of a Lead session. While active, its model has exactly the tools `staff_list`, `staff_inspect`,
`staff_transcript`, `staff_message`, and `staff_reply`. It supervises active Managers and ordinary Leads without an active project Manager; it cannot act on a Manager's Leads. Manager has those five staff tools plus `staff_delegate`, `staff_close`, and `staff_discard` for project work, `supervisor` for escalation to Chief, and `peer` for Manager peers. Staff actions in both modes target only direct reports; Manager's branch-based delegate and discard actions target project work. Neither mode owns the reports' Agents or receives owner controls. Project/workspace context files and skills are excluded from Chief model context; workspace-specific work remains the responsibility of supervised Leads. `/chief leave` restores the session's ordinary tools. Activating Chief mode fails closed while managed mailbox state is unresolved, because the Lead cannot safely prove that it owns no managed Agent work.

## Lead projection and actions

An eligible lead requires one exact live recognized Pi agent, a matching lead
record, and no chief or validated managed agent identity. A lead's observed
runtime state is informational. Every exact-identity-verified live lead has `staff_inspect` and `staff_message`,
whether it is idle, working, blocked, done, or unknown.
A non-empty persisted session candidate adds `staff_transcript` to
`available_tools`; `available_tools` is advisory readiness, not transcript
authorization. `staff_transcript` validates the current session header,
version, and exact Pi session ID before returning evidence. A pending ask
exposes the bounded question and ask ID. Bound asks project `needs_you` and
add `staff_reply` only under their recorded supervisor session and lease.
An ask without recorded supervisor identity also permits a current Chief to
reply; it cannot be identified as orphaned after Chief replacement.

The automatic `<supervision_state>` is a hidden Pi custom message hard-bounded
to 16 KiB. A changed refresh appends a new snapshot; a byte-identical refresh
may omit the duplicate. The latest active snapshot supersedes earlier
snapshots. Pi's ordinary branch and compaction rules determine which persisted
snapshots participate in current model context.

The Lead representation contains `session` (the exact full Pi session ID),
`display_name` (a presentation-only label), identity fields, `runtime_state`,
`needs_you`, optional pending-ask fields, `agent_counts`, and
`available_tools`, and optional branch provenance. `agent_counts` contains `active`, `blocked`, and `total`;
`active` counts `working`, `settling`, and `starting` descendants. The automatic
snapshot is state-only and uses `leads`, Manager `project_work`, `agent_counts`, and `agents`, not
inspect terminal/process evidence.
Oversized output is truncated only at complete lead records and identifies
omitted state. Use `staff_list` when a fresh complete roster is required.

The `session` value is the exact full Pi session ID shown in a fresh supervision
snapshot or returned by `staff_list`; the `display_name` label is never accepted
as a target.

## Metadata

Pi Herdsman may publish best-effort Herdr metadata for display:

```text
source: pi-herdsman:lead
pi_herdsman_role=lead
pi_herdsman_ask=<ask-id>
pi_herdsman_name=<session name>
```

Chief mode publishes the role token `chief`. Metadata never grants lead
eligibility, chief authority, or message authority. Failed metadata
publication does not change communication authority.

## Supervision transport

Messages are bounded, versioned JSON files in the target session's hashed
`inbox/` directory. Each record includes exact sender, target, `leadSessionId`,
`leaseId` (the relevant supervision lease for supervision records), kind, ID, text, and `createdAt`; asks and replies also include an
ask ID. Attachments are consumed at submission and rendered into the ordinary
text field using the same canonical file renderer and configured inline/mailbox
limits as agent messages. The durable supervision record remains text-only.
Extra fields are rejected. Transport kinds are:

```text
chief_message (Chief → direct Lead or Manager)
lead_message (Lead → direct Chief or Manager)
lead_ask (Lead → direct Chief or Manager)
chief_reply (Chief → direct Lead or Manager)
manager_message (Manager → direct Lead, or Manager → Chief)
manager_ask (Manager → Chief)
manager_reply (Manager → direct Lead)
project_assignment (project work → assigned Lead)
report_result (assigned Lead → Manager)
```

The shared record type also permits `peer_message` for peer traffic. Records are delivered in `createdAt`, then ID order and accepted through Pi
follow-up delivery. Supervisor messages may queue while a report works. Same-session
restart preserves queued records, accepted IDs are deduplicated, and an
individual quarantined record does not block a new record for that session.
Transient identity, authority, or delivery failures retain records. Exact
identity checks remain mandatory. A project assignment instruction remains
authorized by its project work after the originating Manager leaves; ordinary
Manager messages and replies still require their current supervisor lease.

## Supervisor tools

The `supervisor_message` and `supervisor_ask` tools are available to ordinary Leads and Managers. Each operation has its own exact schema. An ordinary Lead routes to its active project Manager when one exists, otherwise to Chief; a Manager escalates to Chief. Both require a currently valid direct supervisor; managed Agents use `ask_owner`, never supervisor tools.

### `supervisor_message`

```json
{
  "message": "Progress update.",
  "files": ["result:researcher#1"]
}
```

Call `supervisor_message` for meaningful progress, reports, warnings, and
completion outside a delegated assignment. It queues one bounded `lead_message` from a Lead or `manager_message` from a Manager and does not change
coordination state. An assigned Lead reports terminal completion through `supervisor_result`, not this tool.
`supervisor_message` accepts optional `files`, including ordinary paths, reusable direct
refs such as `result:implementation#1`, and canonical `result:<request-id>` refs
already supplied as evidence. A direct ref resolves by exact agent label and
index against the calling Pi session's current branch before ordinary file
preparation. Canonical result references already supplied as file evidence can
be forwarded through `files`. Files use the
same submission-time canonicalization, UTF-8 embedding, reference fallback, and
configured byte limits as agent messages.

### `supervisor_ask`

```json
{
  "question": "Which constraint should take priority?",
  "files": ["/tmp/evidence.md"]
}
```

`supervisor_ask` accepts optional `files` with the same ordinary, semantic-ref, and
canonical-ref semantics as `supervisor_message`. Call `supervisor_ask` only when a direct-supervisor decision is
genuinely required. A Lead queues `lead_ask` to Manager or Chief; a Manager queues `manager_ask` to Chief. One pending ask is allowed per session and current supervisor lease; if that authority is replaced, the caller may ask again under the new lease. The call durably
records its ask ID and clean question, then queues the prepared text. The
prepared text, including attachment rendering, is persisted before publication
so reconciliation can deliver it after a failed initial publication. It must be
the only tool call in the turn; call it last, do not guess, and wait for the
reply.

## Staff tools

The shared `staff_*` tools are available to an active Chief or Manager; `staff_delegate`, `staff_close`, and `staff_discard` are Manager-only. Lead-targeted actions take the exact full Pi `session` ID of a direct report from a fresh snapshot or `staff_list`; branch-targeted work actions use the Git branch, not a Lead display name or assignment ID.

For general state questions and ordinary messages or replies, use the fresh automatic supervision snapshot directly; do not call `staff_list`, `staff_inspect`, or `staff_transcript` merely to poll progress. The `staff_message` and `staff_reply` tools
perform their own authoritative validation. Use `staff_list` when the snapshot is
stale or unavailable, an immediately refreshed roster is materially necessary,
or diagnosis is required. Use `staff_inspect` only when bounded live terminal/process
evidence matters. Use `staff_transcript` only when bounded persisted Pi
conversation/tool evidence materially matters.

### `staff_list`

`staff_list` belongs to Chief and Manager. Chief sees active Managers, with bounded read-only Lead summaries and aggregate Lead/Agent counts. Without an active Manager, Chief may directly supervise ordinary Leads; with an active Manager, Leads in that Manager's worktree group report only to it and are not Chief targets. Manager sees **all** eligible ordinary Leads in its worktree group, not just Leads it delegated. Manager can inspect descendant Agent counts, but cannot target another Lead's Agents. Only Manager can delegate a project Lead. All targets use the exact full `session` Pi ID from a fresh roster; `display_name` and nested Lead IDs under Chief are never actionable.

```json
{}
```

`staff_list` returns a fresh supervision projection and fresh `available_tools`.
For Manager, `work` lists branch, derived `status` (`active`, `paused`,
`finished`, or `conflict`), and a bounded task summary.
Only active work includes a separate `runtime_state` from its live Lead;
paused work remains listed without a running Lead. An unavailable worktree
is paused with an explanatory `issue`, not a conflict. Work does not expose
assignment session IDs, result references, workspace or pane IDs; use
`staff_inspect` for current runtime evidence.
`reports` includes eligible direct Leads, whether assigned to work or not.
A branch is the work handle; a session in `reports` is for Lead actions.

### `staff_inspect`

```json
{
  "session": "<exact full Pi session ID shown in a fresh snapshot>"
}
```

`staff_inspect` is read-only and requires an active Chief or Manager and an eligible exact direct-report session. It
returns live identity-checked terminal/process evidence: Herdr's up to 80
recent-unwrapped terminal lines with a Herdsman-local 16 KiB byte cap, plus
separately bounded process evidence. The public
`recent_output_truncated` boolean is true only when that local byte cap
truncates the terminal output and false otherwise. It does not expose persisted
Pi session-message history.

### `staff_transcript`

```json
{
  "session": "<exact full Pi session ID shown in a fresh snapshot>"
}
```

`staff_transcript` is read-only and requires an active Chief or Manager and an eligible exact direct-report
session. A non-empty persisted session candidate adds `staff_transcript` to
`available_tools`. `available_tools` is advisory readiness, not transcript
authorization; the transcript action validates the current session header,
version, and exact Pi session ID before returning evidence. It returns the same
bounded persisted Pi
conversation/tool projection used by `agent_transcript`: visible user,
assistant, tool-call, tool-result, compaction, and branch-summary evidence;
reasoning, system messages, extension entries, and control markers are
excluded. The transcript is bounded to 16 KiB, with individual tool results
bounded to 4 KiB. The internal session-file path is never returned by staff
list, automatic supervision context, or the transcript result. Reading it does
not send a message or change Lead state.

### `staff_message`

```json
{
  "session": "<exact full Pi session ID shown in a fresh snapshot>",
  "message": "Run checks.",
  "files": ["/tmp/checklist.md", "result:implementation#1"]
}
```

The exact session must currently expose `staff_message`. Atomic creation of one
bounded
`chief_message` or `manager_message` record queues a follow-up and does not wait for completion.
`staff_message` accepts optional `files`, including ordinary paths, reusable
direct refs, and canonical result refs. Semantic refs use the same exact
label/index and current-branch rules as chief actions; Chief does not normally
own direct agents, so canonical result references supplied as evidence remain
the usual cross-session forwarding form through `files`.

### `staff_delegate`

Only an active Manager can start or resume project work. Supply `task` to start
new work, with optional `branch`, `base`, and `files`; without a branch,
Herdsman generates one. Supply only `branch` to resume existing work:

```json
{ "task": "Implement the change", "branch": "feat/example" }
```

```json
{ "branch": "feat/example" }
```

If a branch already has work, a new task, base, or files cannot replace it.
If it has no work, a task is required. The first delegation can create the first
linked worktree; no existing linked worktree is required. An existing unoccupied Herdr worktree
is reused, whether open or closed; `base` applies only when creating a new
worktree. A different live Lead occupying that worktree prevents a second
managed writer. Workspace membership does not make a Lead the assignment
owner. Herdr supplies exact workspace, tab, and pane placement. Manager-created
Leads inherit the Manager's effective project-trust decision for that run:
trusted passes `--approve`, untrusted passes `--no-approve`. This does not
change Pi's persistent trust store. Pi resumes the same project session when
work is paused; a repeated request for already-running work returns that Lead
without launching another. An existing assignment with no matching worktree
remains paused: restore/open its checkout and retry, or discard the assignment
and delegate again. Herdsman does not recreate it from a historical base.
A closed workspace is reopened without a second checkout; contradictory or
ambiguous evidence fails closed.

The Lead reports terminal completion with `supervisor_result`; use
`supervisor_message` only for nonterminal progress or coordination. A durable
result prevents a restart. `supervisor_result` queues a durable notification for
the active Manager. If no Manager is active, completion remains saved for the
next Manager to reconcile. The assignment is removed only after accepted
result delivery. The canonical result remains available for later
handoffs. A direct-report Lead's messages and results are handled by Manager,
not echoed through its own `supervisor` escalation to Chief.

### `staff_close`

```json
{ "session": "<exact live direct Lead session ID>" }
```

Stop the exact Lead and its owned Agent execution tree. For managed work this
pauses execution but preserves the assignment, Pi session, Git branch, and
worktree; resume with `staff_delegate` using its branch. An unassigned direct
Lead can also be closed without creating an assignment. Failed or ambiguous
cleanup does not silently discard work.

### `staff_discard`

```json
{ "branch": "feat/example" }
```

Abandon managed work by branch: stop its execution tree and remove the
assignment only after proving execution has stopped. The Git branch, worktree,
and files remain. Durable completed results cannot be discarded; settle them
instead. Current worktree panes are checked for a possible Pi executor; if
execution cannot be proved absent or a result appears during discard, the
assignment remains.

### `staff_reply`

```json
{
  "session": "<exact full Pi session ID shown in a fresh snapshot>",
  "askId": "<exact pending ask ID>",
  "message": "Proceed.",
  "files": ["/tmp/decision.md", "result:implementation#1"]
}
```

The exact direct-report session, unchanged pending ask ID, current report identity, and supervisor
lease must validate. The pending ask is cleared only after accepted delivery.
`staff_reply` accepts optional `files` with the same ordinary, semantic-ref, and
canonical-ref semantics. Report activity returns asynchronously; continue only
independent coordination work, otherwise end the turn and do not poll.

## `/manager`, `/chief`, and display

From an eligible ordinary Lead, `/manager` enters Manager mode; when already Manager it opens the interactive overview. `/manager leave` returns to Lead. From an eligible Lead, `/chief` activates Chief; when already Chief it opens the interactive overview. `/chief leave` exits after confirmation where UI is available. Supervisors can focus only their exact direct reports. Attention (`needs_you`) is separate from lifecycle; descendant summaries are observational only. A Manager cannot activate Chief. The status and overview are not authority: every action revalidates the exact direct-report identity and current lease.
