# Getting started

[Documentation index](README.md) · [Agent coordination API](agent-api.md) · [Pi Herdsman](concepts/supervision.md)

This is the shortest human-facing path from installation to useful Pi Herdsman
orchestration. You do not need to type structured `agent` requests for this
path.

## 1. Check requirements

You need:

- [herdr](https://github.com/herdrdev/herdr) `>=0.9.0`;
- Pi `>=0.84.2 <0.86.0` (the version range tested for this release);
- Node `>=22.19.0`.

Install or refresh the herdr Pi integration:

```sh
herdr integration install pi
herdr integration status
```

Install the package from npm:

```sh
pi install npm:pi-herdsman
```

Pi reads the package manifest and loads the extension plus the optional
`agents` skill.

## 2. Start the lead Pi session inside herdr

The lead Pi session must run inside herdr. A lead Pi session started outside herdr
cannot safely manage herdr agents.

The extension distinguishes a lead Pi session, valid managed agents, and
unmanaged or invalid environments. Only supported managed environments receive
Pi Herdsman controls and status UI.

## 3. Delegate work without leaving the conversation

Ask the lead Pi agent in ordinary language, for example:

```text
Use an implementer agent to implement the approved change.
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
use the exact `session_id` returned with its result in a new `delegate.session`
request. This starts a new agent generation with the saved session and current
effective definition configuration.

## 7. Recover only when needed

Normal coordination and targeted cleanup belong to the agent API. Use
`Stop all…` only when you deliberately want lead-level emergency cleanup of the
proven owned agent tree.

For failure diagnosis and conservative cleanup, see [Recovery](guides/recovery.md).

## 8. Optionally supervise leads

When several independent lead sessions run in the same herdr runtime, an
eligible lead can become the chief with:

```text
/chief
```

This is optional and does not change agent ownership. In a UI session, use
`/chief leave` to leave after reviewing its confirmation, which reports
known outstanding supervised lead asks and leaves them pending. Cancellation
does nothing; an unavailable count is reported as unknown. Without a UI, leave
proceeds without interactive confirmation. See the [supervision
reference](reference/supervision.md) before using its model-facing tools.

The `/chief` command is state-sensitive: from an ordinary lead, it
activates chief mode only and shows the ambient widget. When already active
as chief, `/chief` opens the interactive overview instead. Use
`/chief leave` to leave chief mode and remove the widget.
While active, chief mode is supervision-only; leave it to resume ordinary
workspace-local Pi work.

## Next steps

- Keep delegating naturally through the lead Pi session.
- Use [`/agents` commands](reference/commands.md) when you need human control.
- Configure [agent definitions](guides/agent-definitions.md).
- Read [Agent coordination API](agent-api.md) only when you need the model and
  agent-facing contracts.
