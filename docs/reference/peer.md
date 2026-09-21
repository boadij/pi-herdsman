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
transport. The record contains the exact Pi session, Herdr pane, tab,
workspace, and the `{ pid, id }` claim for that Lead's per-session process
lock. The record is valid only while the record's claim is the exact live
process-lock generation. Missing, malformed, duplicate, replaced, or dead-lock
evidence is ignored. Chief and suspended Lead sessions do not publish peer
presence. Peer enumeration scans at most 32 canonical record entries per
request.

Presence is observation, not permission. Peer actions revalidate the sender,
target, exact Herdr identity, ordinary Lead role, and process-lock generation
immediately before publication or delivery. Managed agents, Chief sessions,
display labels, and metadata are never peer targets.

## `peer`

The Lead-only `peer` tool has two actions:

```json
{ "action": "list" }
```

returns current ordinary live Leads. Each result's `lead` is the exact full Pi
session ID to use for messaging; `pane_id`, `tab_id`, and `workspace_id` are
identity evidence. A display label is not a target.

```json
{
  "action": "message",
  "lead": "<exact full Pi session ID from peer list>",
  "message": "The integration is ready.",
  "files": ["/tmp/checklist.md"]
}
```

`message` queues one durable peer follow-up. Its optional files use the same
submission-time canonical attachment preparation, UTF-8 embedding, reference
fallback, and configured byte limits as other Herdsman messages. The durable
record is text-only and remains bounded by the 8 KiB supervision transport
limit.

Peer records use the global peer runtime's shared coordination inbox. Delivery
uses Pi `deliverAs: "followUp"` with `triggerTurn: true`, survives a busy
receiver, and is retried after transient delivery failure. A queued message is
accepted only while both the exact target and the exact live sender generation
remain ordinary Leads. If the sender exits or its process-lock generation is
replaced, the queued message is rejected rather than attributed to a later
session generation. Shutdown aborts in-flight delivery and removes the
sender's presence before releasing its process lock.

Peer transport shares the existing atomic, bounded, quarantined coordination
inbox implementation with Chief traffic. Chief records retain their existing
authority, descriptor, lease, pending-ask, and storage boundaries.
