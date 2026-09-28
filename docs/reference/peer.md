# Peer reference

[Documentation index](../README.md) · [Supervision concept](../concepts/supervision.md)

`peer` is horizontal coordination between live sessions of the **same coordinator role**: Lead ↔ Lead or Manager ↔ Manager. Discovery and transport are user-global, including across Herdr sockets; they are not project-filtered. Managed Agents and Chief have no peer presence. A healthy coordinator publishes a private generation-bound record in `runtime/peers-v2/peers/`; dead, stale, malformed, or replaced process-lock claims are ignored. Unhealthy coordination withdraws presence while retaining queued messages.

## Presence and identity

An ordinary Lead or active Manager publishes one private peer record under the
user-global `runtime/peers-v2/peers/` directory beneath the Herdsman data root.
This peer runtime is independent of the socket-scoped supervision runtime, so
same-role coordinators attached to different Herdr sockets share peer discovery and
transport. The record publishes the exact Pi session, Herdr pane, tab,
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
live process-lock claim are the reachability authority; Herdr inventory and
presentation metadata are not. Peer publication makes a best-effort final
reread of the captured sender and target generations immediately before
writing. Presentation-only enrichment does not invalidate a message, and a
replacement process-lock claim observed by that reread rejects it. The target's
held presence lock and the inbox message lock are separate, so a replacement
can race after the reread. Delivery validates the current same-role target
record and target structure only. Managed agents, Chief sessions, display
labels, and metadata are never peer targets.

## Peer tools

Ordinary Leads and active Managers have `peer_list` and `peer_message`.

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
  "session": "<exact full Pi session ID from `peer_list`>",
  "message": "The integration is ready.",
  "files": ["result:researcher#1"]
}
```

`peer_message` accepts ordinary files, reusable direct-agent refs such as
`result:researcher#1`, and canonical `result:<request-id>` refs already supplied
as evidence. A semantic ref is resolved on the sender's current branch to its
canonical result reference before the existing attachment preparation runs.
Files and resolved refs therefore share the same submission-time UTF-8
embedding, reference fallback, and configured byte limits. The durable peer
record remains text-only and bounded by the 8 KiB coordination transport limit.
