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

Manager additionally uses branch-based staff operations to start, resume, pause,
complete, or abandon project work.

```text
staff_list
staff_inspect
staff_transcript
staff_message

Manager only:
staff_delegate
staff_stop
staff_complete
staff_discard
```

## Direct supervisor

Ordinary Leads and Managers communicate upward through
[Supervisor tools](reference/supervisor.md).

```text
supervisor_message
```

Assigned Lead messages are retained with their project assignment and are
nonterminal. Manager resolves project work with `staff_complete` or
`staff_discard`; `staff_stop` pauses execution without removing the assignment.

An assigned project Lead saves messages with its project assignment for the
current or a replacement Manager, even when no Manager is active; it does not
route those messages to Chief. An unassigned Lead routes to its active Manager
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
