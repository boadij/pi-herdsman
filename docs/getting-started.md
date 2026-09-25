# Getting started

[Documentation index](README.md) · [Agent coordination API](agent-api.md) · [Pi Herdsman](concepts/supervision.md)

This is the shortest human-facing path from installation to useful Pi Herdsman
orchestration. You do not need to type structured `agent` requests for this
path.

## 1. Install

You need:

- [herdr](https://github.com/herdrdev/herdr) `>=0.9.1`;
- Pi `>=0.87.0 <0.88.0` (supported);
- Node `>=22.19.0`.

Install the package and herdr Pi integration:

```sh
pi install npm:pi-herdsman
herdr integration install pi
```

For an SSH-ready Docker deployment instead, see the
[container deployment guide](guides/container-deployment.md).

## 2. Start Herdr and Pi

Start Herdr in your project:

```sh
herdr
```

Then run Pi in the Herdr pane:

```sh
pi
```

Pi reads the package manifest and loads the extension plus the optional `agents`
skill. A lead Pi session started outside Herdr cannot safely manage Herdr agents.

The extension distinguishes a lead Pi session, valid managed agents, and
unmanaged or invalid environments. Only supported managed environments receive
Pi Herdsman controls and status UI.

## 3. Delegate work without leaving the conversation

Ask Pi normally:

```text
Use scout to inspect this repository.
```

Pi Herdsman starts the work asynchronously. Once the assignment is accepted, the
lead Pi session remains the session you interact with instead of waiting for the
agent to finish.

While agents work, you can continue discussing or planning with the
lead Pi session, delegate other independent work, inspect active work, or focus a
managed agent pane.

You do not need to poll for completion. Results and agent questions are
delivered back to the owning controller when they need attention.
The exact semantics are owned by [Lifecycle](concepts/lifecycle.md).

Pi Herdsman is opinionated about coordination, not workflow. Use the agent roles,
tools, extensions, and process that fit your project; the lead agent handles the
structured coordination API internally.

## 4. Open the agents menu

In the lead Pi TUI, run:

```text
/agents
```

The native menu contains:

```text
Running
Definitions
Layout
Stop all…
```

`Running` is the complete authoritative live-agent inventory and focuses the
selected pane directly. `Definitions` manages the effective bundled, project,
and global agent definitions. Trusted projects contribute definitions from
`.pi/agents/`; effective precedence is bundled < project < global. `Layout`
controls whether newly started agents use tabs or splits. `Stop all…` is
destructive emergency control.

See [`/agents` commands](reference/commands.md) for exact behavior.

## 5. Configure definitions and layout

Open `Definitions` to inspect the effective bundled, project, and global roster
and edit the selected definition's model, thinking level, or enabled state.
The `[project]` marker identifies project participation and `*` identifies a
global override. Definition Details shows the effective metadata and can
expand the resolved definition instructions with Pi's native `Ctrl+O`
behavior. These edits always write global overrides, never project files.

Use `Layout` to choose the current placement for newly started lead-direct
agents: `subtree` is the default and gives each lead-direct agent one tab;
`tab` uses one lead-owned agents tab; `split` stays in the caller's tab. Nested
delegation always splits inside the owner's current tab. Placement changes
affect future starts only.

For complete configuration ownership, see:

- [Agent definitions](guides/agent-definitions.md)
- [Customizing bundled agents](guides/customizing-agents.md)
- [Agent-definition schema](reference/agent-definition-schema.md)
- [Configuration](reference/configuration.md)

## 6. Watch and focus work

The status widget shows active managed work and transient `starting` activity.
Agents exist for one assignment only. After a terminal result is delivered,
Pi Herdsman cleans up the agent; the exact Pi session remains available for
continuation. The `Running` menu shows the complete authoritative inventory of
live or unresolved lifecycle work.

Managed agent panes show their validated breadcrumb identity. Their own active
Pi tool names can appear as compact bracketed metadata on that breadcrumb.

See [Status widget](reference/status-widget.md) for exact state, refresh, and
rendering behavior.

To continue a completed assignment with its existing conversational context,
use the exact `session_id` returned with its result in a new `continue` request.
This starts a new agent generation with the saved session and current effective
definition configuration.

## 7. Recover only when needed

Normal coordination and targeted cleanup belong to the agent API. Use
`Stop all…` only when you deliberately want lead-level emergency cleanup of the
proven owned agent tree.

For failure diagnosis and conservative cleanup, see [Recovery](guides/recovery.md).

## 8. Supervise project Leads and Managers

Every session starts as a Lead. In the primary workspace of a Herdr worktree
group, use `/manager` to explicitly claim the exclusive Manager lease for its
Herdsman project scope; `/manager leave` returns to Lead. Leads in
linked-worktree workspaces cannot enter Manager mode. Manager is a dedicated
project coordinator with a distinct coordination profile and only
`staff`, `supervisor`, and `peer` among Herdsman tools. It does not own Agents
or implement work through them; delegated implementation belongs to Leads and
their Agent trees. Worktree Leads are the execution boundary for project work
delegated by Manager. See the
[supervision reference](reference/supervision.md) for project eligibility,
direct-report tools, durable assignments, and results.

In an eligible Lead session, use `/chief` to supervise Managers across the
current Herdr runtime. When a Herdsman project scope has no active Manager,
Chief may supervise its ordinary Leads directly; when a Manager is active,
Leads in that worktree group report to the Manager, not Chief. Chief can
observe bounded descendant Lead summaries but cannot act on those Leads. A Manager cannot
activate Chief mode. From Chief, `/chief` opens the overview; `/chief leave`
returns to ordinary Lead mode.

## Next steps

- Keep delegating naturally through the lead Pi session.
- Use [`/agents` commands](reference/commands.md) when you need human control.
- Configure [agent definitions](guides/agent-definitions.md).
- Read [Agent coordination API](agent-api.md) only when you need the model and
  agent-facing contracts.
