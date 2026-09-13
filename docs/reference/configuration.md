# Configuration

[Documentation index](../README.md)

Pi Herdsman keeps its configuration in one flat, user-wide file:

```text
<Pi agent directory>/pi-herdsman/config.json
```

The default location is `~/.pi/agent/pi-herdsman/config.json`. Pi's native
`getAgentDir()` determines the agent directory, so setting
`PI_CODING_AGENT_DIR` relocates the file to
`$PI_CODING_AGENT_DIR/pi-herdsman/config.json`.

Project trust and project settings do not affect Herdsman configuration.
Agent definitions remain a separate feature and continue to use the bundled,
project-local, and user agent-definition locations described in the
[agent-definition guide](../guides/agent-definitions.md).

## Schema and defaults

The file contains only explicitly configured overrides. The accepted flat
schema is:

```json
{
  "spawnPlacement": "subtree",
  "contextRetirement": true,
  "inlineAttachmentLimitBytes": 131072,
  "mailboxPayloadLimitBytes": 131072
}
```

An absent file means these defaults:

| Field                        |            Default | Allowed values                                    |
| ---------------------------- | -----------------: | ------------------------------------------------- |
| `spawnPlacement`             |          `subtree` | `tab`, `subtree`, `split`                         |
| `contextRetirement`          |               true | boolean                                           |
| `inlineAttachmentLimitBytes` | `131072` (128 KiB) | integer from 1024 (1 KiB) through 1048576 (1 MiB) |
| `mailboxPayloadLimitBytes`   | `131072` (128 KiB) | integer from 1024 (1 KiB) through 1048576 (1 MiB) |

Malformed JSON, a non-object root, unknown fields, and invalid known values
are errors. Reads do not create the directory or file. Configuration changes
through `/agents` update this single file atomically.

`inlineAttachmentLimitBytes` applies per file. Eligible complete strict UTF-8
files are embedded only when the exact serialized mailbox record fits; other
files remain canonical references. `mailboxPayloadLimitBytes` limits the exact
serialized request, ask, or chief message record. Chief messages also retain
their fixed 8 KiB protocol ceiling.

When `contextRetirement` is enabled, automatic context pressure retires a
managed-agent session after its first deferred threshold compaction. The
session receives a finalization instruction, and its result requires a fresh
agent for follow-up. Disabling it bypasses retirement completely, including
existing retirement markers, and leaves Pi's native compaction and session
reuse behavior untouched.

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
