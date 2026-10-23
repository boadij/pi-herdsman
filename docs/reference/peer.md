# Peer reference

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

`peer` is horizontal coordination between live sessions of the **same coordinator role**: Lead ↔ Lead or Manager ↔ Manager. Manager peers remain user-global. Ordinary Leads can communicate globally, including across Herdr sockets; if either Lead is a Managed Lead, it must have a current exact `ProjectAssignment` and both must be in the same verified Herdr worktree group on the same socket. Managed Agents and Chief have no peer presence. A healthy coordinator publishes a private generation-bound record in `runtime/peers-v2/peers/`; dead, stale, malformed, or replaced process-lock claims are ignored. Unhealthy coordination withdraws presence while retaining queued messages.

Assignment mutations and peer authorization share a short-lived user-global
process lock. Under it, Herdsman validates every canonical assignment record
across socket namespaces. Ordinary identity is immutable and exact-session-bound; assignment absence
does not turn a Managed Lead into an ordinary peer. Incomplete,
corrupt, ambiguous, or unavailable assignment evidence fails closed. If either
Lead is assigned, verified matching group and socket evidence is required.

## Presence and identity

An ordinary Lead or active Manager publishes one private peer record under the
user-global `runtime/peers-v2/peers/` directory beneath the Herdsman data root.
This peer runtime is independent of the socket-scoped supervision runtime, so
same-role coordinators attached to different Herdr sockets share peer discovery and
transport subject to the project eligibility rule above. The record publishes the exact Pi session, Herdr pane, tab,
workspace, and current coordinator cwd with the `{ pid, id }` claim for that session's
per-session process lock immediately. The current session name, repository,
branch, and workspace label are optional presentation metadata; repository,
branch, and workspace label are enriched asynchronously without delaying coordination
startup. Peer cwd is always the session's current `ctx.cwd`, never
a Herdr provenance or source-checkout path. The record is
valid only while the record's claim is the exact live process-lock generation.
Missing, malformed, duplicate, replaced, or dead-lock evidence is ignored.
Chief and suspended sessions do not publish peer presence. Enumeration
scans every canonical filename in the global registry, then filters malformed
or dead records; one stale record does not hide later live peers.
The coordinator withdraws peer presence whenever its current coordination
generation becomes unhealthy. Successful durable recovery republishes a fresh
presence generation rather than reviving the prior claim.

Presence is observation, not permission. The global peer record and its exact
live process-lock claim bind the publisher's socket and verified project-group
provenance to that generation; immutable session kind and the global exact
assignment snapshot separately establish identity and project eligibility. Presentation metadata, branch names,
cwd, and checkout names are not authority. Peer publication makes a best-effort final
reread of the captured sender and target generations immediately before
writing. Presentation-only enrichment does not invalidate a message, and a
replacement process-lock claim observed by that reread rejects it. The target's
held presence lock and the inbox message lock are separate, so a replacement
can race after the reread. Submission rechecks eligibility after attachment
preparation and publishes under the assignment authority lock; exact session IDs do not bypass the policy. Queued peer messages
retain verified sender context across sender shutdown; discovery, submission,
and delivery revalidate managed eligibility and current assignment/group evidence.
Unavailable or retired Managed Leads never become ordinary global peers. Transient topology failures
defer delivery, while definitive ineligibility rejects it. Managed agents, Chief sessions, display
labels, and metadata are never peer targets.

For a peer on the local Herdr socket, eligibility is checked against current
worktree topology. For a peer on another socket, Herdsman has no existing Pi
primitive to query that socket's live topology: discovery and submission use
the peer's generation-bound published group plus that socket's exact
assignment namespace. The receiving Lead always rechecks its own current
topology before delivery; this does not provide a cross-socket topology RPC.

## Peer tools

Ordinary Leads and active Managers have `list_peers` and `message_peer`.

```json
{}
```

Returns this session separately from independently discovered eligible
same-role sessions. An active Manager may also receive an optional
`reply_only` collection for originating Managers with an existing authorized
return correspondence:

