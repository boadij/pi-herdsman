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
  "statusWidgetMaxRows": 8,
  "maxAgentDepth": 2,
  "allowAgentCwdOverride": false,
  "allowAgentModelOverrides": false,
  "allowedAgentModels": [],
  "defaultLeadExecution": "flexible",
  "spawnPlacement": "subtree",
  "contextRetirement": true,
  "autoActivateManager": false,
  "projectsDirectory": "~/Projects",
  "peerCommunicationEnabled": true,
  "peerFederationEnabled": true,
  "managerGitBootstrapWithoutConfirmation": false,
  "inlineAttachmentLimitBytes": 131072,
  "mailboxPayloadLimitBytes": 131072,
  "worktreeRemovalPreapprovedRepos": ["/verified/repository"],
  "managerMergeEnabled": false,
  "managerMergeOverrides": { "/verified/repository": true }
}
```

An absent file means these defaults:

| Field                                    |            Default | Allowed values                                                                |
| ---------------------------------------- | -----------------: | ----------------------------------------------------------------------------- |
| `statusWidgetMaxRows`                    |                `8` | integer from 1 through 100; global-only                                       |
| `maxAgentDepth`                          |                `2` | positive integer; global-only; maximum agent nesting depth                    |
| `allowAgentCwdOverride`                  |              false | boolean; global-only                                                          |
| `allowAgentModelOverrides`               |              false | boolean; global-only                                                          |
| `allowedAgentModels`                     |               `[]` | array of unique, nonempty model IDs; global-only                              |
| `defaultLeadExecution`                   |         `flexible` | `flexible`, `orchestrate`                                                     |
| `spawnPlacement`                         |          `subtree` | `tab`, `subtree`, `split`                                                     |
| `contextRetirement`                      |               true | boolean                                                                       |
| `autoActivateManager`                    |              false | boolean                                                                       |
| `projectsDirectory`                      |       `~/Projects` | safe absolute or home-relative path; global-only                              |
| `peerCommunicationEnabled`               |               true | boolean; global-only                                                          |
| `peerFederationEnabled`                  |               true | boolean; global-only                                                          |
| `managerGitBootstrapWithoutConfirmation` |              false | boolean; global-only, skips confirmation only for explicit Manager start      |
| `inlineAttachmentLimitBytes`             | `131072` (128 KiB) | integer from 1024 (1 KiB) through 1048576 (1 MiB)                             |
| `mailboxPayloadLimitBytes`               | `131072` (128 KiB) | integer from 1024 (1 KiB) through 1048576 (1 MiB)                             |
| `worktreeRemovalPreapprovedRepos`        |               `[]` | exact verified repository identities explicitly opted in by an active Manager |
| `managerMergeEnabled`                    |            `false` | `false`, `true` (fast-forward only), or `"divergent"`                         |
| `managerMergeOverrides`                  |               `{}` | map of verified repository identities to the same three policy values         |

Malformed JSON, a non-object root, unknown fields, and invalid known values
are errors. Reads do not create the directory or file. Herdsman's human
configuration controls update this single file atomically.

`statusWidgetMaxRows` limits the total rendered lines in the ambient status
widget, including its header and any overflow line. In Settings, `Status widget
lines`, `Agent nesting limit`, and both `Message and file limits` selectors
provide presets, `Custom…`, and `Use default`. `Use default` removes the
stored override even when the current value already equals the default.
This global-only display preference does not limit authoritative snapshots or
expanded inspection. See [Status widget](status-widget.md) for layout details.

`maxAgentDepth` bounds agent nesting. Agents are numbered by generation below
the root controller: an agent started by a Lead, Manager, or Chief has depth 1
and its direct agents have depth 2. An agent whose depth equals
`maxAgentDepth` is a leaf, so `1` means agents never delegate, `2` (the
default) allows one delegating level, and `4` allows chains of four agents.
The setting is read from this user-wide file only and cannot be overridden by
project settings, so deeper nesting is always an explicit user-level opt-in. It
is also available under `/herdsman` → `Settings` → `Delegation options` →
`Agent nesting limit`.

The limit is read when `delegate_agent` or `resume_agent` prepares a launch
and checked again immediately before the agent starts; a launch whose limit
changed in between is rejected and can be retried. `PI_HERDSMAN_DEPTH`, which
the launching controller sets in an agent's environment, is only a startup
hint: before an agent delegates, its depth is verified against the durable
ownership records, which must lead from the agent to its verified root
session without a gap or an ambiguous record. A disagreement, a gap, or an
ambiguous chain refuses the launch with an error naming the cause.
The definition roster shown to an agent is advisory (it uses the hint); the
launch check is authoritative.
Running agents keep their capabilities when the limit is lowered
and stay listable, inspectable, stoppable, and recoverable; an agent already at
or beyond the lowered limit is refused further delegation with an error naming
`maxAgentDepth`. Each agent still needs `agents` in its definition to
delegate.

`allowAgentCwdOverride` is a user-wide opt-in for the optional
[`delegate_agent` working-directory override](agent.md#delegate_agent).
Change it under `/herdsman` → `Settings` → `Delegation options` →
`Delegate Agents to other directories (cwd)`. Running sessions reread the
setting before a new model run and at the end of each turn, so changes made in
another session are picked up at the same boundaries without `/reload`.
Disabling the setting rejects launches using an explicit `cwd` even if a model
request still advertised it. Project settings cannot enable it.

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

`projectsDirectory` sets the default local root for repositories the Chief
clones from a remote. It defaults to `~/Projects` and cannot be overridden in
project settings. Use a fully absolute path for the host platform or a path
starting with `~/`. Other relative paths are not resolved against the Chief's
working directory. An explicit `destination` specifies the clone path for that
call instead, without changing the global setting.

`managerGitBootstrapWithoutConfirmation` is a global-only preference, off by
default. When enabled, it skips the confirmation for Git initialization only
when Manager is started explicitly. Automatic startup and session restoration
never initialize Git because of this preference. Existing files remain
uncommitted and absent from new worktrees until separately committed.

The Settings menu places global and trusted-project choices within `Start Manager
automatically` and `Finish Agents near context limit`. Choose `Use global setting`, On, or Off for
the project; inheritance removes the stored project property. An explicit
project value takes precedence over the global value. Untrusted projects cannot
be read or edited through this menu, but global controls remain available.
Changes follow the existing preference evaluation lifecycle and do not
retroactively change an already-running role or operation.

`Settings` → `Manager & repositories` provides `Confirm worktree removal`
and `Merge accepted branches` independently of Manager activation and project
trust, when repository identity is verified. These permissions are stored in
user-level Herdsman configuration, not `.pi/settings.json`. Skipping removal
approval requires native confirmation and waives only the extra per-removal
prompt, never the guarded removal checks. Integration grants, including effective
escalation through inheritance and new positive repository overrides, require
confirmation. Repository identity and relevant state are revalidated before
changes are stored.
Updates to an existing project settings file coordinate with Pi's settings
lock. When `.pi/settings.json` does not exist yet, concurrent independent
writers can still race: Pi checks for the missing file before acquiring the
lock for its creation.

### Agent model overrides

`allowAgentModelOverrides` is a user-wide opt-in for task-specific
[`model` and `thinking` choices on fresh delegation](agent.md#task-scoped-model-and-thinking).
It is off by default. Project settings cannot enable it or change the selection.

When enabled, an empty `allowedAgentModels` list follows the calling
controller's current Pi scoped models. An unrestricted Pi scope permits all
models currently available to that controller. An explicit nonempty list
instead permits only its exact `provider/model` IDs, independent of Pi scope.
Unavailable IDs stay in the list but cannot be selected for delegation. An
empty list means inheritance, not denial of all models.

Manage both settings under [Delegation options](commands.md#settings-menu).
Changes apply to new requests without `/reload` and do not affect running
Agents. Controllers can have different Pi scopes; Herdsman does not synchronize
them.

### Peer communication

In `/herdsman` → Settings → Communication, **Peer communication** controls
horizontal peer messaging, and **Peer federation** controls its cross-machine
subset. Both are on by default, including when their keys are omitted from
the global file. Neither setting can be overridden by a project.

| Peer communication | Peer federation | Effective scope        |
| ------------------ | --------------- | ---------------------- |
| On                 | On              | Local and remote peers |
| On                 | Off             | Local peers only       |
| Off                | On              | No peer communication  |
| Off                | Off             | No peer communication  |

Turning off peer communication leaves the saved federation preference intact;
the menu shows federation as inactive. Running sessions check the current
settings at subsequent peer communication boundaries without `/reload`.
These settings do not change Herdr machine pairing or enablement.
See [Peer reference](peer.md#communication-controls) for how the settings
affect discovery, delivery, and pending messages.

### Manager local merge

Manager local-merge permission is stored only in this user-wide Herdsman
configuration, not in project `.pi/settings.json`, Agent-modifiable project
settings, or Manager definition overlays. It is disabled by default. The
global `managerMergeEnabled` value applies unless the exact verified repository
identity has an entry in `managerMergeOverrides`; `false` denies, `true` allows
fast-forward only, and `"divergent"` also allows clean divergent merges.
Removing an entry restores inheritance from the global value. Existing `true`
values remain fast-forward-only. This policy is separate from
`worktreeRemovalPreapprovedRepos`: enabling local merge does not authorize
general worktree-removal requests.

The permission covers the selected integration mode and the operation's narrowly
scoped guarded cleanup of an integrated source checkout; it does not grant
arbitrary removal authority. Settings provides `Off / Fast-forward only /
Conflict-free merges` globally, and the verified repository setting provides
`Use global setting / Off / Fast-forward only / Conflict-free merges` controls for that
repository. Increasing effective authority or creating a positive repository
override requires native confirmation. The policy is persisted
in user-wide Herdsman configuration, not project settings. `cleanup_pending`
means integration succeeded but checkout removal and/or assignment retirement
is incomplete; with permission still enabled, retrying the same accepted SHA
can retry guarded cleanup. An already-absent checkout is reconciled only when
the accepted SHA is verified on the primary branch and assignment/provenance
checks pass.

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

- [`/herdsman` commands](commands.md)
- [Getting started](../getting-started.md)
