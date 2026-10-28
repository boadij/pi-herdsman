# Peer reference

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

`peer` is horizontal coordination between live sessions of the **same coordinator role**: Lead ↔ Lead or Manager ↔ Manager. Local ordinary Leads can communicate globally. Local managed or assigned Leads are restricted to the same verified Herdr worktree group on the same socket, with current exact assignment evidence. Across saved Herdr machines, only verified ordinary, unassigned Leads are eligible; Managers retain their existing Manager-to-Manager federation. Managed Agents and Chief have no peer presence. A healthy coordinator publishes a private generation-bound record in `runtime/peers-v2/peers/`; dead, stale, malformed, or replaced process-lock claims are ignored. Unhealthy coordination withdraws presence while retaining queued messages.

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

Leads (including eligible managed Leads) and active Managers have `list_peers` and `message_peer`.
Initiate a peer message for concrete, task-relevant coordination another eligible coordinator needs. Reply when asked or when a response resolves the exchange; avoid unsolicited routine broadcasts and unnecessary acknowledgments. Share useful evidence when it helps the peer act.

```json
{}
```

Returns this session separately from independently discovered eligible
same-role sessions. A Lead or Manager may also receive an optional
`reply_only` collection for originating sessions of its current role with an
existing authorized return correspondence. Target-bearing entries have this
form:

```json
{
  "peers": [
    {
      "target": "lead:7k3mp9qd2f",
      "name": "workspace/api",
      "cwd": "/work/api",
      "repo": "api",
      "branch": "feature/peer",
      "workspace_label": "api"
    }
  ],
  "reply_only": [
    {
      "target": "lead:4n8rx2c6ya",
      "name": "Research peer",
      "workspace_label": "project-alpha/main"
    }
  ]
}
```

`reply_only` is omitted when empty. Its targets are not independently
discovered peers. Optional `name` and `workspace_label` are last-known,
sender-provided presentation context; they may be absent, non-unique, or stale.
These labels do not verify identity, availability, machine
origin, project ownership, or permission to initiate an unrelated conversation.
Each peer is addressed by its stable `target`; the same role/session has the
same target whether discovered locally or through federation. Targets resolve
to exact coordinator sessions but are not authorization. `message_peer`
revalidates identity and authority when sending, including the existing
eligibility and correspondence checks. Missing reciprocal Herdr/SSH
configuration does not prevent replies through an existing correspondence;
reverse connectivity is needed only to independently initiate communication.
Therefore, an empty `peers` list does not necessarily mean communication with
known originating peers through current-role correspondences is impossible.

The current session is identified separately from `peers`. Peer targets are
caller-session-scoped bindings, not portable aliases. An unresolved target is
rejected; rediscover it with `list_peers` before messaging. Do the same when
identity or eligibility is uncertain. Names, paths, branches, and workspace
labels are descriptive metadata, not target handles. The model-facing list has
no `session_id`, `pane_id`, `tab_id`, or `workspace_id` fields.

When the active coordinator is a Manager, the list also discovers live Managers
on enabled, reachable saved Herdr machines. An ordinary Lead similarly
discovers only remote Leads verified as ordinary and unassigned by the remote
machine's authoritative assignment scan. Managed or assigned Leads are not
remote federation targets. Those entries use the same stable target format and
include a `machine` display label. If remote Lead eligibility cannot be
verified, that machine does not contribute Lead results; an incomplete scan
does not mean that no eligible Leads exist. Labels are not authority. Remote
transport requires an independently working noninteractive OpenSSH target with
normal strict host-key verification. `ssh://` targets and SSH-config aliases
are supported; Herdr-only temporary authentication is not.

An eligible peer in `peers` has been verified for discovery, but
`message_peer` still revalidates identity and authority when sending. A peer in
`reply_only` has an existing authorized return correspondence: its reply can
be queued even though its current independent availability is unverified.
Neither display metadata nor a diagnostic observation makes a target
addressable. Discovery failures appear as an optional `remote_diagnostics`
array and do not hide peers discovered successfully elsewhere:

```json
{
  "remote_diagnostics": [
    {
      "machine": "base",
      "reason": "build_mismatch",
      "peer": "worker",
      "local_build": "v0.34.1 · 0123456789ab",
      "remote_build": "v0.34.0 · fedcba987654"
    }
  ]
}
```

Each diagnostic has one of these reasons:

- `machine_list_failed`: Herdr's saved machine list could not be read.
- `herdr_not_reachable`: Herdr did not confirm reachability for the saved
  machine; this does not establish that its physical host is offline.
- `probe_failed`: the remote peer probe failed before identity was established.
- `build_mismatch`: an observed peer has valid build evidence that differs from
  this runtime. The affected peer is excluded from `peers`.
- `build_unverified`: an observed peer has missing or invalid build evidence
  and is excluded from `peers`.
- `eligibility_unverified`: a remote ordinary-Lead assignment scan was
  incomplete. That machine contributes no Lead results; this does not assert
  that it has no eligible Leads.

`machine` and optional `peer` values are bounded display hints, not target
handles. Build fields appear only for validated build mismatches. Diagnostics
contain no connection targets, credentials, or raw transport errors; they are
observations, never authorization records. A complete scan with no eligible
peers is a normal empty result and needs no diagnostic. A listing, reachability,
probe, or eligibility diagnostic means discovery is incomplete even when other
peers were found; build diagnostics report observed peers that were excluded.
`remote_diagnostics` contains at most 20 entries. If more were observed,
`remote_diagnostics_omitted` gives the exact additional count; total warnings
are the array length plus that count. Expanded Pi output also reports any
diagnostics it omits from display.

```json
{
  "target": "lead:7k3mp9qd2f",
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
a coordinator may reply to an exact `reply_only` target through its existing
return correspondence. This does not grant general initiation permission.

Remote sends are retained locally until the remote endpoint confirms durable
acceptance. Failed sends remain queued and retry automatically while the
coordinator inbox is active; `list_peers` also triggers immediate
reconciliation. Acceptance is not delivery to Pi or completion of the requested
work. An accepted request establishes a capability-scoped, durable return
correspondence bound to the coordinator role. The recipient can reply to the
exact originating session with `message_peer`; the reply is queued at the
recipient and retrieved automatically while the origin's inbox runtime is
active. Replies remain queued until acknowledged, including across temporary
disconnections; reverse SSH is not required. Recovery is allowed only for the
same exact Pi session after it re-establishes live authority for that role; a
replacement session or a different role is not substituted. Requests also
verify the endpoint's effective Herdsman data root against the discovered
route before recovery or reply transfer. Delivery to Pi and completion of the
requested work remain separate states.
