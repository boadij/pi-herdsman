# Lead peer reference

[Documentation index](../README.md) · [Supervision concept](../concepts/supervision.md)

Peer coordination is ordinary Lead-to-Lead communication. It does not change
ownership: every Lead still owns its complete managed-agent tree, and Chief
still supervises independent Leads without owning their agents.

## Presence and identity

An ordinary Lead publishes one private `PeerLeadRecord` under the
user-global `runtime/peers-v1/peers/` directory beneath the Herdsman data root.
This peer runtime is independent of the socket-scoped supervision runtime, so
ordinary Leads attached to different Herdr sockets share peer discovery and
transport. The record publishes the exact Pi session, Herdr pane, tab,
workspace, and current Lead cwd with the `{ pid, id }` claim for that Lead's
per-session process lock immediately. The current session name, repository,
branch, and workspace label are optional presentation metadata; repository,
branch, and workspace label are enriched asynchronously without delaying Lead
startup or Chief leave. Peer cwd is always the Lead's current `ctx.cwd`, never
a Herdr provenance or source-checkout path. The record is
valid only while the record's claim is the exact live process-lock generation.
Missing, malformed, duplicate, replaced, or dead-lock evidence is ignored.
Chief and suspended Lead sessions do not publish peer presence. Enumeration
scans every canonical filename in the global registry, then filters malformed
or dead records; one stale record does not hide later live peers.

Presence is observation, not permission. The global peer record and its exact
live process-lock claim are the reachability authority; Herdr inventory and
presentation metadata are not. Peer publication makes a best-effort final
reread of the captured sender and target generations immediately before
writing. Presentation-only enrichment does not invalidate a message, and a
replacement process-lock claim observed by that reread rejects it. The target's
held presence lock and the inbox message lock are separate, so a replacement
can race after the reread. Delivery validates the current ordinary-Lead target
record and target structure only. Managed agents, Chief sessions, display
labels, and metadata are never peer targets.

## `peer`

The Lead-only `peer` tool has two actions:

```json
{ "action": "list" }
```

returns the current ordinary live Leads other than this Lead. The result keeps
this Lead separate from the peers:

```json
{
  "self": "<this Lead's exact full Pi session ID>",
  "peers": [
    {
      "lead": "<exact full Pi session ID>",
      "name": "workspace/api",
      "cwd": "/work/api",
      "repo": "api",
      "branch": "feature/peer",
      "workspace_label": "api"
    }
  ]
}
```

`self` is never repeated in `peers`. Each peer has a `lead`, `name`, `cwd`,
`repo`, `branch`, and `workspace_label`; presentation metadata may be empty.
Only the exact full `lead` ID is a messaging target. Names, paths, branches,
and workspace labels are display metadata, not target handles. The model-facing
list has no `session_id`, `pane_id`, `tab_id`, or `workspace_id` fields.

```json
{
  "action": "message",
  "lead": "<exact full Pi session ID from peer list>",
  "message": "The integration is ready.",
  "files": ["/tmp/checklist.md", "result:researcher#1"]
}
```

`message` accepts ordinary files, reusable direct-agent refs such as
`result:researcher#1`, and canonical `result:<request-id>` refs already supplied
as evidence. A semantic ref is resolved on the sender's current branch to its
canonical result reference before the existing attachment preparation runs.
Files and resolved refs therefore share the same submission-time UTF-8
embedding, reference fallback, and configured byte limits. The durable peer
record remains text-only and bounded by the 8 KiB coordination transport limit.

Peer records use the global peer runtime's shared coordination inbox. Delivery
uses Pi `deliverAs: "followUp"` with `triggerTurn: true`, survives a busy
receiver, and is retried after transient delivery failure. Publication makes a
best-effort final reread of the sender and target immediately before the atomic
write and rejects the message when that reread observes a changed captured
process-lock generation. Presentation metadata may be enriched independently
and does not invalidate publication. Because the reread and inbox write use
separate process locks, a replacement racing after the reread may still leave a
durable message; delivery validates the current ordinary-Lead receiver record
and target structure. A queued message remains valid after the sender exits, so
sender shutdown does not strand an already published message. A queued peer
message is retained while its receiver is Chief and is delivered after that
session returns to ordinary Lead. Shutdown aborts
in-flight delivery and removes the sender's presence before releasing its
process lock.

The recipient receives the message content as
`Peer message from <sender lead ID>: <message>`. It is already addressed to the
receiving Lead; the sender ID identifies the peer that sent it. Delivery still
verifies the current ordinary-Lead receiver record and target structure before
injecting that content.

Peer transport shares the existing atomic, bounded, quarantined coordination
inbox implementation with Chief traffic. Chief records retain their existing
authority, descriptor, lease, pending-ask, and storage boundaries.
