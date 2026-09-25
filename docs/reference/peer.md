# Peer reference

[Documentation index](../README.md) · [Supervision concept](../concepts/supervision.md)

`peer` is horizontal coordination between live sessions of the **same coordinator role**: Lead ↔ Lead or Manager ↔ Manager. Discovery and transport are user-global, including across Herdr sockets; they are not project-filtered. Managed Agents and Chief have no peer presence. A healthy coordinator publishes a private generation-bound record in `runtime/peers-v2/peers/`; dead, stale, malformed, or replaced process-lock claims are ignored. Unhealthy coordination withdraws presence while retaining queued messages.

```json
{ "action": "list" }
```

Returns this session separately from other same-role sessions:

```json
{
  "self": "<this exact Pi session ID>",
  "peers": [
    {
      "session": "<exact Pi session ID>",
      "name": "workspace/api",
      "cwd": "/work/api",
      "repo": "api",
      "branch": "feature/peer",
      "workspace_label": "api"
    }
  ]
}
```

Only `session` is a target handle; names and workspace metadata are display-only and may be empty.

```json
{
  "action": "message",
  "session": "<exact Pi session ID from peer list>",
  "message": "The integration is ready.",
  "files": ["result:researcher#1"]
}
```

`files` accepts ordinary local paths, direct-Agent result refs resolved on the caller's current branch, and canonical `result:<request-id>` refs already supplied as evidence. Attachment content is prepared on submission; durable inbox records remain text-only and bounded. Publication rechecks sender and target generation, and delivery revalidates the current same-role receiver. Pi follow-up delivery may wait while the receiver is busy; transient failures retain the message. A queued message survives sender shutdown. Peer messages are coordination data, not assignments or authority to control another session.
