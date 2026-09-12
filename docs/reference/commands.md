# `/agents` commands

[Documentation index](../README.md)

`/agents` is the human-facing agent-management command namespace.

It is separate from the structured model-facing `agent` API.

Agent-management commands require a lead Pi session with UI. Outside Herdr,
plain `/agents` remains available as a setup diagnostic.

## Usage

```text
/agents
/agents definitions
/agents placement [tab|subtree|split]
/agents stop
```

The plain command opens a native Pi selection menu with `Running`,
`Definitions`, `Layout`, `Message limits`, and `Stop all…` destinations. The
Message limits view edits the user-wide inline attachment and mailbox payload
limits. It is available only to a lead Pi session with UI. Current
values and presets show a rough token equivalent using four UTF-8 bytes per
token. The enforced limits are bytes, not tokens.

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

Structured `agent list` keeps exact deterministic metadata, including exact
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

Use ordinary `agent close` for normal targeted model-driven control.

## See also

- [`/chief` and chief mode](supervision.md)
- [`agent` API](agent.md)
- [Configuration](configuration.md)
- [Status widget](status-widget.md)
