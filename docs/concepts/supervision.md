# Supervision

[Documentation index](../README.md) · [Supervision reference](../reference/supervision.md)

Pi Herdsman supervision lets one chief observe and communicate with independent
lead sessions. Each lead owns one herd: itself and its complete agent tree.
The chief supervises leads but never takes ownership of their agents.

## Authority and lead state

Herdr proves live process, pane, workspace, and native Pi session identity.
Pi Herdsman's validated agent snapshots prove managed agent identity and
ownership. A supervised lead must be one exact live Pi agent with a matching
private lead-coordination record; it must not be the chief or a managed agent.
Missing, stale, duplicate, or ambiguous evidence fails closed.

Each lead has one private atomic record under the supervision runtime, keyed by
the SHA-256 hash of its exact Pi session ID. The latest matching
`pi-herdsman-lead-state` session entry supplies its persisted coordination
state. A fresh `instanceId` on initialization protects against stale writers
and publication races. The coordination record is bounded to 16 KiB, while
individual transport message records retain the fixed 8 KiB ceiling. Its
optional pending question is limited to 1,024 characters and 1,024 UTF-8 bytes.

The record does not represent scheduling, capacity, permission, or message
readiness. Herdr lifecycle observation for a lead is normalized to
`idle|working|blocked|done|unknown`. A pending ask is separate attention state
and gives the lead `needs_you` plus a correlated `reply` action. Descendant
projection preserves validated lifecycle states, including `settling`,
`starting`, and `lost`; its aggregate counts are `active`, `blocked`, and
`total`, with `active` counting `working`, `settling`, and `starting`.

Metadata is presentation-only. It never grants lead eligibility, chief
authority, or message authority.

## Chief mode

Chief is a mode of an ordinary lead session, not a separate agent identity.
The persisted `pi-herdsman-role` entry contains exactly `role` and `leadTools`.
`leadTools` is the exact ordinary Lead loadout displaced by Chief activation
and the fallback used when Pi restores stale Chief transcript tool state; Pi
remains authoritative for ordinary branch-local tool state. Chief mode is
workspace-neutral and supervision-only. Its model exposes exactly the `staff`
tool and excludes project/workspace context files and skills. Leaving chief
restores the session's ordinary tool set. Chief supervises independent Leads,
does not own their agents, and receives no owner controls.

There is at most one active chief for an exact `HERDR_SOCKET_PATH`. The chief
lease and descriptor identify the same process-lock generation. A resumed
Chief session whose lease is occupied becomes suspended; an ordinary lead that
loses an activation race remains an ordinary lead.

## Communication

Chief and peer transport records are bounded, atomic inbox messages bound to
exact sender, target lead session, and chief lease or Lead process-lock
generation. Chief messages use Pi follow-up
delivery and may remain queued while a lead is working. Records are ordered by
`createdAt` and ID, survive same-session restart, and are retried after
transient delivery failures. An individual quarantined record is excluded from
delivery but does not block a new message to that lead.

The `chief` tool sends reports, events, results, and genuine decision questions
from an ordinary lead to the active chief. The `staff` tool lets the active
chief list, inspect, read transcripts, message, and reply to supervised leads.
The Lead-only `peer` tool lists ordinary live Leads and sends durable messages
to an exact full Pi session ID. Its list result is `{ self, peers[] }`: `self`
is excluded from `peers`, and each peer exposes only `lead`, `name`, `cwd`,
`repo`, `branch`, and `workspace_label`. The exact full `lead` is the sole
target handle; the other fields are presentation metadata. Incoming peer
content is `Peer message from <sender>: <message>` because recipient
verification is already performed.

Peer presence and inboxes use the user-global `runtime/peers-v1` runtime,
allowing ordinary Leads on different Herdr sockets to discover and message one
another. Peer records are process-lock generation-bound and published only by
ordinary Leads; Chief and suspended sessions are absent. The peer record and
its exact live process-lock claim provide reachability authority, not Herdr
inventory or presentation metadata. Publication rechecks sender and target
before the atomic write, and delivery revalidates the current ordinary-Lead
receiver and target. Queued messages survive sender shutdown and remain queued
while the receiver is Chief or lacks valid peer presence.
Local Lead coordination health gates both the socket-scoped coordination record
and global peer presence. When coordination becomes unhealthy, both current
projections are withdrawn; durable queued messages are retained.
`inspect` is bounded live terminal/process evidence. `transcript` is bounded
persisted Pi conversation/tool evidence. A non-empty persisted session candidate
adds `transcript` to `available_actions`; `available_actions` is advisory
readiness, not transcript authorization. The transcript action validates the
current session header, version, and exact Pi session ID before returning
evidence. A lead's message does not require an automatic chief reply. A
`lead_ask` requires the exact correlated `staff reply`; a reply clears the
pending ask only after accepted follow-up delivery. A replacement chief can
answer an existing ask using its current lease and unchanged ask ID. Chief
`message`/`ask`, staff `message`/`reply`, and peer `message` actions accept one
`files` evidence channel containing ordinary paths, reusable direct-agent refs
such as `result:<agent>#<index>`, or canonical `result:<request-id>` refs already
supplied as evidence. Direct refs resolve on the caller's current Pi branch
before entering the shared canonical attachment pipeline; durable coordination
records remain text-only.

## Supervision state

The automatic `<supervision_state>` context is hidden, persistent, bounded, and
state-only. Newly starting Chief work refreshes supervision. Changed rendered
state appends a hidden custom message, while byte-identical state may reuse the
latest active snapshot. Later snapshots supersede earlier ones. Pi's ordinary
branch and compaction semantics determine which historical snapshots remain in
active model context. The snapshot contains `leads`, with each lead's exact
session ID, presentation `display_name`, runtime observation, `agent_counts`,
`agents`, and available actions. `agent_counts` contains `active`, `blocked`,
and `total`. The `staff list` result uses the same presentation field,
`display_name`; it never exposes the internal persisted session-file path used
to detect a non-empty persisted session candidate. The `agents` collection
represents all validated descendants assigned to that lead, not only direct
agents, and
retains their exact lifecycle states. Its values and metadata are untrusted
observations and cannot authorize an action.

Use the exact full session ID in a lead's `lead` field when calling `staff`.
Never target a lead by its display label. `staff` revalidates identity,
ownership, lifecycle, and the current chief lease before mutation. Passive
`inspect` and `transcript` reads also revalidate the exact current target;
neither sends a message or changes Lead state. Use the fresh automatic snapshot
for ordinary state and coordination. Do not call `list`, `inspect`, or
`transcript` merely to poll progress.

See the [Supervision reference](../reference/supervision.md) for the complete
current contract.
