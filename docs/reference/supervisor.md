# Supervisor tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

`supervisor_message` is the coordination operation for ordinary Leads and
Managers. An assigned project Lead saves messages with its project assignment
for the current or a replacement Manager, even when no Manager is active; it
does not route those messages to Chief. An unassigned Lead routes to its active
Manager when one exists, otherwise to Chief. A Manager routes to Chief. Managed
Agents use `ask_owner` instead.

Direct-supervisor delivery validates the current authority. Ambiguous or
incomplete authority fails closed instead of silently routing around an
intermediate Manager; project-scoped messages instead validate the assignment.

## `supervisor_message`

Available to ordinary Leads and Managers.

```json
{
  "message": "The branch is ready for review.",
  "files": ["result:reviewer#1"]
}
```

Use it for material progress, decisions, warnings, and review handoffs. For a
Lead with a project assignment, the message is retained with that assignment
and can be delivered to a current Manager even if no Manager is active when it
is sent. A replacement Manager receives retained project messages; the same
Manager session does not receive a message again once it appears in its Pi
history. These messages are nonterminal: the project remains open until a
Manager resolves the assignment.

For ordinary Lead or Manager-to-Chief communication, the message follows the
current direct-supervisor route. Messages are bounded. `files` accepts ordinary
paths, reusable direct Agent refs, and canonical result refs already supplied
as evidence; attachments are prepared at submission and the durable message is
text-only.

## Delivery

Direct-supervisor messages are queued for the exact current recipient and
validated against current authority before delivery. Assigned project Lead
messages are scoped by repository, branch, and exact Lead session and remain
available while the assignment exists. Resolving the assignment removes its
retained project messages.

## See also

- [Staff tools](staff.md)
- [Peer tools](peer.md)
- [Project orchestration](../guides/project-orchestration.md)
