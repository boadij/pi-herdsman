# Commands

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
/manager
/manager leave
/chief
/chief leave
```

The plain command opens a native Pi selection menu titled with the running
Pi Herdsman package version for both `/agents` and `/herdsman`. Its five
destinations are `Running`, `Session stats`, `Definitions`, `Settings`, and
`Stop all…`. Selection values such as counts and current settings are secondary
metadata; the TUI updates contextual help for the selected row.

`Settings` contains `Manager auto-start`, `Layout`, `Context retirement`, and
`Message limits`. The Message limits view edits the user-wide inline attachment
and mailbox payload limits. It is available only to a lead Pi session with UI.
Current values and presets show a rough token equivalent using four UTF-8
bytes per token. The enforced limits are bytes, not tokens.

## `/agents stats`

Shows accumulated Pi-native token usage and cost for the current Pi session plus
transitively owned managed-Agent Pi sessions whose exact persisted identity can
be verified. In an active Manager session, it additionally includes the Lead
sessions named by current durable project assignments and each included Lead's
transitively owned managed-Agent sessions. The Manager's directly owned Agents
remain included.

Usage follows Pi's session accounting across the whole session history,
including assistant responses, model-attributed usage entries, tool-result model
usage, compaction, and branch summaries. Input includes cached and uncached
tokens, with cache writes shown within uncached input.

The Models section attributes assistant responses to their response model,
usage entries to their recorded model, and tool/summary usage to
`Tools/summaries`, sorted by cost.

Repeated references to the same Pi session are counted once. Project assignment
identity selects managed Leads; live Herdr topology is not required, and
retiring an assignment removes it from current Manager stats. Pi's native global
session inventory may locate an exact assigned Lead ID, but discovery never
establishes ownership. Durable Agent ownership determines each Lead's Agent
tree. Missing, ambiguous, or identity-mismatched in-scope usage is omitted and
marks coverage incomplete rather than guessed. Manager aggregation uses the
scope-specific warning `Coverage incomplete: some managed project session
usage is unavailable.` Ordinary usage retains its owned-session warning.

## `/agents definitions`

Opens a flat native Definitions list of effective definitions, with reserved
`managed-lead` first. Project definitions are included when Pi considers the
project trusted. Each definition shows its contributing source or sources as
`bundled`, `project`, and/or `global`. Edits write global overrides only.

The reserved managed Lead is not an Agent and remains excluded from Agent
discovery and delegation. It supports `Model`, `Thinking`, and `Details`, but
has no `Enabled` action. Global override edits affect future Lead launches,
not Leads already running.

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

Selecting an ordinary Agent definition opens:

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

Selecting the managed Lead opens the same Model, Thinking, and Details actions,
without `Enabled`.

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

By default, a session starts as a Lead. A Lead in an ordinary Git primary Herdr
workspace can use `/manager` to claim the exclusive Manager lease for its
Herdsman project scope and enter the Manager profile. No prior chat turn or
existing linked worktree is required; the first project delegation can create
the first linked worktree. Leads in linked-worktree workspaces cannot enter
Manager mode. If another live Manager
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
[Coordination](../concepts/coordination.md) for the role and project boundaries.

The `/agents` Manager auto-start setting optionally makes a new session attempt
that same Manager startup when it has no persisted role intent and starts in the
project's primary workspace. Explicit persisted Lead, Manager, or Chief intent
takes precedence. Ineligible or contended optional startup remains an ordinary
Lead; successful automatic startup does not persist Manager intent. Changing
the setting affects only a later `session_start`, not the running role.
The Manager overview lists branch-based work, including paused work whose Lead
is no longer running. It offers resume for paused work and focus or stop for a
live Lead. Project retirement follows successful Herdr worktree removal; a
missing worktree alone leaves the assignment recoverable with `staff_resume`.

An eligible ordinary Lead can activate runtime Chief mode with `/chief`.
While Chief, `/chief` opens the overview and `/chief leave` exits the mode.
A Manager cannot activate Chief. Chief's staff roster contains active
Managers, and may contain ordinary Leads in worktree groups without an active
Manager; a Manager's roster contains Leads from its worktree group.

## See also

- [Coordination](../concepts/coordination.md)
- [Staff tools](staff.md)
- [Supervisor tools](supervisor.md)
- [Agent tools](agent.md)
- [Configuration](configuration.md)
- [Status widget](status-widget.md)
