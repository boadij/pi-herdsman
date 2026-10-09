# Coordination API

[Documentation index](README.md) · [Getting started](getting-started.md)

Pi Herdsman exposes small, role-specific model-facing interfaces. This page is
the router to their exact contracts, not a second copy of them.

## Owned Agent work

A Lead or delegation-enabled Agent controls only its owned Agent boundary.

Use [Agent tools](reference/agent.md) for:

```text
list_agents
delegate_agent
continue_agent
steer_agent
interrupt_agent
reply_agent
close_agent
inspect_agent
read_agent_transcript
```

Managed Agents contact their exact direct owner through
[`ask_owner`](reference/ask-owner.md).

The lifecycle and execution-ownership rules are documented in
[Lifecycle](concepts/lifecycle.md) and [Delegation](concepts/delegation.md).

## Direct reports and project work

Chief and Manager use [Staff tools](reference/staff.md) for direct-report
observation and communication.

Manager additionally uses branch-based project operations to start and resume
project work, and can stop a Lead without retiring its assignment.

```text
list_staff
inspect_staff
read_staff_transcript
message_staff

Manager only:
delegate_project
resume_project
stop_lead
```

## Direct supervisor

Ordinary Leads and Managers communicate upward through
[Supervisor tools](reference/supervisor.md).

```text
message_supervisor
```

Managed Leads use nonblocking `message_supervisor` for timely questions,
clarifications, or warnings needed before the automatic completed-result
handoff. A Lead may choose to wait for a response through `message_staff`.
Routine information that can wait belongs in the result; there is no
message/result deduplication. `stop_lead` pauses execution without removing the
assignment, and `resume_project` resumes it.
Successful Herdr worktree removal retires the matching project assignment and
any still-pending project messages. The assigned Lead can also explicitly
release Manager control with confirmed `/takeover`, which removes the
assignment and pending project messages while preserving its session, branch,
worktree, process, and owned Agents. Verified Git worktree inventory showing
the checkout absent also retires the assignment. Failed or ambiguous inventory
preserves it. A retired assignment cannot be resumed, but new work may reuse
its remaining branch.

An assigned project Lead uses `message_supervisor` for timely Manager
coordination; an ordinary Lead and a Manager use it to contact Chief. An
unassigned Lead routes only to Chief when verified, never to a same-scope
Manager.

## Same-role peers

Ordinary Leads and active Managers can discover and message live peers of the
same role through [Peer tools](reference/peer.md):

```text
list_peers
message_peer
```

Peer communication does not change ownership or supervision authority.

## Human UI

Slash commands and TUI surfaces are separate from the model-facing contracts:

- [Commands](reference/commands.md)
- [Status widget](reference/status-widget.md)
- [Getting started](getting-started.md)

For the relationship between Chief, Manager, Lead, Agent, project work, and
Herdr worktree scope, read [Coordination](concepts/coordination.md).
