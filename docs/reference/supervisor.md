# Supervisor tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

The recipient-specific upward tools are `message_manager` and
`message_chief`. The tool name identifies the verified recipient role; the
caller supplies only a message and optional evidence files, never a target.
Herdsman resolves and revalidates the actual recipient at execution.

| Sender                                                         | Available tool    | Delivery                                                  |
| -------------------------------------------------------------- | ----------------- | --------------------------------------------------------- |
| Assigned Managed Lead                                          | `message_manager` | Durable project message, retained across Manager turnover |
| Ordinary Lead with active project Manager                      | `message_manager` | Direct message to the verified Manager                    |
| Ordinary Lead without an eligible Manager, supervised by Chief | `message_chief`   | Direct message to the verified Chief                      |
| Manager                                                        | `message_chief`   | Direct message to the verified Chief                      |
| Chief, unsupervised Lead, or Managed Agent                     | Neither           | No upward supervisor tool                                 |

Managed Leads have `message_manager` only while their exact project
assignment is verified; unavailable, retired, or otherwise unverified Managed
Leads receive neither upward tool and retain only exact-owner recovery
capabilities.

An assigned Lead never bypasses Manager, including when no Manager process is
active. Ordinary Leads contact only their currently verified direct
supervisor. If authority changes after a tool was selected, the stale call
fails rather than being redirected. A Managed Agent uses `notify_owner` for
nonblocking material information and `await_owner` when it cannot continue
without its exact owner's answer; its owner is not an upward supervisor.

Both tools use the same input:

```json
{
  "message": "The API contract has a compatibility risk that needs attention.",
  "files": ["result:reviewer#1"]
}
```

Messages are asynchronous and nonblocking. Use them for material information
the recipient needs, such as a timely question, clarification, blocker,
warning, scope conflict, risk, decision request, or important evidence.
Continue independently safe work while a reply is pending. Do not duplicate
information that can wait for an automatic result handoff. Assigned Leads'
automatic completed-result and settled-herd delivery remains separate from
explicit project messages; it does not carry file attachments.

Messages are bounded by configured per-file and complete-message budgets.
`files` accepts ordinary paths, reusable direct Agent refs, and canonical
result refs already supplied as evidence. Supported UTF-8 text is delivered in
full or the handoff fails; the physical 8 KiB coordination-record limit does
not truncate the recipient's message. Hidden semantic-result bindings remain
available for the recipient to forward.

Direct messages are queued for the exact current recipient and validated
against current authority before delivery. Manager messages to ordinary Leads
continue to use the existing cooperative steering lane; upward messaging does
not change transport, persistence, retries, or delivery semantics.

## See also

- [Staff tools](staff.md)
- [Peer tools](peer.md)
- [Project orchestration](../guides/project-orchestration.md)
