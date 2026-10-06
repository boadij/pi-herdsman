# Supervisor tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

`supervisor_message` is the coordination operation for ordinary Leads and
Managers. An assigned project Lead saves messages with its project assignment
while pending when no Manager can receive them; it does not route those messages
to Chief. An unassigned Lead routes to its active
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
the Lead's normal response to each project-assignment delivery as a project
message for the Manager role. If the Lead successfully
delegates or continues managed Agent work, the herd run owns that handoff until
it settles, and the settled response should summarize outcome, validation, and
important unresolved points. An unsuccessful delegation leaves the local
assignment-response path available. Later conversational replies, including
routine acknowledgments, remain local and are not automatically promoted. Assigned Lead messages are persisted while pending when no Manager can receive
them. The next verified Manager receives pending messages. Once exact delivery
appears in that Manager's Pi session history, Herdsman consumes the pending
record; later Managers do not automatically replay it. Pending backlog from
before the current Manager generation is inserted without starting one
autonomous turn per message; new messages during the active Manager generation
continue to wake the Manager. Already-delivered messages are Pi conversation
history, not pending Herdsman coordination. Project messages remain nonterminal.
Project retirement still follows authoritative Herdr worktree removal.

An ordinary Lead without a verified supervisor should continue independently
until a supervisor is available. An assigned project Lead remains Manager-owned
and may leave pending messages in project storage while no Manager is active.

For ordinary Lead or Manager-to-Chief communication, the message follows the
current direct-supervisor route. Messages are bounded. `files` accepts ordinary
paths, reusable direct Agent refs, and canonical result refs already supplied
as evidence; attachments are prepared at submission and the durable message
carries prepared text plus any hidden semantic-result bindings needed for the
recipient to forward them.

## Delivery

Direct-supervisor messages are queued for the exact current recipient and
validated against current authority before delivery. Assigned project Lead
messages are scoped by repository, branch, and exact Lead session while pending;
they are consumed after delivery or discarded on authoritative project
retirement. Successful Herdr worktree removal
retires the assignment and removes any still-pending project messages.

## See also

- [Staff tools](staff.md)
- [Peer tools](peer.md)
- [Project orchestration](../guides/project-orchestration.md)
