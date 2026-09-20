# Supervision reference

[Documentation index](../README.md) · [Concept](../concepts/supervision.md)

This is the current chief and staff contract for Pi Herdsman. Exact live
identity and fresh authority checks are authoritative; presentation state and
metadata are not.

## Role, lease, and lead state

`/chief` is available to an eligible lead. The session role is persisted as
`customType: "pi-herdsman-role"` with exactly `role: "lead"|"chief"` and a
`leadTools` array. `leadTools` is the exact ordinary Lead loadout displaced by
Chief activation and the fallback for stale Chief transcript tool state; Pi
remains authoritative for ordinary branch-local tool state. A malformed role
fails closed and records a durable error. There is at most one active chief
for an exact `HERDR_SOCKET_PATH`; its descriptor is bound to the exact
process-lock claim and Pi session identity.

Every lead has one private atomic record in the supervision runtime's `leads/`
directory, keyed by the SHA-256 hash of its exact Pi session ID:

```json
{
  "version": 1,
  "instanceId": "<lead generation>",
  "piSessionId": "<exact Pi session ID>",
  "pendingAsk": {
    "askId": "<id>",
    "question": "<text>",
    "text": "<prepared text>"
  },
  "updatedAt": 0
}
```

`pendingAsk` is optional. The latest matching `pi-herdsman-lead-state` session
entry is authoritative during lead startup. A fresh `instanceId` is created
for every initialization. The lead record is checked against exact live
Herdr/Pi identity; missing, malformed, stale, duplicate, or ambiguous evidence
fails closed. The coordination record is bounded to 16 KiB; individual
transport message records remain bounded by the fixed 8 KiB supervision record
ceiling. Questions are limited to 1,024
characters and 1,024 UTF-8 bytes.

The record does not represent scheduling, capacity, permission, or message
readiness. Herdr lifecycle observation for a lead is normalized to
`idle|working|blocked|done|unknown`. Validated descendant lifecycle states are
preserved, including `settling`, `starting`, and `lost`.

Chief is a mode of a lead session. While active, its model has exactly the
`staff` tool. Project/workspace context files and skills are excluded from
chief model context; workspace-specific work remains the responsibility of
supervised leads. Chief supervises independent Leads, does not own their
agents, and receives no owner controls. `/chief leave` restores the session's
ordinary tools.

## Lead projection and actions

An eligible lead requires one exact live recognized Pi agent, a matching lead
record, and no chief or validated managed agent identity. A lead's observed
runtime state is informational. Every exact-identity-verified live lead has
`inspect` and `message`, whether it is idle, working, blocked, done, or unknown.
A non-empty persisted session candidate adds `transcript` to
`available_actions`; `available_actions` is advisory readiness, not transcript
authorization. The transcript action validates the current session header,
version, and exact Pi session ID before returning evidence. A pending ask is
separate attention state: it projects as `needs_you`, exposes the bounded
question and ask ID, and adds `reply`.

The `staff list` representation contains `lead` (the exact full Pi session ID),
`display_name` (a presentation-only label), identity fields, `runtime_state`,
`needs_you`, optional pending-ask fields, `agent_counts`, and
`available_actions`. `agent_counts` contains `active`, `blocked`, and `total`;
`active` counts `working`, `settling`, and `starting` descendants. The automatic
`<supervision_state>` context is state-only and hard-bounded to 16 KiB; it uses
`leads`, `agent_counts`, and `agents`, not inspect terminal/process evidence.
Oversized output is truncated only at complete lead records and identifies
omitted state. Use `staff list` when a fresh complete roster is required.

The `lead` value is the exact full Pi session ID shown in a fresh supervision
snapshot or returned by `staff list`; the `display_name` label is never accepted
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

## `chief`

This tool is available only to an ordinary lead. Its strict schemas reject
extra fields. Both actions require a currently valid chief; descendants use
`ask_owner`, never `chief`.

### `message`

```json
{
  "action": "message",
  "message": "Build completed.",
  "files": ["/tmp/result.txt"]
}
```

Use `message` for meaningful progress, reports, results, warnings, and
completion. It queues one bounded `chief_message` and does not change lead
coordination state.
`message` accepts an optional `files` array. Files use the same submission-time
canonicalization, UTF-8 embedding, reference fallback, and configured byte
limits as agent messages.

### `ask`

```json
{
  "action": "ask",
  "question": "Should the release include the endpoint?",
  "files": ["/tmp/evidence.md"]
}
```

