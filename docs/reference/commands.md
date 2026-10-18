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
/lead [flexible|orchestrate]
/manager
/manager leave
/manager remove <branch>
/chief
/chief leave
/takeover
```

For the Herdsman commands above, replacing `/herdsman` with `/agents` is
equivalent. The role commands are separate from these aliases.

`/herdsman` opens the native Pi menu titled with the running Pi Herdsman package
version. Its seven destinations are `Execution`, `Agents`, `Project manager`,
`Session stats`, `Definitions`, `Settings`, and `Advanced…`. Active role state is secondary row
metadata; the TUI updates contextual help for the selected row.

`Execution` shows the current ordinary Lead mode (`Flexible` or `Orchestrate`).
Selecting it opens the same selector as `/lead`. A Lead with an exact current
project assignment instead shows `Managed`; its contextual help identifies
`managed-lead` and offers no ordinary mode choices.

`/lead` opens the Execution selector. `/lead flexible` and `/lead orchestrate`
select that mode directly; repeating the current mode explicitly refreshes its
effective definition. Ordinary mode changes are persisted for the current
session. An assigned Lead uses `managed-lead`; `/lead flexible` or
`/lead orchestrate` cannot change that policy, and `/takeover` is the way to
release Manager authority. In Manager or Chief mode, `/lead` changes the
underlying ordinary Lead preference without replacing the active role tools.

Selecting `Agents` opens the focused `Running`, `Layout`, and `Stop all…` menu.
Its running count and current layout are secondary metadata. The root does not
depend on Agent status or definitions to render.

`Settings` contains `Default Lead execution`, `Manager auto-start`, `Context
retirement`, and `Message limits`. The default is `Flexible` and applies only
when a future ordinary Lead session has no persisted execution choice; changing
it does not change the current session. Manager auto-start and context
retirement show their effective values and identify project overrides, when
present. These controls edit the global defaults only; project overrides are
edited in the trusted project's `.pi/settings.json` under `piHerdsman`. The
Message limits view edits the user-wide inline attachment and mailbox payload
limits. It is available only to a lead Pi session with UI.
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
`flexible-lead`, `orchestrator-lead`, `managed-lead`, `manager`, and `chief`
first in that order.
Project definitions are included when Pi considers the
project trusted. Each definition shows its contributing source or sources as
`bundled`, `project`, and/or `global`. Edits write global overrides only.

All five reserved role definitions are not Agents and remain excluded as
delegation targets. Manager/Chief profiles may nevertheless list ordinary
Agent definitions in `agents` to authorize their own direct delegation.
Runtime profiles support `Details` only;
`managed-lead` supports `Model`, `Thinking`, and `Details`, but has no `Enabled`
action. Repeating `/manager` or `/chief` refreshes the active profile after
successful validation. Definition files are not watched while a profile is
active.

The details view shows applicable effective metadata:

- name and description;
- configured or inherited model and thinking for launch definitions;
- declared tool policy and expanded instructions;
- named skills and declared direct delegation when supported by the definition;
- overridden/custom state;
- override/custom source path when relevant.

Bundled implementation paths are intentionally hidden from the human overview.

Structured `list_agents` returns the lean capability roster (name, optional
description, normalized tools/skills summaries, and permitted child names)
alongside live Agent records. It omits definition source paths and raw
configuration. Use the Definitions UI for full configuration details and
source paths; explicitly provisioned skill paths remain in the skills summary.

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

Selecting any runtime profile, including Manager and Chief, opens `Details` only.

When Pi provides an explicit scoped-model list, that scope is used. Otherwise
available models are offered.

Thinking options use the effective model's supported levels when resolvable,
or Pi Herdsman's validated vocabulary when not.

The command edits only the selected supported top-level `model`, `thinking`,
or `enabled` line in the global Markdown override. Runtime profiles have no
editable frontmatter action. Edits preserve unrelated frontmatter and the
complete body.

Details re-resolves the selected definition when opened, so it reflects current
overlays and body references even if the menu remained open while configuration
changed.

Model, thinking, and enabled changes apply to future assignments, not
already-running agents or the lead Pi session. Fresh `delegate` assignments inherit the spawning controller's
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
caller remains an ordinary Lead. Role activation does not abandon the session's
directly owned Agent work. A restored Manager uses the same profile,
supervision UI, context, and applicable ownership/recovery access as explicit
activation. `/manager leave` preserves project work
and is refused only when a Lead is waiting for this Manager's answer or the
Manager's own ask to Chief remains pending; otherwise it
relinquishes the lease and restores the exact Lead tool baseline, including
`agent`, and Lead instruction profile. Invoking `/manager` while already active
re-resolves the Manager definition, applies it after the current turn becomes
idle, then opens the overview; a failed refresh keeps the previous profile.
Manager definitions accept trusted project and global overlays; omitted fields
inherit from lower-precedence definitions, including the bundled empty ordinary
tool allowlist. Manager defaults to coordination-only tools. Custom Manager
definitions can explicitly enable ordinary tools. Leaving Manager restores the
session's ordinary Lead tool baseline and selected execution profile. Their
`agents` allowlist independently controls fresh direct delegation. See
[Coordination](../concepts/coordination.md) for the role and project boundaries.

The effective `Manager auto-start` setting optionally makes a new session
attempt that same Manager startup when it has no persisted role intent and
starts in the project's primary workspace. A trusted project value can
override the global default. Explicit persisted Lead, Manager, or Chief intent
takes precedence. Ineligible or contended optional startup remains an ordinary
Lead; successful automatic startup does not persist Manager intent. Changing
the setting affects only a later `session_start`, not the running role.
The Manager overview lists branch-based work, including paused work whose Lead
is no longer running. It offers resume for paused work and focus or stop for a
live assigned Lead, plus `Remove worktree…` for assigned projects including
paused work. This uses the same explicitly confirmed removal operation as
`/manager remove <branch>`; it preserves the Git branch and Pi conversation.
Running managed execution may be stopped, and assignment retirement is
reported separately from checkout removal. Manager staff reports include
eligible live Leads in its verified worktree group; exact current assignments
grant project execution and lifecycle authority, not direct supervision.
Project assignments survive Manager replacement and manual
continuation of the exact assigned Pi session. `managed-lead` is launch policy,
not authority. Successful Herdr worktree removal or verified checkout absence
retires an assignment; failed or ambiguous inventory preserves it. A retired
assignment cannot be resumed, though new work may use the remaining Git branch.

An active Manager can remove an assigned project checkout with:

```text
/manager remove <branch>
```

This command does not activate Manager mode. It accepts a manually typed branch;
completion suggests `leave` or `remove`, then branches assigned to the active
Manager's repository after `remove`. Suggestions are advisory and are not
required. Before removal, the shared operation verifies the exact assignment
and linked checkout, checks that the checkout is clean, and asks for interactive
confirmation. Type `remove` to confirm. Running owned project execution may be
stopped and will not be automatically restarted if a later removal step fails.
Herdr removes the checkout without force; the Git branch and Pi conversation
remain, and the confirmation explains that the assignment is retired only
after authoritative removal is verified. Cancellation makes no changes.

An eligible ordinary Lead can activate runtime Chief mode with `/chief`.
While Chief, `/chief` refreshes its validated profile after the current turn
becomes idle and then opens the overview; a failed refresh keeps the previous
profile. Chief accepts global definition overrides only and defaults to staff
coordination tools. `/chief leave` exits the mode.
A Manager cannot activate Chief. Chief's staff roster contains active
Managers and ordinary Leads without an active project Manager. Ordinary Leads
in a Manager's verified worktree group appear under that Manager instead. A
Manager's roster contains eligible project-group Leads; exact current
assignments alone grant project execution authority.

In Herdr, Herdsman best-effort names an eligible Lead controller's tab by its
current role: `Lead`, `Managed Lead`, `Manager`, or `Chief`. `Managed Lead`
requires an exact current project assignment. These labels are presentation
only and do not grant or change role authority. Herdsman updates tabs currently
named with their 1-based workspace position or one of those canonical role
labels; other custom names are preserved. Herdr does not record who set a name,
so after Pi restarts a canonical role label may be reclaimed even if a user set
it. Herdsman cannot restore automatic tab numbering. The last role label may
remain after Pi exits or while no eligible role is available to update it.
Independent Pi controllers sharing a tab have no coordinated naming ownership
and can disagree over its label.

## `/takeover`

Available in Lead mode with an interactive UI. On an assigned managed Lead,
prompts for confirmation before removing that exact session's project
assignment and any pending project messages. A successful takeover ends Manager
control and automatic project-result
forwarding while preserving the Pi session, conversation, branch, worktree,
running process, and Lead-owned Agents. The session then uses ordinary
`Orchestrate` execution through `orchestrator-lead`; this changes runtime
instructions and ordinary active-tool projection, not launch-time model,
thinking, extensions, skills, or context. Takeover does not imply project
completion, and it does not restart Pi. On an unassigned Lead it
reports that the Lead is not managed. In Manager or Chief mode it reports
`Takeover is available only in Lead mode.` Without an interactive confirmation UI it
reports `Takeover requires an interactive UI.` Cancellation leaves state
unchanged. The `orchestrator-lead` profile is resolved before releasing the
assignment; if it is invalid, takeover does not remove Manager authority.

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
