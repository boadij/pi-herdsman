# Supervision reference

[Documentation index](../README.md) · [Concept](../concepts/supervision.md) · [Peer reference](peer.md)

Supervision normally follows Chief → Manager → Lead; without an active Manager, Chief directly supervises ordinary Leads. Lead → Agent is ownership, not supervision. Staff actions search only the caller's current direct-report roster; descendant summaries do not grant descendant actions.

## Roles and authority

| Session       | Herdsman tools                                                                    | Authority                                                                                     |
| ------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Chief         | `staff` only                                                                      | Current Managers, and ordinary Leads without an active project Manager, on this Herdr runtime |
| Manager       | `staff`, `supervisor`, `peer` plus ordinary project tools; no `agent`             | Ordinary Leads in one Herdsman project scope (one Herdr worktree group)                       |
| Lead          | `agent`, `supervisor`, `peer` plus ordinary tools; no `staff`                     | Its owned Agent tree                                                                          |
| Managed Agent | `ask_owner` and definition tools; `agent` only when delegation-enabled; no `peer` | Directly delegated permitted Agents only                                                      |

Every session starts as an ordinary Lead. Herdr worktree topology identifies the primary workspace and linked-worktree workspaces by workspace IDs and repo key. A Lead in the primary workspace may enter Manager mode with `/manager`; Leads in linked-worktree workspaces cannot. Activation claims the exclusive Manager lease for the Herdsman project scope corresponding to that Herdr worktree group, and persists `role: "manager"` for the Pi session. If another live Manager holds the lease, activation fails and the caller remains an ordinary Lead. Activation also fails while the session owns unresolved managed-Agent work, preserving its existing control surface. `/manager leave` is refused while project assignments, asks addressed to that Manager, or the Manager's own pending ask to Chief remain outstanding; when clear, it releases the lease and restores Lead instructions and the exact Lead tool baseline, including `agent`. A restored Manager uses the same profile, supervision UI, and role-specific context as explicit activation; startup does not load a Lead Agent-definition roster or recover Lead-owned Agent runtimes. Manager uses a distinct coordination charter and has only `staff`, `supervisor`, and `peer` as Herdsman tools; it has no `agent` and cannot own Agents or implement work through them. Manager receives bounded automatic state for its direct Leads, not a Lead Agent-definition roster or Agent instructions. Manager coordinates project-level work across Leads and workspaces. Delegated implementation belongs to Leads and their Agent trees; linked-worktree workspaces are the execution boundary for Manager-delegated work. Manager authority requires the current lease and exact identity, not Herdr display metadata.

An eligible ordinary Lead may activate `/chief`; a Manager cannot. Chief is a separate workspace-neutral session mode with one active lease per Herdr socket. The persisted `pi-herdsman-role` entry records `role: "lead"|"manager"|"chief"`; `leadTools` retains the exact ordinary Lead loadout needed when leaving either special role. Chief does not receive project context or Agent control. `/chief leave` restores ordinary Lead tools. An occupied lease on Chief resume suspends Chief authority. Chief and Manager activation fail while owned managed-Agent work cannot safely be excluded.

Coordinator state is private, atomic, bounded, and tied to the exact Pi session and initialization generation. It identifies `role: "lead"|"manager"` and may contain one pending supervisor ask. The runtime is socket-scoped under `runtime/supervision-v2/`; project Manager descriptors, assignments, coordinators, and transport inboxes live there. Missing, stale, duplicate, malformed, or ambiguous live/coordination evidence fails closed. Metadata such as `pi_herdsman_role=manager` is display-only. Runtime state (`idle|working|blocked|done|unknown`) is observation, not completion or authorization. Agent counts use `active`, `blocked`, and `total`; active includes working, starting, and settling descendants.

## `supervisor`: one edge upward

Chief is a mode of a lead session. While active, its model has exactly the tools `staff_list`, `staff_inspect`,
`staff_transcript`, `staff_message`, and `staff_reply`. Project/workspace context files and skills are excluded from
chief model context; workspace-specific work remains the responsibility of
supervised leads. Chief supervises independent Leads, does not own their
agents, and receives no owner controls. `/chief leave` restores the session's
ordinary tools. Activating Chief mode also fails closed while managed mailbox
state is unresolved, because the Lead cannot safely prove that it owns no
managed agent work.

## Lead projection and actions

