# Supervisor tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

`supervisor_message` is the coordination operation for ordinary Leads and
Managers. An assigned project Lead saves messages with its project assignment
while pending when no Manager can receive them; it does not route those messages
to Chief. An unassigned Lead routes only to Chief when verified; an active
same-scope Manager is not its supervisor. A Manager routes to Chief. Managed
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

Use it for material coordination that should reach a supervisor before the
normal result boundary, such as a blocker, warning, scope conflict, risk,
decision request, or important evidence. While an assigned project remains
active, Herdsman automatically returns each completed direct Lead response as a
project message for the Manager role. If managed Agent work is active, the herd
run owns that handoff until it settles; the settled response should summarize
outcome, validation, and important unresolved points. These handoffs are
nonterminal. Do not send a duplicate message solely to report a result
Herdsman will hand off automatically. Assigned Lead messages are persisted
while pending when no Manager can receive them. The next verified Manager
receives pending messages. Once exact delivery
appears in that Manager's Pi session history, Herdsman consumes the pending
record; later Managers do not automatically replay it. Pending backlog from
before the current Manager generation is inserted without starting one
autonomous turn per message; new messages during the active Manager generation
continue to wake the Manager. Already-delivered messages are Pi conversation
history, not pending Herdsman coordination. Project messages remain nonterminal.
Treat routine progress or conversational results as informational and act only
when review, a decision, correction, or other useful coordination is needed.
Successful Herdr worktree removal and confirmed `/takeover` by the assigned
Lead are distinct explicit assignment-release paths; takeover removes pending
messages but preserves the Lead's session, branch, worktree, running process,
and owned Agents. It does not imply completion or acceptance.

An ordinary Lead without a verified Chief should continue independently until
a supervisor is available. An assigned project Lead remains managed by the
Manager role, even when no Manager process is active, and may leave pending
messages in project storage. Manually continuing the exact assigned Pi session
does not release management; `managed-lead` is launch policy, not authority.

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
retirement. Successful Herdr worktree removal or confirmed `/takeover` removes
the assignment and any still-pending project messages.

## See also

- [Staff tools](staff.md)
- [Peer tools](peer.md)
- [Project orchestration](../guides/project-orchestration.md)
