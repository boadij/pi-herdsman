# Commands

[Documentation index](../README.md)

`/herdsman` is the canonical human discovery and control command. `/agents` is
an alias retained for users familiar with the previous entry point; it accepts
the same arguments and runs the same behavior.

It is separate from the structured model-facing Agent tools.

Management menus require a lead Pi session with UI. Outside Herdr, both
commands remain available as setup diagnostics that include the running Pi
Herdsman package version.

## Usage

```text
/herdsman
/herdsman stats
/herdsman definitions
/herdsman placement [tab|subtree|split]
/herdsman stop
/manager
/manager leave
/chief
/chief leave
/takeover
```

For the Herdsman commands above, replacing `/herdsman` with `/agents` is
equivalent. The `/manager`, `/chief`, and `/takeover` commands are unchanged.

`/herdsman` opens the native Pi menu titled with the running Pi Herdsman package
version. Its six destinations are `Agents`, `Project manager`, `Session stats`,
`Definitions`, `Settings`, and `Advanced…`. Active role state is secondary row
metadata; the TUI updates contextual help for the selected row.

Selecting `Agents` opens the focused `Running`, `Layout`, and `Stop all…` menu.
Its running count and current layout are secondary metadata. The root does not
depend on Agent status or definitions to render.

`Settings` contains `Manager auto-start`, `Context retirement`, and `Message
limits`. The Message limits view edits the user-wide inline attachment and
mailbox payload limits. It is available only to a lead Pi session with UI.
Current values and presets show a rough token equivalent using four UTF-8
bytes per token. The enforced limits are bytes, not tokens.

## `/herdsman stats`

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
retiring an assignment removes it from current Manager stats. When exact
persisted Lead session-file evidence is available, Manager stats open only those
assigned sessions and their durable Agent trees. Missing, conflicting, or
identity-mismatched in-scope evidence marks coverage incomplete rather than
triggering global Pi session discovery. Durable Agent ownership determines each
Lead's Agent tree. Manager aggregation uses the scope-specific warning
`Coverage incomplete: some managed project session usage is unavailable.`
Ordinary usage retains its owned-session warning.

## `/herdsman definitions`

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

Structured `list_agents` keeps exact deterministic metadata, including exact
source and skill paths when available.

`/herdsman definitions` does not probe runtime tool availability.

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

## `/herdsman` → Agents → Running

Select a live managed agent from the shared status projection to focus its pane.
Pi Herdsman refreshes and verifies the exact label, pane, and session identity
before issuing herdr's focus command. If the agent changed, no focus command
is sent.

## `/herdsman placement`

Selecting Layout opens a native selector showing the effective setting.
When unset, the effective setting is `subtree`.
Explicit values continue to set directly:

```text
/herdsman placement tab
/herdsman placement subtree
/herdsman placement split
```

See [Configuration](configuration.md).

## `/herdsman stop`

Destructive lead-only emergency control. The same operation is available as
`/agents stop` through the alias.

It aborts the current lead turn and attempts to close the exactly proven owned
agent tree.

It reports discarded active work or durable pending results when present.

Cleanup uses existing exact ownership proofs and proceeds conservatively across
independent failures.

Use ordinary `close_agent` for normal targeted model-driven control.

`Project manager` offers `Start Manager mode` when inactive, or `Overview` and
`Leave Manager mode` while active. `Advanced…` opens `Chief mode`, which offers
the corresponding Chief start, overview, and leave actions. These menu actions
use the same transitions as `/manager` and `/chief`; they do not add role
eligibility or authority rules.

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

The `Manager auto-start` setting optionally makes a new session attempt
that same Manager startup when it has no persisted role intent and starts in the
project's primary workspace. Explicit persisted Lead, Manager, or Chief intent
takes precedence. Ineligible or contended optional startup remains an ordinary
Lead; successful automatic startup does not persist Manager intent. Changing
the setting affects only a later `session_start`, not the running role.
The Manager overview lists branch-based work, including paused work whose Lead
is no longer running. It offers resume for paused work and focus or stop for a
live assigned Lead. Manager staff reports contain only live exact Leads named
by current project assignments; physical worktree scope alone grants no
authority. Project assignments survive Manager replacement and manual
continuation of the exact assigned Pi session. `managed-lead` is launch policy,
not authority. Successful Herdr worktree removal retires an assignment; a
missing worktree alone leaves it recoverable with `resume_project`.

An eligible ordinary Lead can activate runtime Chief mode with `/chief`.
While Chief, `/chief` opens the overview and `/chief leave` exits the mode.
A Manager cannot activate Chief. Chief's staff roster contains active
Managers and ordinary unassigned Leads, including those in a project scope
with an active Manager. A Manager's roster contains only live exact Leads named
by its current project assignments.

## `/takeover`

Available in Lead mode with an interactive UI. On an assigned managed Lead,
prompts for confirmation before removing that exact session's project
assignment and any pending project messages. A successful takeover ends Manager
control and automatic project-result
forwarding while preserving the Pi session, conversation, branch, worktree,
running process, and Lead-owned Agents. Takeover does not imply project
completion, and it does not restart Pi or change the current launch
configuration. On an unassigned Lead it
reports that the Lead is not managed. In Manager or Chief mode it reports
`Takeover is available only in Lead mode.` Without an interactive confirmation UI it
reports `Takeover requires an interactive UI.` Cancellation leaves state
unchanged.

Successful Herdr worktree removal and explicit `/takeover` are distinct
assignment-release paths. Settlement, review, or user interaction does not
release Manager authority.

## See also

- [Coordination](../concepts/coordination.md)
- [Staff tools](staff.md)
- [Supervisor tools](supervisor.md)
- [Agent tools](agent.md)
- [Configuration](configuration.md)
- [Status widget](status-widget.md)
