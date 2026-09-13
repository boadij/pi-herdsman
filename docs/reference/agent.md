# `agent` API

[Documentation index](../README.md) · [supervision reference](supervision.md)

`agent` is the structured model-facing API for managed agents. It has seven actions:

```text
list
delegate
continue
steer
reply
close
inspect
```

Unknown fields and unsupported selector combinations fail with `invalid_request`.
The tool is registered only for the lead controller and authorized delegating agent
controllers.

## `delegate`

```json
{
  "action": "delegate",
  "definition": "implementer",
  "task": "Implement the approved change"
}
```

Allowed fields are `action`, `definition`, `task`, optional `label`, `cwd`,
`files`, `fork`, and `timeoutMs`. The definition is resolved from
the effective roster and delegating agent controllers may use only their allowlisted
definitions. Project definitions still require trusted project approval.
`fork`, when supplied, is an exact saved Pi session path or full UUID used as
the source for a new derived context; otherwise a new Pi session is launched.
Each accepted definition delegation creates one agent generation for one
assignment. The terminal result is delivered once and the agent is cleaned up.

## `continue`

```json
{
  "action": "continue",
  "session": "<exact .jsonl path or full UUID>",
  "task": "Continue the investigation"
}
```

Allowed fields are `action`, `session`, `task`, optional `files`, and
`timeoutMs`. The exact saved session path or full UUID supplies its cwd,
definition identity, and historical Pi context. Continuation always creates a new agent generation
for one assignment with a live label; it never assigns work to an existing
agent. `continue` does not accept `cwd` or `fork`; the cwd comes from the saved
session. The saved definition is resolved again from current configuration and
must currently be enabled and authorized; its current effective configuration
is used for the new generation. Omitted model and thinking fields restore the
saved session settings, while explicit definition fields override them.
Concurrent or otherwise conflicting managed representations of the exact
session fail closed. The controller's own active Pi session cannot be continued
to itself; use `delegate` with `fork` when a separate derived context is
required.

When `contextRetirement` is enabled, `continue` is rejected for a retired
managed-agent session. A `delegate` with `fork` is also rejected when its
source is a retired managed-agent session; delegate a fresh agent and pass the
previous handoff/resultRef and relevant files instead. Retired results
explicitly instruct the controller to delegate a fresh agent.

The saved session's logical label is inherited exactly for the continued
generation. A caller cannot provide a continuation label; if the inherited
label is occupied, continuation fails with `agent_label_exists`.

Successful `delegate` results use `action: "delegate"`; successful `continue`
results use `action: "continue"`. Both include `agent`, `definition`, request,
session, and startup evidence where available. Both return after atomic
recording for controller restart recovery, not completion. A terminal result
makes the exact session identity
prominent for a later `continue` call.

## `list`

Request:

```json
{ "action": "list" }
```

No selectors or other fields are accepted. A successful result includes the
effective `agent_definitions` roster and visible agent records.

Each actionable live agent record includes:

| Field                                                           | Meaning                                                                                                                           |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                                                         | Exact live logical agent identity to copy into `steer.agent`, `reply.agent`, or `close.agent`. It is not a continuation identity. |
| `state`                                                         | Safe lifecycle state for observability.                                                                                           |
| `available_actions`                                             | Snapshot of operations currently eligible for this controller.                                                                    |
| `workspace_id`, `pane_id`, `tab_id`, `tab_label`                | Herdr identity evidence.                                                                                                          |
| `cwd`, `pi_session_id`, `pi_session_path`                       | Agent location and Pi session evidence.                                                                                           |
| `owner_session_id`                                              | Exact direct owner Pi session.                                                                                                    |
| `agent_definition`                                              | Effective definition name.                                                                                                        |
| `active_request_id`, `last_activity_at`, `stale`, `inactive_ms` | Assignment and advisory activity evidence.                                                                                        |
| `parent_label`, `orphan`                                        | Visible direct-owner ancestry and proven orphan recovery evidence.                                                                |
| `cleanup_error`, `result_error`, `diagnostic`, `tokens`         | Bounded recovery and presentation evidence when present.                                                                          |

`available_actions` is authoritative model guidance for the current snapshot.
Do not infer eligibility from `state`. Active work may list `steer`; a valid
correlated pending `ask_owner` may list `reply`; exact direct ownership may list
`close`. `available_actions` never lists `delegate` or `continue`: these are
controller operations, not controls on an already-live agent. An agent cannot
receive a second assignment. Descendant visibility does not grant control. Lead orphan
recovery may expose only `close`. Unknown and recovery-only records are
non-actionable. Every operation rechecks identity, ownership, mailbox state, and
lifecycle immediately before mutation.
The public record does not expose `steerable`.

