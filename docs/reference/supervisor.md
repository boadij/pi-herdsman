# Supervisor tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

`message_supervisor` is the coordination operation for ordinary Leads and
Managers. A managed project Lead contacts its assigned Manager; an ordinary
Lead and a Manager contact Chief. Managed Agents use `ask_owner` to contact
their exact owner.

An ordinary Lead without a verified Chief continues independently. A managed
Lead's assigned Manager remains its authority even when no Manager process is
active. Messages are nonblocking coordination and do not alter project
assignment state.

Direct-supervisor delivery validates the current authority. Ambiguous or
incomplete authority fails closed instead of silently routing around an
intermediate Manager. A managed Lead's message validates its current project
assignment.

## `message_supervisor`

Available to Leads and Managers.

```json
{
  "message": "The API contract has a compatibility risk that needs Manager attention.",
  "files": ["result:reviewer#1"]
}
```

`message_supervisor` is asynchronous and nonblocking. Use it for material
information the direct supervisor needs before the normal result boundary,
such as a timely question, clarification, blocker, warning, scope conflict,
risk, decision request, or important evidence. Continue working as appropriate;
the Lead may also choose to wait for a response through ordinary
`message_staff`. Routine information that can wait should be included in the
automatic completed-result handoff.
Do not message solely to duplicate an automatic result, but do not deduplicate
separate messages by content.

An ordinary Lead without a verified Chief should continue independently until
a supervisor is available. Manually continuing the exact assigned Pi session
does not release management; `managed-lead` is launch policy, not authority.

Messages are bounded. `files` accepts ordinary
paths, reusable direct Agent refs, and canonical result refs already supplied
as evidence; attachments are prepared at submission and the durable message
carries prepared text plus any hidden semantic-result bindings needed for the
recipient to forward them.

## Delivery

Direct-supervisor messages are queued for the exact current recipient and
validated against current authority before delivery.

## See also

- [Staff tools](staff.md)
- [Peer tools](peer.md)
- [Project orchestration](../guides/project-orchestration.md)
