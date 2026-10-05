# Coordination API

[Documentation index](README.md) · [Getting started](getting-started.md)

Pi Herdsman exposes small, role-specific model-facing interfaces. This page is
the router to their exact contracts, not a second copy of them.

## Owned Agent work

A Lead or delegation-enabled Agent controls only its owned Agent boundary.

Use [Agent tools](reference/agent.md) for:

```text
agent_list
agent_delegate
agent_continue
agent_steer
agent_interrupt
agent_reply
agent_close
agent_inspect
agent_transcript
```

Managed Agents contact their exact direct owner through
[`ask_owner`](reference/ask-owner.md).

The lifecycle and execution-ownership rules are documented in
[Lifecycle](concepts/lifecycle.md) and [Delegation](concepts/delegation.md).

## Direct reports and project work

Chief and Manager use [Staff tools](reference/staff.md) for direct-report
observation and communication.

Manager additionally uses branch-based staff operations to start and resume
project work, and can stop a Lead without retiring its assignment.

```text
staff_list
staff_inspect
staff_transcript
staff_message

Manager only:
staff_delegate
staff_resume
staff_stop
```

## Direct supervisor

Ordinary Leads and Managers communicate upward through
[Supervisor tools](reference/supervisor.md).

```text
supervisor_message
```

Assigned Lead messages are pending Manager delivery and are nonterminal; once
delivered, they become Pi conversation history rather than pending Herdsman
coordination. `staff_stop` pauses execution without removing the assignment.
Successful Herdr worktree removal retires the matching project assignment and
any still-pending messages. A missing worktree alone does not retire an
assignment;
`staff_resume` can reconstruct the checkout when its branch remains available.

An assigned project Lead saves messages with its project assignment for the
Manager role while Manager is absent; they remain pending until a Manager can
receive them and are not replayed after delivery. An unassigned Lead routes to
its active Manager
when one exists, otherwise to Chief. A Manager routes to Chief.

## Same-role peers

Ordinary Leads and active Managers can discover and message live peers of the
same role through [Peer tools](reference/peer.md):

```text
peer_list
peer_message
```

Peer communication does not change ownership or supervision authority.

## Human UI

Slash commands and TUI surfaces are separate from the model-facing contracts:

- [Commands](reference/commands.md)
- [Status widget](reference/status-widget.md)
- [Getting started](getting-started.md)

For the relationship between Chief, Manager, Lead, Agent, project work, and
Herdr worktree scope, read [Coordination](concepts/coordination.md).
