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
  "message": "The Agent is blocked pending an API contract decision.",
  "files": ["result:reviewer#1"]
}
```

Use it only when material coordination needs a supervisor's attention,
decision, or action, such as a blocker, warning, scope change, risk, or
important evidence. For an assigned project, Herdsman automatically records
the Lead's normal response to the initial project assignment as a project
message for the current or a replacement Manager. If the Lead successfully
delegates or continues managed Agent work, the herd run owns that handoff until
it settles, and the settled response should summarize outcome, validation, and
important unresolved points. An unsuccessful delegation leaves the local
assignment-response path available. Later conversational replies, including
routine acknowledgments, remain local and are not automatically promoted. For a Lead
with a project assignment, messages are retained with that assignment and can
be delivered to a current Manager even if no Manager is active when sent. A
replacement Manager receives retained project messages; the same Manager
session does not receive a message again once it appears in its Pi history.
Both handoffs and
messages are nonterminal; the project remains open until successful Herdr
worktree removal retires its assignment.

An ordinary Lead without a verified supervisor should continue independently
until a supervisor is available. An assigned project Lead remains Manager-owned
and may message the Manager role while no Manager is active; the message is
retained with the project assignment.

For ordinary Lead or Manager-to-Chief communication, the message follows the
current direct-supervisor route. Messages are bounded. `files` accepts ordinary
paths, reusable direct Agent refs, and canonical result refs already supplied
as evidence; attachments are prepared at submission and the durable message
carries prepared text plus any hidden semantic-result bindings needed for the
recipient to forward them.

## Delivery

Direct-supervisor messages are queued for the exact current recipient and
validated against current authority before delivery. Assigned project Lead
messages are scoped by repository, branch, and exact Lead session and remain
available while the assignment exists. Successful Herdr worktree removal
retires the assignment and removes its retained project messages.

## See also

- [Staff tools](staff.md)
- [Peer tools](peer.md)
- [Project orchestration](../guides/project-orchestration.md)