An eligible lead requires one exact live recognized Pi agent, a matching lead
record, and no chief or validated managed agent identity. A lead's observed
runtime state is informational. Every exact-identity-verified live lead has `staff_inspect` and `staff_message`,
whether it is idle, working, blocked, done, or unknown.
A non-empty persisted session candidate adds `staff_transcript` to
`available_tools`; `available_tools` is advisory readiness, not transcript
authorization. `staff_transcript` validates the current session header,
version, and exact Pi session ID before returning evidence. A pending ask is
separate attention state: it projects as `needs_you`, exposes the bounded
question and ask ID, and adds `staff_reply`.

The automatic `<supervision_state>` is a hidden Pi custom message hard-bounded
to 16 KiB. A changed refresh appends a new snapshot; a byte-identical refresh
may omit the duplicate. The latest active snapshot supersedes earlier
snapshots. Pi's ordinary branch and compaction rules determine which persisted
snapshots participate in current model context.

The `staff_list` representation contains `session` (the exact full Pi session ID),
`display_name` (a presentation-only label), identity fields, `runtime_state`,
`needs_you`, optional pending-ask fields, `agent_counts`, and
`available_tools`. `agent_counts` contains `active`, `blocked`, and `total`;
`active` counts `working`, `settling`, and `starting` descendants. The automatic
snapshot is state-only and uses `leads`, `agent_counts`, and `agents`, not
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

## Chief transport

Messages are bounded, versioned JSON files in the target session's hashed
`inbox/` directory. Each record includes exact sender, target, `leadSessionId`,
chief lease, kind, ID, text, and `createdAt`; asks and replies also include an
ask ID. Attachments are consumed at submission and rendered into the ordinary
text field using the same canonical file renderer and configured inline/mailbox
limits as agent messages. The durable supervision record remains text-only.
Extra fields are rejected. Transport kinds are:

```text
chief_message
lead_message
lead_ask
chief_reply
```

Records are delivered in `createdAt`, then ID order and accepted through Pi
follow-up delivery. Chief messages may queue while a lead works. Same-session
restart preserves queued records, accepted IDs are deduplicated, and an
individual quarantined record does not block a new record for that lead.
Transient identity, authority, or delivery failures retain records. Exact
identity and chief lease checks are never weakened.

## Supervisor tools

The `supervisor_message` and `supervisor_ask` tools are available only to an ordinary Lead. Each operation has its own exact schema. Both require a currently valid Chief; descendants use `ask_owner`, never supervisor tools.

### `supervisor_message`

```json
{
  "message": "Progress update.",
  "files": ["result:researcher#1"]
}
```

Call `supervisor_message` for meaningful progress, reports, results, warnings, and
completion. It queues one bounded `chief_message` and does not change lead
coordination state.
`supervisor_message` accepts optional `files`, including ordinary paths, reusable direct
refs such as `result:implementation#1`, and canonical `result:<request-id>` refs
already supplied as evidence. A direct ref resolves by exact agent label and
index against the calling Pi session's current branch before ordinary file
preparation. Chief normally owns no direct agents, so a branch-local semantic
ref may not exist in the Chief session; canonical result references already
supplied as file evidence can still be forwarded through `files`. Files use the
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
canonical-ref semantics as `message`. Call `supervisor_ask` only when a chief decision is
genuinely required. One pending ask is allowed per lead. The call durably
records its ask ID and clean question, then queues the prepared text. The
prepared text, including attachment rendering, is persisted before publication
so reconciliation can deliver it after a failed initial publication. It must be
the only tool call in the turn; call it last, do not guess, and wait for the
reply.

## Staff tools

The `staff_*` tools are available only to the active Chief. Their target `session` must be the exact full Pi session ID shown as `session` in a fresh automatic supervision snapshot or returned by `staff_list`; never use `display_name`.

For general state questions and ordinary messages or replies, use the fresh automatic supervision snapshot directly; do not call `staff_list`, `staff_inspect`, or `staff_transcript` merely to poll progress. The `staff_message` and `staff_reply` tools
perform their own authoritative validation. Use `staff_list` when the snapshot is
stale or unavailable, an immediately refreshed roster is materially necessary,
or diagnosis is required. Use `staff_inspect` only when bounded live terminal/process
evidence matters. Use `staff_transcript` only when bounded persisted Pi
conversation/tool evidence materially matters.

### `staff_list`

