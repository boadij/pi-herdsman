# Status widget

[Documentation index](../README.md)

The TUI status widget is a local, display-only projection of exact managed
agents plus controller-local transient starting assignments.

It does not replace mailbox assignment/result authority.

An active Chief receives a separate supervision widget for its current direct
reports (Managers and ordinary Leads without an active project Manager). It
shows both categories together when both exist, not managed Agent rows. An
active Manager receives a work-centric branch projection rather than the
ordinary Lead Agent widget. Chief's complete overview, peek, and focus behavior
is documented in the [command reference](commands.md#project-manager-and-chief). Supervision and
Agent widgets are never combined.

The Chief supervision tree uses `├─` for non-final visible reports and `└─` for the
final visible report. A Manager's observational assigned and ordinary
supervised Leads appear as second-level children; these children do not become
Chief control targets.
Chief direct reports and their nested Manager work follow this shape:

```text
Chief direct report
├─ Manager
│  ├─ observational Lead/project work
│  └─ observational Lead/project work
└─ direct Lead
```

Selection and lifecycle remain separate: `>` means
selected, `●` means working, `◐` means blocked,
`◌` means settling or starting, `○` means idle or done, `?` means unknown, and
`×` means lost. An idle or done lead with active delegated descendants uses
`◉` in accent styling. Lifecycle labels use success for working, accent for
starting and settling, warning for blocked and unknown, error for lost, and
muted for idle and done. The leading `●` in a widget header is a
success-colored identity marker for the status surface, not proof of active
execution. Workspace labels are presentation text inside each lead row, not
additional hierarchy nodes. For example, a Manager with one Lead child appears
as:

```text
● chief · 1 manager
└─ ○ pi-herdsman · 1 compatible lead
   └─ worktree/silver-stone-21b7 · done
```

The widget caps ordinary reports and shows omitted reports in a final
`└─ … N more · /chief` or `└─ … N more · /manager` row, according to the active role.

Chief's header shows only nonzero categories (`manager`, `direct lead`), or
`no reports`. Manager's header shows the project name and lists managed
branches as work, including work without live Leads:

Chief also counts independently identified incompatible staff in the header
and renders them as warning rows with `!` and `build mismatch`. These rows are
observation-only: they have no focus target and do not grant staff actions.
They disappear after a successful fresh observation confirms build
convergence. Ambiguous or conflicting identity/build evidence is not shown as
a confidently identified mismatch.

```text
● manager · pi-herdsman
├─ ● feat/example · active
└─ ○ fix/other · paused
```

When available, managed work rows can append the Lead's active herd-run elapsed
time and Pi's current context percentage:

```text
● manager · pi-herdsman
├─ ● feat/foo · active  14m  61%
└─ ○ fix/other · paused
```

Elapsed time is the same active herd-run interval shown by the ordinary Lead
widget; context is Pi's current context percentage. Both are best-effort
presentation metadata and unavailable values are omitted. Under width pressure,
elapsed is dropped before context. Manager work status remains distinct from
the live Lead's runtime state. Chief rows receive matching theme styling but do
not show these telemetry columns. A stale Manager snapshot suppresses elapsed
telemetry while retaining other available metadata such as context percentage.

Manager work status is `active`, `paused`, or `conflict`.
An active row uses the live Lead's lifecycle marker when an executor is present;
without a verified Lead it uses a muted `·`, not a claim of verified execution.
Paused uses `○`; conflict uses warning-colored `!`. A blocked Lead uses its
warning-colored `◐` lifecycle marker without an additional `!`. Independently
verified build incompatibility is shown with `!` and `build mismatch`. For
compatible work, the row suffix is project status, not the Lead's runtime
state.
Ordinary Leads supervised by the Manager are shown separately from project
work, with a supervised label; they are not treated as managed work. A Manager
can inspect an eligible direct report through the overview, independently of
mouse focus/navigation. Branches are display handles; exact session identity is
revalidated for control actions.

## Installation

The widget is installed only when the current session has a valid supported
herdr/Pi identity and Pi is in TUI mode.

A root Lead, Manager, or Chief session gets its exact owned subtree view when
the ordinary Agent projection is applicable. Manager/Chief ownership rows, if
shown, are only for Agents directly owned by that exact session; staff
supervision never adds a Lead's Agent tree.

A valid managed leaf can receive an identity-only header.

A delegation-enabled agent can receive its direct-agent counts and rows.

Unmanaged or invalid agent environments do not receive the managed widget.

## Refresh

Ordinary status refreshes on explicit requests and controller or Herdr
invalidations, with a 10-second reconciliation while its TUI widget is active.
Herdr events invalidate the view; presentation-only events refresh status but
do not trigger health scans.

Full Chief/Manager supervision observation is event- and local-invalidation-
driven, with a 10-second reconciliation while active TUI supervision is
enabled. The Manager elapsed-time widget redraws every two seconds for
presentation, without acquiring a new authoritative snapshot.

## Navigation

In Pi's fullscreen TUI, click a visible Agent or supervision-tree row to focus
its current live pane. Click a visible ancestor segment in an Agent breadcrumb
to focus that exact Lead or Agent; the current identity segment is not a
navigation target. On a managed Lead, click `managed` to focus the Manager
currently assigned to the exact project. These mouse actions are unavailable
in regular terminal/scrollback mode, which retains normal terminal selection
and the existing keyboard/menu alternatives such as the Running menu and
`/chief` or `/manager` overview.

Navigation does not grant coordination authority. Agent targets are checked
against the caller's durable ownership ancestry; Manager targets for project
control require the Lead's current exact project assignment. Direct-report
inspection and messaging use their own fresh supervision authorization;
focus/navigation alone grants neither. Chief-visible nested Leads remain
observational. A visible truncated Manager project-work branch can focus its
exact verified Lead only for a fresh, active row with a compatible Lead; only
the rendered branch segment is clickable, not its status suffix. Paused or
conflicted project work, incompatible Leads, lost or unresolved sessions,
stale projections, wholly hidden labels, omitted entries, and targets without
a uniquely verified live Herdr pane are inert. Current placement is checked
again when a click is handled; the status projection itself is never
authorization.

Headless mode has no UI-only periodic supervision observation. Explicit and
model-context refreshes still acquire fresh state. A refresh failure never
mutates mailbox/control eligibility.

## Lead execution

An ordinary Lead's header may include its verified effective execution mode:
`· flexible` or `· orchestrate`. Dedicated Managed Lead sessions show
`managed`, `managed · unavailable`, or `managed · retired` according to current
verified authority, retaining their identity when assignment evidence is missing.
For example:

```text
● lead · managed
```

The execution label is presentation only, not authority. Ordinary modes are
shown only for initialized ordinary sessions with a valid selected profile.
Managed uncertainty is displayed as unavailable, never as an ordinary mode. The label appears separately from Agent ownership ancestry; a Lead with
descendants retains an ownership breadcrumb such as `lead → implementer` and
renders execution as contextual metadata, never as an added breadcrumb segment.
The complete label is omitted when it cannot fit rather than being partially
truncated. A manually continued exact assigned session remains marked managed;
the `managed-lead` launch definition is not used to derive the marker.

Example:

```text
● lead → implementer → scout
```

The breadcrumb uses validated definition/agent ancestry. Its root uses the
verified current owner role (for example, `lead`, `manager`, or `chief`); when
role evidence is unavailable, it uses a neutral owner/controller label rather
than guessing.

Delegating-agent and leaf panes can append a compact summary of their current
Pi active tools as muted bracketed metadata after the current identity.
Ordinary tool names retain Pi's order. Multiple Agent ownership coordination
tools are collapsed into one Agent-tools display token. This is presentation
only: `ownTools` and Pi's active-tool state remain exact.

When width is limited, complete metadata items are omitted before breadcrumb
identity is shortened; tool names are not rendered as partial fragments.
Operational header state has priority over tool metadata. Lead Pi sessions do
not show this metadata.

If an ancestor cannot be proved, it is shown explicitly as `?` rather than
guessed:

```text
● ? → scout
```

## Header counts

Example:

```text
● lead  2 working · 1 blocked · 1 settling
```

The header reports exact non-zero lifecycle states in the order `working`,
`blocked`, `settling`, `starting`, `unknown`, and `lost`. `starting` is a
presentation-only count for controller-local assignments that have begun
startup but have not yet become active or terminal. It is not mailbox state,
control authority, or Running inventory.

Before the first successful refresh, the header says `unavailable`.

After a later refresh failure, the widget retains the last valid snapshot and
marks the header `stale`.

Header refresh staleness is not agent inactivity.
Stale and unavailable labels use warning styling. Freshness is prioritized
over counts and optional metadata: when width permits, the identity is
shortened to retain the freshness label. At extremely narrow widths, the label
may itself be truncated. Identity-only Agent headers retain freshness without
Agent counts. Stale Agent herd-run and row elapsed values use the snapshot's
observation time (`refreshedAt`), and are omitted when `refreshedAt` is absent.
Agent inactivity metadata remains independently reported.

## Agent rows

Every visible agent is rendered in a stable tree. Siblings are sorted by
logical label and use Pi's `├─`, `└─`, and `│` connectors.
The row shows the agent definition and its exact logical agent label
separately. The tree contains only agents in the controller's proven ownership
projection; unrooted, ambiguous, or cyclic durable ancestry is not attributed to
the herd.

Rows share globally aligned columns for state, elapsed time, compact model,
thinking, context percentage, and optional inactivity. Context is shown as a
percentage without a `ctx` prefix. Responsive layouts drop the task first,
then elapsed time, then context percentage; the same column choice is used for
every row. The task is the rightmost elastic field and is kept only when it has
useful room before it is truncated.

Lifecycle labels and static activity glyphs use the canonical markers and
semantic theme colors described above. The fixed-width Agent activity column
animates only working and starting rows, and only for a fresh, available
snapshot; settling is static, as are blocked, unknown, lost, and every row in a
stale or unavailable snapshot. A stale snapshot continues to show its last
observed lifecycle state, but elapsed values do not advance past that
observation.
While a controller-local start remains pending, an authoritative `settling`
row is presented as `starting` so launch and request handoff remain visually
continuous. `working`, `blocked`, and `unknown` authoritative states are never
overridden. A starting row is removed when its exact request becomes active or
terminal, its local runtime is removed, startup fails or rolls back, the
controller session restarts, or shutdown clears transient state.

The normal widget retains owned `lost` and fail-closed `unknown` rows because
they represent durable unresolved generations whose physical state is either
proven gone or not safely provable. `Running` inspection excludes `lost` and
fail-closed `unknown` rows because they are not safely focusable targets; it
otherwise shows authoritative live agent rows and excludes presentation-only
starting rows. A terminal result is followed by cleanup; the widget does not
retain an idle completed agent.

## Optional metadata

Rows can include best-effort:

- task;
- elapsed time;
- compact model;
- thinking;
- context percentage;
- agent type/display metadata.

These fields are not control authority.

The renderer preserves identity/state information before truncating task text
and bounds every output line by visible Unicode width.

The widget is a compact projection of active-tool state, not an authoritative
or exhaustive tool inventory.

## Agent inactivity

A `working` agent can expose an advisory inactivity marker based on durable
Pi-observed activity.

This is distinct from header `stale`, which means the widget failed to refresh
its latest snapshot.

Neither changes agent control state.

## See also

- [Agent states](agent-states.md)
- [`/herdsman definitions`](commands.md#herdsman-definitions)
- [Recovery](../guides/recovery.md)
