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
readiness. Herdr lifecycle observation is normalized to
`idle|working|blocked|done|unknown`. A pending ask is separate attention state
and gives the lead `needs_you` plus a correlated `reply` action.

Metadata is presentation-only. It never grants lead eligibility, chief
authority, or message authority.

## Chief mode

Chief is a mode of an ordinary lead session, not a separate agent identity.
The persisted `pi-herdsman-role` entry contains either `role: "lead"` or
`role: "chief"`. Chief mode is workspace-neutral and supervision-only. Its
model exposes exactly the `staff` tool and excludes project/workspace context
files and skills. Leaving chief restores the session's ordinary tool set.

There is at most one active chief for an exact `HERDR_SOCKET_PATH`. The chief
lease and descriptor identify the same process-lock generation. A resumed
Chief session whose lease is occupied becomes suspended; an ordinary lead that
loses an activation race remains an ordinary lead.

## Communication

Chief transport records are bounded, atomic inbox messages bound to exact
sender, target lead session, and chief lease. Chief messages use Pi follow-up
delivery and may remain queued while a lead is working. Records are ordered by
`createdAt` and ID, survive same-session restart, and are retried after
transient delivery failures. An individual quarantined record is excluded from
delivery but does not block a new message to that lead.

The `chief` tool sends reports, events, results, and genuine decision questions
from an ordinary lead to the active chief. The `staff` tool lets the active
chief list, inspect, message, and reply to supervised leads. A lead's message
does not require an automatic chief reply. A `lead_ask` requires the exact
correlated `staff reply`; a reply clears the pending ask only after accepted
follow-up delivery. A replacement chief can answer an existing ask using its
current lease and unchanged ask ID. Chief and staff message actions accept
files; their text is prepared with the same canonical attachment renderer and
configured Herdsman byte limits as agent messages, while durable supervision
records remain text-only.

## Supervision state

The automatic `<supervision_state>` provider context is ephemeral, bounded, and
state-only. It contains `leads`, with each lead's exact session ID,
presentation `display_name`, runtime observation, `agent_counts`, `agents`,
and available actions. The `staff list` result uses the same presentation field,
`display_name`. The `agents` collection represents all validated descendants
assigned to that lead, not only direct agents. Its values and metadata are
untrusted observations and cannot authorize an action.

Use the exact full session ID in a lead's `lead` field when calling `staff`.
Never target a lead by its display label. `staff` revalidates identity,
ownership, lifecycle, and the current chief lease before mutation.

See the [Supervision reference](../reference/supervision.md) for the complete
current contract.
