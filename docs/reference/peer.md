# Peer reference

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

`peer` is horizontal coordination between live sessions of the **same coordinator role**: Lead ↔ Lead or Manager ↔ Manager. Manager peers remain user-global. Ordinary Leads can communicate globally, including across Herdr sockets; if either Lead has an exact current `ProjectAssignment`, both must be in the same verified Herdr worktree group on the same socket. Managed Agents and Chief have no peer presence. A healthy coordinator publishes a private generation-bound record in `runtime/peers-v2/peers/`; dead, stale, malformed, or replaced process-lock claims are ignored. Unhealthy coordination withdraws presence while retaining queued messages.

Assignment mutations and peer authorization share a short-lived user-global
process lock. Under it, Herdsman validates every canonical assignment record
across socket namespaces. Only a complete no-match proves that a Lead is
ordinary, including when Herdr verified no Git worktree group. Incomplete,
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
provenance to that generation; managed status is derived from the global exact
assignment snapshot. Presentation metadata, branch names,
cwd, and checkout names are not authority. Peer publication makes a best-effort final
reread of the captured sender and target generations immediately before
writing. Presentation-only enrichment does not invalidate a message, and a
replacement process-lock claim observed by that reread rejects it. The target's
held presence lock and the inbox message lock are separate, so a replacement
can race after the reread. Submission rechecks eligibility after attachment
preparation and publishes under the assignment authority lock; exact session IDs do not bypass the policy. Queued peer messages
retain verified sender context across sender shutdown or takeover; delivery
checks the recipient's current assignment and group. Transient topology failures
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

Returns this session separately from other same-role sessions:

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
  ]
}
```

`self` is never repeated in `peers`. Each peer has a `session`, `name`, `cwd`,
`repo`, `branch`, and `workspace_label`; presentation metadata may be empty.
Only the exact full `session` ID is a messaging target. Names, paths, branches,
and workspace labels are display metadata, not target handles. The model-facing
list has no `session_id`, `pane_id`, `tab_id`, or `workspace_id` fields.

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
same semantic ref. Files and refs share the same submission-time UTF-8
embedding, reference fallback, and configured byte limits. The durable peer
record carries the prepared text and any hidden bindings and is bounded by the
8 KiB coordination transport limit.