Use `ask` only when a chief decision is genuinely required. One pending ask is
allowed per lead. The call durably records its ask ID and clean question, then
queues the prepared text. The prepared text, including attachment rendering, is
persisted before publication so reconciliation can deliver it after a failed
initial publication. It is a terminating coordination call: make it the final
tool call of the turn and wait rather than guessing.

## `staff`

This tool is available only to the active chief. Its target `lead` must be the
exact full Pi session ID shown as `lead` in a fresh automatic supervision
snapshot or returned by `staff list`; never use `display_name`.

For general state questions and ordinary messages or replies, use the fresh
automatic supervision snapshot directly; do not call `staff list`, `inspect`,
or `transcript` merely to poll progress. The `message` and `reply` actions
perform their own authoritative validation. Use `list` when the snapshot is
stale or unavailable, an immediately refreshed roster is materially necessary,
or diagnosis is required. Use `inspect` only when bounded live terminal/process
evidence matters. Use `transcript` only when bounded persisted Pi
conversation/tool evidence materially matters.

### `list`

```json
{ "action": "list" }
```

Returns a fresh supervision projection and fresh `available_actions`.

### `inspect`

```json
{
  "action": "inspect",
  "lead": "<exact full Pi session ID shown as lead in a fresh snapshot>"
}
```

Inspect is read-only and requires an active chief and eligible exact lead. It
returns live identity-checked terminal/process evidence: Herdr's up to 80
recent-unwrapped terminal lines with a Herdsman-local 16 KiB byte cap, plus
separately bounded process evidence. The public
`recent_output_truncated` boolean is true only when that local byte cap
truncates the terminal output and false otherwise. It does not expose persisted
Pi session-message history.

### `transcript`

```json
{
  "action": "transcript",
  "lead": "<exact full Pi session ID shown as lead in a fresh snapshot>"
}
```

Transcript is read-only and requires an active chief and an eligible exact
lead. A non-empty persisted session candidate adds `transcript` to
`available_actions`. `available_actions` is advisory readiness, not transcript
authorization; the transcript action validates the current session header,
version, and exact Pi session ID before returning evidence. It returns the same
bounded persisted Pi
conversation/tool projection used by the agent transcript action: visible user,
assistant, tool-call, tool-result, compaction, and branch-summary evidence;
reasoning, system messages, extension entries, and control markers are
excluded. The transcript is bounded to 16 KiB, with individual tool results
bounded to 4 KiB. The internal session-file path is never returned by staff
list, automatic supervision context, or the transcript result. Reading it does
not send a message or change Lead state.

### `message`

```json
{
  "action": "message",
  "lead": "<exact full Pi session ID shown as lead in a fresh snapshot>",
  "message": "Run checks.",
  "files": ["/tmp/checklist.md"]
}
```

The exact lead must currently expose `message`. Atomic creation of one bounded
`chief_message` record queues a follow-up and does not wait for completion.
`staff message` accepts optional `files`.

### `reply`

```json
{
  "action": "reply",
  "lead": "<exact full Pi session ID shown as lead in a fresh snapshot>",
  "askId": "<exact pending ask ID>",
  "message": "Proceed.",
  "files": ["/tmp/decision.md"]
}
```

The exact lead, unchanged pending ask ID, current lead identity, and chief
lease must validate. The pending ask is cleared only after accepted delivery.
`staff reply` accepts optional `files`. Lead activity returns asynchronously;
continue only independent chief work, otherwise end the turn and do not poll.

## UI and failure rules

The `/chief` command is state-sensitive. From an ordinary lead, `/chief`
activates chief mode and shows the ambient widget. While already active as
chief, `/chief` opens the interactive overview. `/chief leave` leaves chief
mode and removes the widget.

The active chief gets a width-aware compact leads-only ambient widget and a
native `/chief` overview with peek and focus. Leads are ordered by attention,
working, blocked, idle/done, then unknown. Attention is rendered separately
from lifecycle: `!` means `needs_you`, `●` means working, `◐` means blocked,
`◌` means settling or starting, `○` means idle or done, `?` means unknown,
and `×` means lost. An idle or done lead with active delegated descendants
uses `◉`; `◐` never means attention. The ambient widget uses
presentation-only tree branches for visible lead rows, while the native
overview stays flat. Human supervision peek renders at most 40 lines after
width-safe presentation of its state, recent output, agents, and process
evidence; this rendering bound is separate from the inspect capture bounds.
Missing, replaced, ambiguous, or conflicting identity fails closed. There is no
descendant selector or force-takeover action.
