# Configuration

[Documentation index](../README.md)

Pi Herdsman keeps its defaults and general configuration in one flat,
user-wide file:

```text
<Pi agent directory>/pi-herdsman/config.json
```

The default location is `~/.pi/agent/pi-herdsman/config.json`. Pi's native
`getAgentDir()` determines the agent directory, so setting
`PI_CODING_AGENT_DIR` relocates the file to
`$PI_CODING_AGENT_DIR/pi-herdsman/config.json`.

Two preferences can be overridden for a trusted project in Pi's
`<project>/.pi/settings.json`:

```json
{
  "piHerdsman": {
    "autoActivateManager": true,
    "contextRetirement": false
  }
}
```

Only `autoActivateManager` and `contextRetirement` are project-overridable.
Built-in defaults are overlaid by the global configuration, then by explicitly
set project values. An omitted project property inherits the global value;
explicit `false` overrides global `true`. Project overrides apply only when Pi
considers the current project trusted. An untrusted project or an absent
project override inherits the global value; malformed trusted project settings
raise a configuration error instead of falling back. The rest of
`.pi/settings.json` remains Pi-owned. Agent definitions are separate and
continue to use the bundled, project-local, and user agent-definition
locations described in the
[agent-definition guide](../guides/agent-definitions.md).

## Schema and defaults

The file contains only explicitly configured overrides. The accepted flat
schema is:

```json
{
  "defaultLeadExecution": "flexible",
  "spawnPlacement": "subtree",
  "contextRetirement": true,
  "autoActivateManager": false,
  "inlineAttachmentLimitBytes": 131072,
  "mailboxPayloadLimitBytes": 131072
}
```

An absent file means these defaults:

| Field                        |            Default | Allowed values                                    |
| ---------------------------- | -----------------: | ------------------------------------------------- |
| `defaultLeadExecution`       |         `flexible` | `flexible`, `orchestrate`                         |
| `spawnPlacement`             |          `subtree` | `tab`, `subtree`, `split`                         |
| `contextRetirement`          |               true | boolean                                           |
| `autoActivateManager`        |              false | boolean                                           |
| `inlineAttachmentLimitBytes` | `131072` (128 KiB) | integer from 1024 (1 KiB) through 1048576 (1 MiB) |
| `mailboxPayloadLimitBytes`   | `131072` (128 KiB) | integer from 1024 (1 KiB) through 1048576 (1 MiB) |

Malformed JSON, a non-object root, unknown fields, and invalid known values
are errors. Reads do not create the directory or file. Herdsman's human
configuration controls update this single file atomically.

`defaultLeadExecution` selects the initial profile only for a future ordinary
Lead session that has no persisted execution choice. Its values select
`flexible-lead` or `orchestrator-lead`; it does not change a running session,
and an existing session choice takes precedence. Manager-created assigned Leads
use `managed-lead` instead.

`inlineAttachmentLimitBytes` applies per file. In ordinary coordination
messages, supported complete strict UTF-8 text is delivered only when both
this per-file limit and the complete logical-message budget fit; unsupported
or non-fitting attachments reject the handoff instead of remaining as
references. `mailboxPayloadLimitBytes` also limits new managed-Agent request
and ask payloads and new Manager project assignments. Chief, staff, supervisor,
peer, and project coordination messages use this configured logical-message
limit. Their compact physical inbox records remain bounded at 8 KiB; larger
accepted message bodies are stored separately and verified before Pi delivery.

When the effective `contextRetirement` preference is enabled, automatic
context pressure retires a managed-agent session. Herdsman suppresses
preventive threshold compaction while the assignment finalizes and leaves Pi's
overflow recovery available. The session receives a finalization instruction,
and its result requires a fresh agent for follow-up. Disabling the preference
bypasses retirement, including enforcement of existing retirement markers,
and leaves Pi's native compaction and session reuse behavior untouched. The
preference is evaluated at retirement and continuation checks, so a trusted
project setting can change how an existing marker is enforced. The policy is
applied in the applicable project context; a caller's project override cannot
bypass a retired marker for an Agent from another project when that target
project's applicable opt-out cannot be verified. In that case, continue from
the original trusted project context or create a fresh Agent.

When the effective `autoActivateManager` preference is enabled, a session
without a persisted `pi-herdsman-role` entry attempts Manager startup only from
its Herdr primary workspace. Linked workspaces, unavailable eligibility
evidence, or an existing Manager leave it as an ordinary Lead. The preference
does not persist Manager role intent and changing it does not affect the current
session.

The Settings menu edits global defaults and, in the `Project overrides…` submenu,
trusted-project values for these two preferences. Choose `Inherit global`, `On
for this project`, or `Off for this project`; inheritance removes the stored
project property. Global controls remain independent, and an explicit project
value takes precedence over the global value. Untrusted projects cannot be read
or edited through this menu. Changes follow the existing preference evaluation
lifecycle and do not retroactively change an already-running role or operation.
Updates to an existing project settings file coordinate with Pi's settings
lock. With Pi 1.3.0, concurrent independent writers can still race when
creating a missing `.pi/settings.json`, because Pi reads the missing file before
acquiring that lock.

Placement affects future starts, not existing agents. `tab` uses one lead-owned
agents tab, `subtree` gives each lead-direct agent its own tab, and `split`
splits from the caller's pane. Nested delegation always splits in its owner's
current tab.

## Reset

Stop active Pi and Herdsman processes first; running processes may recreate
runtime state. Then delete the complete Herdsman directory at this canonical
location:

```text
<resolved Pi agent directory>/pi-herdsman/
```

`<resolved Pi agent directory>` means the result of Pi's native
`getAgentDir()`. With a custom `PI_CODING_AGENT_DIR`, Pi resolves that value
(including values such as `~`) before appending `pi-herdsman`; do not construct
the path by concatenating the raw environment variable yourself. Use the
native file-management operation for the current platform to delete that
directory.

The next process starts with the defaults and recreates only the runtime state
it needs.

## See also

- [`/agents` commands](commands.md)
- [Getting started](../getting-started.md)
