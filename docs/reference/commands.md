# `/agents` commands

[Documentation index](../README.md)

`/agents` is the human-facing agent-management command namespace.

`/herdsman` is a discovery alias for `/agents`. It accepts the same arguments
and runs the same command behavior; help and usage text continue to use
`/agents` as the canonical name.

It is separate from the structured model-facing Agent tools.

Agent-management commands require a lead Pi session with UI. Outside Herdr,
plain `/agents` and its `/herdsman` alias remain available as a setup
diagnostic that includes the running Pi Herdsman package version.

## Usage

```text
/agents
/agents stats
/agents definitions
/agents placement [tab|subtree|split]
/agents stop
```

The plain command opens a native Pi selection menu titled with the running
Pi Herdsman package version for both `/agents` and `/herdsman`, with `Running`,
`Session stats`, `Definitions`, `Layout`, `Context retirement  on|off`, `Message limits`, and
`Stop all…` destinations. The
Message limits view edits the user-wide inline attachment and mailbox payload
limits. It is available only to a lead Pi session with UI. Current
values and presets show a rough token equivalent using four UTF-8 bytes per
token. The enforced limits are bytes, not tokens.

## `/agents stats`

Shows accumulated provider-reported token usage and cost for the current Pi
session plus transitively owned managed-Agent Pi sessions whose exact persisted
identity can be verified. Usage follows Pi's session accounting across the whole
session history, including assistant responses, model-attributed usage entries,
tool-result model usage, compaction, and branch summaries.
Input includes cached and uncached tokens, with cache writes shown within
uncached input. The combined Models section attributes assistant responses to
their response model, usage entries to their recorded model, and tool and
summary usage to `Tools/summaries`, sorted by cost.

Repeated continuations of the same Pi session are counted once. Peer Leads,
supervised Leads, and unrelated Pi sessions are excluded. Unavailable or
identity-mismatched owned sessions are skipped and the totals marked incomplete.

## `/agents definitions`

Opens the native Definitions menu for the effective bundled, project, and
global roster. Project definitions are included when Pi considers the project
trusted. Project participation is marked `[project]`; a global override adds
`*` (so `[project] *` means both layers contribute). Edits write global
overrides only.

The details view can show:

- name and description;
- configured or inherited model and thinking;
- declared tool policy represented by definition metadata (not a complete
  runtime capability probe);
- named skills;
- declared direct delegation;
- overridden/custom state;
- override/custom source path when relevant.

Bundled implementation paths are intentionally hidden from the human overview.

Structured `agent_list` keeps exact deterministic metadata, including exact
source and skill paths when available.

`/agents definitions` does not probe runtime tool availability.

Selecting a definition opens:

```text
Model
Thinking
Enabled
Details…
```

Model selection refreshes Pi's registry and stores the canonical provider/model
token. `Inherit current session` removes the selected field. Unset model and
thinking rows display `inherit · <current session value>` when the current
value is available. Thinking uses Pi's supported levels when the selected
model is known.

When Pi provides an explicit scoped-model list, that scope is used. Otherwise
available models are offered.

Thinking options use the effective model's supported levels when resolvable,
or Pi Herdsman's validated vocabulary when not.

The command edits only the selected top-level `model`, `thinking`, or `enabled`
line in the global Markdown override. It preserves unrelated frontmatter and
the complete body.

Details re-resolves the selected definition when opened, so it reflects current
overlays and body references even if the menu remained open while configuration
changed.

Changes apply to future assignments, not already-running agents or the lead Pi
session. Fresh `delegate` assignments inherit the spawning controller's
current settings when fields are unset; `continue` restores the saved
session's settings.

Standalone global definitions are editable too. Removing a model or thinking
field selects `Inherit current session`; removing any other field inherits its
lower-precedence value.

## `/agents` Running

Select a live managed agent from the shared status projection to focus its pane.
Pi Herdsman refreshes and verifies the exact label, pane, and session identity
before issuing herdr's focus command. If the agent changed, no focus command
is sent.

## `/agents placement`

Selecting Layout opens a native selector showing the effective setting.
When unset, the effective setting is `subtree`.
Explicit values continue to set directly:

```text
/agents placement tab
/agents placement subtree
/agents placement split
```

See [Configuration](configuration.md).

## `/agents stop`

Destructive lead-only emergency control.

It aborts the current lead turn and attempts to close the exactly proven owned
agent tree.

It reports discarded active work or durable pending results when present.

Cleanup uses existing exact ownership proofs and proceeds conservatively across
independent failures.

Use ordinary `agent_close` for normal targeted model-driven control.

## Project Manager and Chief

Every session starts as a Lead. A Lead in the primary workspace of a Herdr
worktree group can use `/manager` to claim the exclusive Manager lease for
its Herdsman project scope and enter the Manager profile. Leads in
linked-worktree workspaces cannot enter Manager mode. If another live Manager
holds the lease, activation fails and the
caller remains an ordinary Lead. Manager activation also refuses while the
session owns unresolved Agent work. A restored Manager uses the same profile,
supervision UI, and context as explicit activation, without the Lead Agent
roster or Lead-owned Agent recovery. `/manager leave` preserves project work
and is refused only when a Lead is waiting for this Manager's answer or the
Manager's own ask to Chief remains pending; otherwise it
relinquishes the lease and restores the exact Lead tool baseline, including
`agent`, and Lead instruction profile. Invoking `/manager` while already active
opens the overview without changing the role or lease. See
[Supervision](supervision.md) for the role and project boundaries.
The Manager overview lists branch-based work, including paused work whose Lead
is no longer running. It offers resume, close, and discard actions as applicable;
discard removes the assignment but keeps the Git branch and worktree.

An eligible ordinary Lead can activate runtime Chief mode with `/chief`.
While Chief, `/chief` opens the overview and `/chief leave` exits the mode.
A Manager cannot activate Chief. Chief's staff roster contains active
Managers, and may contain ordinary Leads in worktree groups without an active
Manager; a Manager's roster contains Leads from its worktree group.

## See also

- [`/chief` and chief mode](supervision.md)
- [Agent tools](agent.md)
- [Configuration](configuration.md)
- [Status widget](status-widget.md)
