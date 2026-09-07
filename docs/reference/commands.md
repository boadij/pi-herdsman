# `/workers` commands

[Documentation index](../README.md)

`/workers` is the human-facing worker-management command namespace.

It is separate from the structured model-facing `worker` API.

Commands require a lead Pi session with UI.

## Usage

```text
/workers
/workers agents
/workers placement [tab|split]
/workers stop
```

The plain command opens a native Pi selection menu with `Running`,
`Definitions`, `Layout`, `Message limits`, and `Stop all…` destinations. The
Message limits view edits the independent global inline attachment and mailbox
payload limits. It is available only to a lead Pi session with UI. Current
values and presets show a rough token equivalent using four UTF-8 bytes per
token. The enforced limits are bytes, not tokens.

## `/workers agents`

Opens the native Definitions menu for the effective bundled, project, and
global roster. Project definitions are included only when the trusted project
setting `piHerdsman.projectAgents` is `true`. Project participation is marked
`[project]`; a global override adds `*` (so `[project] *` means both layers
contribute). Edits write global overrides only.

The details view can show:

- name and description;
- configured model and thinking;
- declared tool policy represented by definition metadata (not a complete
  runtime capability probe);
- named skills;
- declared direct delegation;
- overridden/custom state;
- override/custom source path when relevant.

Bundled implementation paths are intentionally hidden from the human overview.

Structured `worker list` keeps exact deterministic metadata, including exact
source and skill paths when available.

`/workers agents` does not probe runtime tool availability.

Selecting a definition opens:

```text
Model
Thinking
Enabled
Details…
Back
```

Model selection refreshes Pi's registry and stores the canonical provider/model
token. `Use default` removes the selected field. Thinking uses Pi's supported
levels when the selected model is known.

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

Changes apply to future definition delegations and session continuations, not
already-running workers or the lead Pi session.

Standalone global definitions are editable too. Removing a field from one uses
Pi's normal default; removing a field from a bundled override restores the
bundled value.

## `/workers` Running

Select a live managed agent from the shared status projection to focus its pane.
Pi Herdsman refreshes and verifies the exact label, pane, and session identity
before issuing herdr's focus command. If the worker changed, no focus command
is sent.

## `/workers placement`

Selecting Layout opens a native selector showing the effective setting.
Explicit values continue to set directly:

```text
/workers placement tab
/workers placement split
```

See [Configuration](configuration.md).

## `/workers stop`

Destructive lead-only emergency control.

It aborts the current lead turn and attempts to close the exactly proven owned
worker tree.

It reports discarded active work or durable pending results when present.

Cleanup uses existing exact ownership proofs and proceeds conservatively across
independent failures.

Use ordinary `worker close` for normal targeted model-driven control.

## See also

- [`/chief` and chief mode](supervision.md)
- [`worker` API](worker.md)
- [Configuration](configuration.md)
- [Status widget](status-widget.md)
