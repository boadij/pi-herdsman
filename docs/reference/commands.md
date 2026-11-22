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
/manager refresh
/manager leave
/manager remove [<branch>]
/manager removal-confirmation [required|skip]
/manager forget <branch>
/chief
/chief refresh
/chief leave
```

For the Herdsman commands above, replacing `/herdsman` with `/agents` is
equivalent. The role commands are separate from these aliases.

`/herdsman` opens the native Pi menu titled with the running Pi Herdsman package
version. Ordinary Leads see six destinations: `Lead mode`, `Agents & definitions`,
`Project management`, `Chief coordination`, `Settings`, and `Usage & costs`.
Managed Leads, Managers, and Chiefs see the same menu without `Lead mode` (five
destinations). Active role state is secondary row metadata; the TUI updates
contextual help for the selected row.

In the TUI, every Herdsman selection menu supports fuzzy filtering. Type to
narrow the current menu by label, visible setting value, or additional search
terms (including provider/model names). Use Up/Down to navigate, Enter to select,
and Escape to return. Clearing the query restores the full list. Filtering is
local to the open menu, not a search across nested settings. Outside the TUI,
Herdsman retains Pi's native selection prompt.

`Lead mode` shows the current ordinary Lead mode (`flexible` or `orchestrate`).
Selecting it opens the same selector as `/lead`. For a dedicated Managed Lead,
`/lead` instead shows `managed`, `managed · unavailable`, or `managed · retired`
according to verified assignment evidence, and offers no ordinary mode choices.

`/lead` directly opens the Lead mode selector. `/lead flexible` and `/lead orchestrate`
select that mode directly; repeating the current mode explicitly refreshes its
effective definition. Ordinary mode changes are persisted for the current
session. Managed Leads reject `/lead flexible` and `/lead orchestrate`, and
cannot activate Manager or Chief, including after retirement. Use native Pi
`/fork` or `/clone` for a new ordinary session with copied history, not a
separate Git checkout or fresh process configuration. In Manager or Chief mode, `/lead` changes the
underlying ordinary Lead preference without replacing the active role tools.

Selecting `Agents & definitions` opens `Running agents`, `Agent definitions`,
`Coordinator profiles`, and `Stop all agents…`. The root does not depend on
Agent status or definitions to render.

### Settings menu

| Category                 | Setting                                      |
| ------------------------ | -------------------------------------------- |
| `Sessions & agents`      | `Default Lead mode`                          |
| `Sessions & agents`      | `Finish Agents near context limit`           |
| `Sessions & agents`      | `Message and file limits`                    |
| `Manager & repositories` | `Start Manager automatically`                |
| `Manager & repositories` | `Confirm Git initialization`                 |
| `Manager & repositories` | `Merge accepted branches`                    |
| `Manager & repositories` | `Confirm worktree removal`                   |
| `Interface`              | `Agent terminal layout`                      |
| `Interface`              | `Status widget lines`                        |
| `Delegation options`     | `Agent nesting limit`                        |
| `Delegation options`     | `Delegate Agents to other directories (cwd)` |
| `Delegation options`     | `Agent model overrides`                      |
| `Delegation options`     | `Allowed override models`                    |
| `Communication`          | `Peer communication`                         |
| `Communication`          | `Peer federation`                            |

[`Delegate Agents to other directories (cwd)`](configuration.md#schema-and-defaults)
is a global Off/On setting. It allows Leads to specify a different working
directory using the optional `cwd` parameter in `delegate_agent`. Without it,
Agents start in the Lead's current directory. Changes apply to subsequent
delegations and model turns without `/reload`. Cross-directory delegation is
limited to ordinary Leads. See
[`Peer communication` and `Peer federation`](configuration.md#peer-communication)
in the Configuration reference.

[`Agent model overrides`](configuration.md#agent-model-overrides) is a global
Off/On setting for fresh delegation. It defaults to Off and does not require
`/reload`. Use `Allowed override models` to prepare a custom selection even
while overrides are Off. The picker shows the selected count and whether it
uses Pi scoped models or a custom selection. Unavailable configured models
are shown so they can be removed.

| Input      | Action                                                  |
| ---------- | ------------------------------------------------------- |
| Type       | Filter by provider, ID, or name                         |
| Arrow keys | Move the highlight                                      |
| Enter      | Toggle the highlighted model                            |
| Ctrl+A     | Select all models, or all filtered models               |
| Ctrl+X     | Clear all custom selections, or the filtered selections |
| Ctrl+P     | Toggle all models for the highlighted provider          |
| Ctrl+S     | Save                                                    |
| Esc        | Cancel without changing settings                        |

Saving an empty custom selection restores inheritance from the calling
controller's Pi scoped models. Where the custom picker is unavailable, the
fallback selector lets you toggle models one at a time and then save or cancel.

The default Lead mode applies only when a future ordinary Lead session has no
persisted execution choice; changing it does not change the current session.
`Start Manager automatically` and `Finish Agents near context limit` offer global and trusted-project
choices within each setting. Project inheritance removes the stored property in
`.pi/settings.json`; invalid or untrusted project settings do not prevent global
controls from being used. `Merge accepted branches` offers global and verified
repository choices within the same setting. Repository permissions are stored
in user-level Herdsman authorization, not project settings. They can be managed
without an active Manager when the repository identity is verified; granting
permission requires interactive confirmation.
`Message and file limits` edits the user-wide limits for `Shared file content`
and `Coordination messages`. The Settings row shows exact sizes; detailed
selectors also show rough token equivalents using four UTF-8 bytes per token.
The enforced limits are bytes, not tokens.

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

Opens the native `Agents & Coordinators` category menu with `Agent definitions` and
`Coordinator profiles`. Each category lists effective definitions; reserved profiles
appear in their canonical order. Project definitions are included when Pi
considers the project trusted. Each definition shows contributing `bundled`,
`global`, `project`, and/or `private repo` sources. Settings default to the
most specific existing editable source (private repository, project, then
global); bundled-only definitions create a global override. When multiple
sources exist, `Edit scope` lets you choose among them. Project edits affect
the current worktree and may be included in a Git commit; private edits are
shared by trusted linked worktrees in the same clone.

All five reserved Coordinator profiles are not Agents and remain excluded as
delegation targets. Manager/Chief profiles may nevertheless list ordinary
Agent definitions in `agents` to authorize their own direct delegation.
Runtime profiles support `Details` only;
`managed-lead` supports `Model`, `Thinking`, and `Details`, but has no `Enabled`
action. Use `/manager refresh` or `/chief refresh` to validate and apply the
active role's definition. Definition files are not watched while a profile is
active.

The `Details…` action appends a read-only inspection entry to the normal Pi chat
transcript and closes the Definitions menu. The compact entry reports the
inspection context and preview; use Pi's native `Ctrl+O` expansion to reveal
sequential instruction sections rendered with Pi's Markdown component.
Expanded content occupies its natural transcript height and uses ordinary
terminal scrolling. The inspection snapshot, including applicable context
text, is saved with the Pi session but is excluded from model context. The
compact view reports the effective configuration, definition source count,
selected context-file count, execution context, and preview limitation. The
expanded sections follow known prompt-input ordering; source headers identify
instruction files and known runtime contributions. Definition overlays appear
as concise configuration provenance separate from surviving instruction text. `+` and `-` identify added and removed explicit values;
`~` identifies changed values or body operations. Context files follow Pi's
loader order and the Agent's global/project inheritance settings. Configured
skills and extensions are selections, not proof that those resources loaded.
For an active Lead or Manager, the expanded view uses the verified role-contract
producer and current Pi system-prompt options for known context inputs; ordinary
Lead execution profile text is shown separately. Chief uses its forced-prompt
producer, which includes applicable global user instructions and excludes
ordinary project context. Inactive Coordinator profiles are shown prospectively;
current active contracts are not substituted for them. Managed Lead previews place its append-only definition body and shared guidance
before inherited context, followed by the verified runtime role section when
active. Other session-dependent sections are identified as such. The preview
is not an exact provider prompt: role/session runtime inputs and provider-side
transformations may add content.

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
or `enabled` line in the selected Markdown source. Values reflect the chosen
scope and effective result. Runtime profiles have no editable frontmatter
action. Edits preserve unrelated frontmatter and the complete body.

Details re-resolves the selected definition when opened, so it reflects current
overlays and body references even if the menu remained open while configuration
changed.

Model, thinking, and enabled changes apply to future assignments, not
already-running agents or the lead Pi session. Fresh `delegate` assignments inherit the spawning controller's
current settings when fields are unset; `continue` restores the saved
session's settings.

`Remove local override` removes only that source's field, allowing the next
lower-precedence value to become effective. It does not necessarily inherit
the active session's setting.

## `/herdsman` → Agents & definitions → Running agents

Select a live managed agent from the shared status projection to focus its pane.
Pi Herdsman refreshes and verifies the exact label, pane, and session identity
before issuing herdr's focus command. If the agent changed, no focus command
is sent.

## `/herdsman placement`

Selecting `Settings` → `Interface` → `Agent terminal layout` opens a native selector showing the effective setting.
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

Use ordinary `stop_agent` for normal targeted model-driven control.

`Project management` offers `Start Manager mode` when inactive, or `Project
overview`, `Pending removal requests`, `Refresh Manager profile`, and `Leave Manager
mode` while active. `Chief coordination` offers the corresponding Chief actions. These menu actions
use the same commands as `/manager` and `/chief`; they do not add role
eligibility or authority rules.

## Native Pi session names

Ordinary Lead sessions are automatically named **Flexible Lead** or
**Orchestrator Lead** according to the effective profile. Verified active
Managers and Chiefs use **Manager** and **Chief**. Herdsman updates names it
owns after successful profile and role changes, including when restoring
session state or reconciling it after tree navigation.

A name set with Pi's `/name <name>` takes precedence, even when it matches the
automatic name. Herdsman also preserves an explicit clear recorded in Pi's
session history. A native fork or clone does not inherit automatic naming
ownership: any name decision Pi copies into the new history is preserved.
Assigned Leads and managed Agents keep their existing naming conventions.

A native name replaces Pi's first-message preview in the session selector.

## Project Manager and Chief

By default, a session starts as a Lead. A Lead in an ordinary Git primary Herdr
workspace can use `/manager` to claim the exclusive Manager lease for its
Herdsman project scope and enter the Manager profile. No prior chat turn or
existing linked worktree is required; the first project delegation can create
the first linked worktree. Leads in linked-worktree workspaces cannot enter
Manager mode. If another live Manager
holds the lease, activation fails and the
caller remains an ordinary Lead. When an eligible `/manager` activation is
requested in a non-Git workspace, `/manager` and **Start Manager mode** ask for
confirmation naming the exact directory by default. The global Settings option
**Confirm Git initialization** requires confirmation by default; choosing to skip it requires
confirmation and skips
only this prompt for explicit starts. Either way, initialization creates a local
Git repository and one empty initial commit; existing files remain uncommitted
and absent from new worktrees until separately committed. Automatic startup and
restoration never bootstrap Git.
Declining or a failed initialization does not activate Manager. Role activation
does not abandon the session's directly owned Agent work.

A restored Manager uses the same profile,
supervision UI, context, and applicable ownership/recovery access as explicit
activation. `/manager leave` preserves project work
and is refused only when a Lead is waiting for this Manager's answer or the
Manager's own ask to Chief remains pending; otherwise it
relinquishes the lease and restores the exact Lead tool baseline, including
`agent`, and Lead instruction profile. Invoking `/manager` while already active
opens the overview without refreshing the profile or waiting for the current
turn to become idle. `/manager refresh` revalidates and applies the active
Manager definition after the current turn becomes idle; a failed refresh keeps
the previous profile. Refresh requires active Manager mode.
Manager definitions accept trusted project and global overlays; omitted fields
inherit from lower-precedence definitions. See the
[Agent-definition schema](agent-definition-schema.md#reserved-coordinator-definitions)
for the current ordinary-tool defaults and override behavior.

Leaving Manager restores the session's ordinary Lead tool baseline and selected
execution profile. Their `agents` allowlist independently controls fresh direct delegation. See
[Coordination](../concepts/coordination.md) for the role and project boundaries.

The effective `Start Manager automatically` setting optionally makes a new session
attempt that same Manager startup when it has no persisted role intent and
starts in the project's primary workspace. A trusted project value can
override the global default. Explicit persisted Lead, Manager, or Chief intent
takes precedence. Ineligible or contended optional startup remains an ordinary
Lead; successful automatic startup does not persist Manager intent. Changing
the setting affects only a later `session_start`, not the running role.
Automatic startup and Manager restoration do not initialize Git or ask for
confirmation; Git initialization is limited to explicit Manager activation.
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

For a legacy assignment with no usable checkout provenance, the Manager
overview also offers `Forget orphaned assignment…` for paused work. The direct
command is `/manager forget <branch>`. This releases Manager authority only; it
does not remove a worktree, stop a process, or change Agent ownership. The
operation requires fresh Git/Herdr observations, no checkout on the branch, no
known live target execution, and typing `forget <branch>` to acknowledge that
unobserved execution cannot be ruled out. Conflicting identity, unavailable
observations, or changed Manager/assignment identity refuses release. This
action is not authorized by worktree-removal preapproval.

An active Manager can remove an assigned project checkout with:

```text
/manager remove <branch>
```

Use `/manager remove` without a branch to review a pending model-requested
removal. Pressing Enter on the exact bare command opens review without branch
completion; adding a space begins branch completion. Pending review appears in
native Pi status and survives `/reload` of the same session. Approval still
uses the exact typed word `remove` unless the current repository has been
explicitly preauthorized by a human.

An interactive user can inspect or change repository-scoped removal approval with
`/manager removal-confirmation [required|skip]` or `Settings` →
`Manager & repositories` → `Confirm worktree removal`, without activating Manager.
A verified repository identity is required. `skip` requests a native confirmation naming the
verified repository; `required` restores per-removal confirmation immediately.
The bare command reports the effective policy. The opt-in waives only the extra
prompt. `Merge accepted branches` also shows the effective policy and its global or
repository source. Granting increased integration
authority, including through inheritance, or creating a positive repository
override requires confirmation.

This command does not activate Manager mode. Completion suggests `leave`,
`remove`, `forget`, and `removal-confirmation`, with `required` and `skip` after
the latter; assigned branches are suggested after `remove ` and `forget ` (with a
trailing space), not after the exact bare commands. Suggestions are advisory and
are not required. Before removal, the shared operation verifies the exact assignment
and linked checkout, checks that the checkout is clean, and asks for interactive
confirmation. Type `remove` to confirm. Running owned project execution may be
stopped and will not be automatically restarted if a later removal step fails.
Herdr removes the checkout without force; the Git branch and Pi conversation
remain, and the confirmation explains that the assignment is retired only
after authoritative removal is verified. Cancellation makes no changes.

The native multiline confirmation identifies the branch and absolute checkout
path, separates what is removed from what is preserved, and requires the exact
word `remove`. Escape, empty input, or any other response cancels. No operation
lock is held while waiting; authority, target identity, and safety are checked
again under the existing locks after confirmation.

The model-facing `remove_worktree` tool returns immediately with a pending
approval request unless the repository has human preauthorization, in which
case it invokes the same guarded operation without another confirmation.
See [Staff tools](staff.md#remove_worktree) for the result contract.

Local branch integration is exposed to an authorized Manager through the
`integrate_branch` staff tool, not a `/manager` slash command or Manager overview
action. Its separate opt-in is available in Settings and in the verified
Manager's repository permissions (`Inherit / Off / Fast-forward only /
Conflict-free merges`); grants require native confirmation. The authorization is stored in user-wide Herdsman
configuration. See
[Configuration](configuration.md#manager-local-merge) and
[Staff tools](staff.md#integrate_branch).

An eligible ordinary Lead can activate runtime Chief mode with `/chief`.
While Chief, `/chief` opens the overview without refreshing the profile or
waiting for the current turn to become idle. `/chief refresh` revalidates and
applies the active Chief definition after the current turn becomes idle; a
failed refresh keeps the previous profile. Refresh requires active Chief mode.
Chief accepts global definition overrides only and defaults to staff
coordination tools. `/chief leave` exits the mode.
A Manager cannot activate Chief. Chief's staff roster contains active
Managers and ordinary Leads without an active project Manager. Ordinary Leads
in a Manager's verified worktree group appear under that Manager instead. A
Manager's roster contains eligible project-group Leads; exact current
assignments alone grant project execution authority.

In Herdr, Herdsman best-effort names an eligible Lead controller's tab by its
current role: `Lead`, `Managed Lead`, `Manager`, or `Chief`. `Managed Lead`
reflects permanent exact-session identity, not current assignment availability. These labels are presentation
only and do not grant or change role authority. Herdsman updates tabs currently
named with their 1-based workspace position or one of those canonical role
labels; other custom names are preserved. Herdr does not record who set a name,
so after Pi restarts a canonical role label may be reclaimed even if a user set
it. Herdsman cannot restore automatic tab numbering. The last role label may
remain after Pi exits or while no eligible role is available to update it.
Independent Pi controllers sharing a tab have no coordinated naming ownership
and can disagree over its label.

## See also

- [Coordination](../concepts/coordination.md)
- [Staff tools](staff.md)
- [Supervisor tools](supervisor.md)
- [Agent tools](agent.md)
- [Configuration](configuration.md)
- [Status widget](status-widget.md)