```json
{
  "self": "<this exact Pi session ID>",
  "peers": [
    {
      "session": "<exact full Pi session ID>",
      "name": "workspace/api",
      "cwd": "/work/api",
      "repo": "api",
      "branch": "feature/peer",
      "workspace_label": "api"
    }
  ],
  "reply_only": [
    {
      "session": "<exact originating Manager session ID>",
      "name": "Research Manager",
      "workspace_label": "project-alpha/main"
    }
  ]
}
```

`reply_only` is omitted when empty. Its targets are not independently
discovered peers. Optional `name` and `workspace_label` are last-known,
sender-provided presentation context; they may be absent, non-unique, or stale.
Older correspondences may remain ID-only until a subsequent accepted exchange
provides metadata. These labels do not verify identity, availability, machine
origin, project ownership, or permission to initiate an unrelated conversation.
Only the exact `session` is a `message_peer` target. The result never exposes
correspondence capabilities or other private state. `message_peer` revalidates
identity and authority when sending. Missing reciprocal Herdr/SSH configuration
does not prevent replies through an existing correspondence; reverse
connectivity is needed only to independently initiate communication. Therefore,
an empty `peers` list does not necessarily mean communication with known
originating Managers is impossible.

`self` is never repeated in `peers`. Each peer has a `session`, `name`, `cwd`,
`repo`, `branch`, and `workspace_label`; presentation metadata may be empty.
Only the exact full `session` ID is a messaging target. Names, paths, branches,
and workspace labels are display metadata, not target handles. The model-facing
list has no `session_id`, `pane_id`, `tab_id`, or `workspace_id` fields.

When the active coordinator is a Manager, the list also discovers live Managers
on enabled, reachable saved Herdr machines. Those entries retain the exact Pi
session ID and include a `machine` display label. Reachable-machine probe
failures are reported separately as `unavailable_machines`; labels are not
authority. Remote transport requires an independently working noninteractive
OpenSSH target with normal strict host-key verification. `ssh://` targets and
SSH-config aliases are supported; Herdr-only temporary authentication is not.
Ordinary Lead discovery and messaging remain local/same-machine behavior.

```json
{
  "session": "<exact full Pi session ID from `list_peers`>",
  "message": "The integration is ready.",
  "files": ["result:researcher#1"]
}
```

`message_peer` accepts ordinary files, reusable direct-agent refs such as
`result:researcher#1`, and canonical `result:<request-id>` refs already supplied
as evidence. A semantic ref resolves on the sender's current branch and keeps
its model-facing name during attachment preparation. Its hidden canonical
binding travels with the durable peer message so the recipient can forward the
same semantic ref. Peer attachments must be complete supported UTF-8 text
within both configured byte limits or the handoff is rejected; a reference-only
attachment is not reported as delivered. The compact physical peer record
remains bounded by the internal 8 KiB limit, with larger accepted bodies
stored separately and verified before Pi delivery.

Targets do not all need to be independently discoverable and currently live:
an active Manager may reply to an exact `reply_only` target through its
existing return correspondence. This does not grant general initiation
permission.

Remote Manager sends are retained locally until the remote endpoint confirms
durable acceptance. Failed sends remain queued and retry automatically while
the Manager inbox is active; `list_peers` also triggers immediate
reconciliation. Acceptance is not delivery to Pi or completion of the requested
work. An accepted request also establishes a capability-scoped,
durable return correspondence. The recipient Manager can reply to the exact
originating session with `message_peer`; the reply is queued at the recipient.
Remote Manager replies are retrieved automatically while the originating
Manager's inbox runtime is active. Calling `list_peers` also triggers
reconciliation immediately. Replies remain queued until acknowledged,
including across temporary disconnections; reverse SSH is not required.
Recovery is allowed only for the same exact Pi session after it has
re-established live Manager authority; a
replacement session is not substituted. Requests also verify the endpoint's
effective Herdsman data root against the discovered route before recovery or
reply transfer. Delivery to Pi and completion of the requested work remain
separate states.
