# Status widget

[Documentation index](../README.md)

The TUI status widget is a local, display-only projection of exact managed
agents plus controller-local transient starting assignments.

It does not replace mailbox assignment/result authority.

An active Chief receives a separate supervision widget for its current direct
reports (Managers and ordinary Leads without an active project Manager). It
shows both categories together when both exist, not managed Agent rows. An
active Manager receives bounded direct-Lead supervision state rather than the
ordinary Lead Agent widget. Chief's complete overview, peek, and focus behavior
is documented in the [supervision reference](supervision.md). Supervision and
Agent widgets are never combined.

The ambient supervision rows use `├─` for non-final visible reports and `└─` for the
final visible report. Selection, attention, and lifecycle remain separate: `>`
means selected, `!` means `needs_you`, `●` means working, `◐` means blocked,
`◌` means settling or starting, `○` means idle or done, `?` means unknown, and
`×` means lost. An idle or done lead with active delegated descendants uses
`◉`. Workspace labels are presentation text inside each lead row, not
additional hierarchy nodes. The widget always retains
attention reports, caps ordinary reports, and shows omitted reports in a final
`└─ … N more · /chief` row.

## Installation

The widget is installed only when the current session has a valid supported
herdr/Pi identity and Pi is in TUI mode.

A lead Pi session gets its exact owned subtree view.

A valid managed leaf can receive an identity-only header.

A delegation-enabled agent can receive its direct-agent counts and rows.

Unmanaged or invalid agent environments do not receive the managed widget.

## Refresh

The widget refreshes managed herdr data plus mailbox state every two seconds.

Refresh performs a bounded herdr pane-list lookup to validate the lead
boundary. It does not add a socket transport or another agent-control protocol.

A refresh failure never mutates mailbox/control eligibility.

## Breadcrumb

Example:

```text
● herd → implementer → scout
```

The breadcrumb uses validated definition/agent ancestry.

Delegating-agent and leaf panes append their current Pi active tool names as
muted bracketed metadata after the current identity, preserving Pi's exact
order. Lead Pi sessions do not show this metadata. It is local to the current
pane, is never copied to agent rows or authoritative agent state, and is
truncated or omitted before breadcrumb identity is shortened when width is
limited.

If an ancestor cannot be proved, it is shown explicitly as `?` rather than
guessed:

```text
● ? → scout
```

## Header counts

Example:

```text
● herd  2 working · 1 blocked · 1 settling
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

Working rows use `● working`, blocked rows use `◐ blocked`, settling rows use
`◌ settling`, starting rows use `◌ starting`, unknown rows use `? unknown`, and
lost rows use `× lost` with the theme's attention/error styling. Working,
settling, and starting animate; blocked, unknown, and lost rows are static.
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

The current widget does **not** claim to display the full effective tool list.
That remains separate from the definition overview.

## Agent inactivity

A `working` agent can expose an advisory inactivity marker based on durable
Pi-observed activity.

This is distinct from header `stale`, which means the widget failed to refresh
its latest snapshot.

Neither changes agent control state.

## See also

- [Agent states](agent-states.md)
- [`/agents definitions`](commands.md#agents-definitions)
- [Recovery](../guides/recovery.md)
