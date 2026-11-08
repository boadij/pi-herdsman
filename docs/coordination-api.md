# Coordination API

[Documentation index](README.md) · [Getting started](getting-started.md)

Pi Herdsman exposes small, role-specific model-facing interfaces. This page is
the router to their exact contracts, not a second copy of them.

## Code-mode tool access

Pi tools declared with `direct` exposure can be called by the model and through
Pi's supported native nested-tool execution when active. The coordination tools
supporting native programmatic invocation are `list_agents`, `steer_agent`,
`interrupt_agent`, `reply_agent`, `stop_agent`, `inspect_agent`,
`read_agent_transcript`, `read_evidence`, `list_staff`, `inspect_staff`,
`read_staff_transcript`, `message_staff`, `delegate_work`, `resume_work`,
`stop_lead`, `remove_worktree`, `integrate_branch`, `message_supervisor`,
`list_peers`, `message_peer`, and `attach_handoff`. `delegate_agent` and
`continue_agent` remain `model-only` and do not support native programmatic
invocation. `ask_owner` also remains `model-only` because it must be a direct,
exclusive tool call in its turn. See
[`ask_owner`](reference/ask-owner.md) for its contract.

Tool access still depends on the active role, ownership, extension loading, and
runtime authorization. This documents Pi's native contract; behavior through
third-party code-mode integrations and their approval or foreground settings
depends on that integration and is not guaranteed here. In environments where
`ask_owner` and Fabric are both registered, Fabric may configure it as a
foreground tool, for example:

```json
{
  "foreground": {
    "tools": [
      {
        "name": "ask_owner",
        "owner": "pi-herdsman",
        "reason": "turn-steering"
      }
    ]
  }
}
```

Users preferring model-facing tools may choose Fabric's `fullCodeMode: false`
setting where supported; verify its behavior against the installed Fabric
version.

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
stop_agent
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
project work, can use `stop_lead` to stop a Lead while preserving its project
assignment, and can request
independent human confirmation to remove an assigned project's worktree.
`resume_work` requires a fresh instruction for the existing assignment; it
queues that instruction separately without replacing the saved task. Already
running Leads are not relaunched. Use `message_staff` for ordinary
communication with known running Leads; queue acceptance is not proof of
message delivery.

```text
list_staff
inspect_staff
read_staff_transcript
message_staff

Manager only:
delegate_work
resume_work
stop_lead
remove_worktree
integrate_branch
```

## Direct supervisor

Ordinary Leads and Managers communicate upward through
[Supervisor tools](reference/supervisor.md).

```text
message_supervisor
```

Managed Leads use nonblocking `message_supervisor` for timely questions,
clarifications, or warnings needed before the automatic completed-result
handoff. Continue independently safe work while a reply is pending. Defer only
steps that genuinely require the response; when no actionable work remains,
end the turn and rely on normal message delivery rather than polling.
Routine information that can wait belongs in the result; there is no
message/result deduplication. `stop_lead` pauses execution without removing the
assignment, and `resume_work` resumes it.
Successful Herdr worktree removal retires the matching project assignment and
any still-pending project messages. Verified Git worktree inventory showing
checkout absence also retires the assignment. Failed or ambiguous inventory
preserves it. A retired assignment cannot be resumed, but new work may reuse
its remaining branch.

An assigned project Lead uses `message_supervisor` for timely Manager
coordination; an ordinary Lead in a verified project worktree group routes to
its active Manager, otherwise to Chief when verified. A Manager uses the tool
to contact Chief. An assigned Lead never falls back to Chief.

## Same-role peers

Leads and active Managers can discover and message eligible peers of the
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