The session-start instructions include the same complete definition metadata
projection returned by `list` for that controller. It is a startup snapshot;
use `list` for live agent state, ownership, or a refreshed definition roster
after configuration changes. Leaf agents do not receive a definition roster.

Lead controllers see the complete effective definition roster and agents visible
through their ownership boundary. Delegating agents see only allowed enabled
leaf definitions and their visible agents. Unknown mailbox diagnostics remain
non-actionable.

## `inspect`

```json
{ "action": "inspect", "agent": "implementer-1" }
```

`inspect` accepts only `action` and the exact live agent label. It is available
only to that agent's direct owner, and only when the agent is a current,
unambiguous managed identity. The result is read-only live terminal/process
evidence only: it contains the exact session/pane identity, Herdr's up to 80
recent-unwrapped terminal lines, and advisory foreground process evidence when
available. Herdsman applies a local 16 KiB byte cap to the captured terminal
output. The public `recent_output_truncated` boolean is true only when that
local byte cap truncates the output and false otherwise; process evidence has
separate bounds. The result does not expose persisted Pi session-message
history. Its model-facing text includes the agent, session, pane, useful
foreground commands, and recent activity; raw process and recent-output
evidence remains in the structured result details.
The identity is checked again after capture; if the pane or Pi session was
replaced, inspection fails closed. Inspection does not change agent state,
mailbox records, lifecycle, or available controls.

## `files` and `timeoutMs`

`files` is valid on `delegate` and `continue`, and on `steer` and `reply`; it is not
valid on `list` or `close`. Paths are resolved from the controller cwd, checked
as readable regular files, canonicalized with `realpath`, and embedded only
when the exact message limit permits. Otherwise they remain canonical references.

`timeoutMs` is valid on `delegate` and `continue` and must be an integer
from `5001` through `300000`. The startup budget reserves one bounded diagnostic
window; it is unrelated to managed-agent Pi shell execution. Direct calls from
a managed agent to the Pi built-in `bash` or `powershell` tool receive a default
600-second timeout when the call omits `timeout`; an explicit timeout is kept
unchanged. Current message limits are governed by the Herdsman config file and
its defaults, plus the fixed mailbox protocol ceiling. Managed mailbox records use
protocol V4 in the `mailboxes-v4` namespace, and control requests use the marker prefix
`__PI_HERDSMAN_AGENT_V4__:`.

Do not attach or mention agent instruction files such as `AGENTS.md`, `CLAUDE.md`,
`GEMINI.md`, or equivalents merely because they exist. Rely on normal project or
runtime discovery. Attach one only when the task requires inspecting,
modifying, comparing, or transmitting it, the user requests it, or its required
instructions would not otherwise reach the target. Attach a required `SKILL.md`
only when the task needs it and the selected definition does not already provide
that skill. Ordinary relevant source, documentation, configuration, and
evidence files remain attachable.

## `steer`

```json
{
  "action": "steer",
  "agent": "implementer-1",
  "message": "Also update the focused regression.",
  "files": [".pi-herdsman/review.md"]
}
```

Use only when `steer` is listed in `available_actions`. Steering changes the
current assignment and does not create another final result.

## `reply`

```json
{
  "action": "reply",
  "agent": "implementer-1",
  "message": "Use option B."
}
```

Use only when `reply` is listed in `available_actions` for a valid correlated
pending `ask_owner` question. The reply continues the same assignment and
contains its request, ask, assignment, and session correlation evidence.

See [`ask_owner` API](ask-owner.md).

## `close`

```json
{ "action": "close", "agent": "implementer-1" }
```

Only `action` and `agent` are accepted. Close requires exact direct ownership,
or the lead-only evidence-backed orphan recovery condition. Closing abandons a
pending owner question; closing a delegating agent cascades through directly
owned agents first. Cleanup remains fail-closed when exact identity or ownership
cannot be proved.

## Result delivery and errors

An accepted delegated task remains the internal mailbox `kind: "task"` request
and has one correlated final result. Delivery goes to the exact owning Pi
session and occurs exactly once. Model-visible completion wording uses
`agent=<agent>`, `definition=<definition>`, `session=<id>`,
`request=<id>`, and status. Details retain durable `agentLabel`,
`agentDefinition`, `piSessionId`, `piSessionFile`, result references, elapsed time,
context usage, truncation, and persistence-error evidence. The agent is cleaned
up after the terminal result is delivered; the Pi session remains available for
continuation.

Tool failures return structured details for normal public errors. See
[Errors](errors.md), [agent states](agent-states.md), and
[agents and identity](../concepts/agents.md).
