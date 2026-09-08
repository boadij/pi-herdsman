# Configuration

[Documentation index](../README.md)

Pi Herdsman intentionally has very little settings state.

Agent behavior lives in Markdown definitions. The extension settings currently
own agent placement.

## Agent placement

Settings shape:

```json
{
  "piHerdsman": {
    "spawnPlacement": "tab"
  }
}
```

Supported values:

```text
tab
split
```

Default:

```text
tab
```

`tab` places future agents in the managed agent-tab workflow.

`split` places future agents by splitting from the caller's tab/pane placement
boundary.

This affects future starts, not existing agents.

## Message limits

Pi Herdsman uses two independent byte settings:

```json
{
  "piHerdsman": {
    "inlineAttachmentLimitBytes": 131072,
    "mailboxPayloadLimitBytes": 131072
  }
}
```

Each accepts an integer from 1024 bytes (1 KiB) through 1048576 bytes (1 MiB)
and defaults to 131072 bytes (128 KiB). The inline limit applies per file;
eligible complete strict UTF-8 files are embedded in caller order only when
the exact serialized mailbox record fits. Other files remain canonical
references. The mailbox limit is the exact serialized `RequestRecord`,
`AskRecord`, or text-only chief supervision record admission size. Chief
supervision also has an existing fixed 8 KiB record ceiling, so its effective
admission limit is the smaller of the configured mailbox limit and 8 KiB.

Only valid global values affect runtime behavior. Invalid global values are
ignored rather than clamped, and project-local values for these two keys are
inert. Configure the global values through `/agents` → `Message limits`; the
fixed 1 MiB protocol safety ceiling remains in force for reading existing
mailbox records.

## Settings scope

Pi Herdsman reads Pi settings through Pi's settings manager.

Global settings are stored in the Pi agent directory's `settings.json`
(default `~/.pi/agent/settings.json`).

Project settings are stored in:

```text
<project>/.pi/settings.json
```

A project placement value is effective only when:

- the project is trusted by Pi; and
- the project setting is `tab` or `split`.

If no valid trusted project placement is active, the global value is used.

`/agents placement` opens a native selector showing the effective value and
offering `tab` or `split`. Selecting a value writes to the current effective
scope and verifies the value after writing; the confirmation reports whether
that scope is `project` or `global`.

## Agent definitions are not extension settings

Do not put per-agent model, thinking, tool, skill, extension, body, or
delegation policy in `piHerdsman`.

Those belong in Markdown agent definitions.

Trusted project-local definitions can be enabled with this project-only
discovery gate in `<cwd>/.pi/settings.json`:

```json
{ "piHerdsman": { "projectAgents": true } }
```

The default is disabled, and a global `projectAgents` value has no effect.
This setting enables discovery only; agent models, tools, bodies, extensions,
and delegation remain in Markdown definitions.

See:

- [Agent definitions](../guides/agent-definitions.md)
- [Agent-definition schema](agent-definition-schema.md)

## herdr integration

The required Pi integration is installed separately:

```sh
herdr integration install pi
herdr integration status
```

Pi Herdsman requires integration version `2` or newer for supported native session
identity/restore behavior.

## See also

- [`/agents` commands](commands.md)
- [Getting started](../getting-started.md)