`staff` belongs to Chief and Manager. Chief sees active Managers, with bounded read-only Lead summaries and aggregate Lead/Agent counts. Without an active Manager, Chief may directly supervise ordinary Leads; with an active Manager, Leads in that Manager's worktree group report only to it and are not Chief targets. Manager sees **all** eligible ordinary Leads in its worktree group, not just Leads it delegated. Manager can inspect descendant Agent counts, but cannot target another Lead's Agents. Only Manager can delegate a project Lead. All targets use the exact full `session` Pi ID from a fresh roster; `display_name` and nested Lead IDs under Chief are never actionable.

```json
{}
```

`staff_list` returns a fresh supervision projection and fresh `available_tools`.

### `staff_inspect`

```json
{ "action": "transcript", "session": "<exact direct-report Pi session ID>" }
```

```json
{
  "session": "<exact full Pi session ID shown in a fresh snapshot>"
}
```

`staff_inspect` is read-only and requires an active Chief and eligible exact session. It
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

`staff_transcript` is read-only and requires an active Chief and an eligible exact
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
`chief_message` record queues a follow-up and does not wait for completion.
`staff_message` accepts optional `files`, including ordinary paths, reusable
direct refs, and canonical result refs. Semantic refs use the same exact
label/index and current-branch rules as chief actions; Chief does not normally
own direct agents, so canonical result references supplied as evidence remain
the usual cross-session forwarding form through `files`.

### `staff_reply`

If `base` is omitted, the `HEAD` ref token is persisted before creation; it is not resolved to an immutable commit. Herdr determines the linked-worktree workspace path and label. Manager coordinates exactly one Herdr worktree group from its primary workspace. A delegated branch gets a linked Git worktree and linked-worktree workspace, but multiple Leads may share a workspace; one workspace does not imply one worktree. The Manager uses the exact returned workspace, tab, and pane identities and the normal bounded shell-readiness and ownership checks before starting Pi. It launches Pi with the assignment UUID as `--session-id` and verifies one exact-pane candidate with Lead coordination state under that expected session ID. Herdr must report a session identity; if it resolves, it must match the assignment ID. Pi may expose a session path before its initial JSONL file exists; this expected startup state does not block verification while the Lead state is published. Manager-created Leads inherit the Manager session's `ctx.isProjectTrusted()` decision for that run: a trusted Manager passes `--approve`, while an untrusted Manager passes `--no-approve`. Pi's trust-protected project resources are available only in the trusted case; `--no-approve` skips those protected resources without implying that all project-local files are skipped. This does not modify Pi's persistent trust store or elevate trust beyond the Manager's current decision. On success it returns assignment ID, exact Lead session ID, workspace ID, and branch. There is no caller-selected cwd, pane, Agent definition, focus, review, or merge policy. The linked-worktree workspace remains after completion.

The assignment delivered to a Lead says to report completion with
`supervisor_result`; use `supervisor_message` only for nonterminal progress or
coordination. The durable result settles the assignment after accepted Manager
delivery. A direct-report Lead's messages and results are addressed to Manager:
handle them locally rather than echoing them through `supervisor`, which a
Manager uses only for its own escalation to Chief. Manager `staff list` reports
assignment branch names (without task text).

An uncertain external creation result is reconciled only by an explicit recovery request with no new delegation inputs:

```json
{
  "session": "<exact full Pi session ID shown in a fresh snapshot>",
  "askId": "<exact pending ask ID>",
  "message": "Proceed.",
  "files": ["/tmp/decision.md", "result:implementation#1"]
}
```

The exact session, unchanged pending ask ID, current lead identity, and chief
lease must validate. The pending ask is cleared only after accepted delivery.
`staff_reply` accepts optional `files` with the same ordinary, semantic-ref, and
canonical-ref semantics. Lead activity returns asynchronously; continue only
independent chief work, otherwise end the turn and do not poll.

## `/chief` and display

From an eligible ordinary Lead, `/manager` enters Manager mode; `/manager leave` returns to Lead. From an eligible Lead, `/chief` activates Chief; when already Chief it opens the interactive overview. `/chief leave` exits after confirmation where UI is available. A Chief can focus only its exact direct reports. Attention (`needs_you`) is separate from lifecycle; descendant summaries are observational only. A Manager cannot activate Chief. The status and overview are not authority: every action revalidates the exact direct-report identity and current lease.
