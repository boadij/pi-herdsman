# Staff tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

`staff_*` is the direct-report interface for active Chief and Manager sessions.
Manager additionally owns the branch-based project-work operations
`staff_delegate`, `staff_close`, and `staff_discard`.

Lead-targeted actions use the exact full Pi `session` ID from a fresh
supervision snapshot or `staff_list`. Branch-targeted work actions use the Git
branch, not a display name or assignment ID.

Presentation state is not authority. Every action revalidates current identity
and direct-report authority.

## Direct-report projection

Chief sees active Managers and ordinary Leads whose project scope has no active
Manager. A Manager's nested Leads may be summarized for Chief but are not Chief
targets.

Manager sees eligible ordinary Leads in its own Herdr worktree group, including
Leads it did not create. It may observe descendant Agent counts but cannot
target another Lead's Agents.

A direct-report record can expose:

- exact `session`
- presentation-only `display_name`
- runtime state
- `needs_you`
- pending ask identity
- Agent counts
- `available_tools`
- optional branch provenance

Use `session` as the target. Never use `display_name`.

The automatic supervision snapshot is bounded state, not terminal or transcript
evidence. Use `staff_list` when a fresh complete roster is materially needed.

## `staff_list`

```json
{}
```

Returns a fresh direct-report projection and fresh `available_tools`.

For Manager, `work` lists durable project work with its branch, derived
`status`, and a bounded task summary. The statuses are:

```text
active
paused
finished
conflict
```

Only active work includes the live Lead's separate `runtime_state`. Paused work
remains listed without a running Lead. An unavailable worktree is `paused`
with an explanatory `issue`, not a conflict. Individual `work` items do not
expose assignment session IDs, result references, workspace IDs, or pane IDs.

For Manager, `open_workspaces` separately reports current Herdr topology. Each
entry contains:

- `workspace`: current Herdr workspace ID
- optional `branch`
- checkout `path`
- `linked`: whether it is a linked worktree rather than the primary workspace

This topology is derived from Herdr and is not assignment ownership. Use
`staff_inspect` when live terminal/process evidence for a specific report
matters.

A branch is the project-work handle. A session in `reports` is the handle for
live Lead actions.

For a report with a durable pending supervisor question, `pending_ask_id` can
remain present while `needs_you` is already `false`. That means the exact
reply for the current supervisor authority is durably queued, so another reply
is not actionable. The pending ask clears only after accepted delivery. If that
queued reply is no longer valid or present before delivery, a fresh projection
can make `needs_you` true again.

Do not call `staff_list` merely to poll progress.

## `staff_inspect`

```json
{
  "session": "<exact full Pi session ID>"
}
```

Read-only. Requires a current exact direct-report session.

Returns identity-checked live terminal/process evidence: up to Herdr's 80 recent
unwrapped terminal lines with a Herdsman-local 16 KiB byte cap, plus separately
bounded process evidence.

`recent_output_truncated` is true only when the Herdsman-local byte cap truncates
the terminal output. This operation does not expose persisted Pi
conversation history.

Use it only when live terminal/process evidence materially matters.

## `staff_transcript`

```json
{
  "session": "<exact full Pi session ID>"
}
```

Read-only. Requires a current exact direct-report session and revalidates the
persisted Pi session before returning evidence.

The projection is bounded to 16 KiB, with individual tool results bounded to
4 KiB. It can include visible user, assistant, tool-call, tool-result,
compaction, and branch-summary evidence. Reasoning, system messages, extension
entries, and control markers are excluded.

The internal session-file path is never returned.

Use it only when persisted conversation/tool evidence materially matters.

## `staff_message`

```json
{
  "session": "<exact full Pi session ID>",
  "message": "Run checks.",
  "files": ["/tmp/checklist.md", "result:implementation#1"]
}
```

Queues one bounded follow-up to the exact direct report and does not wait for
completion.

`files` accepts ordinary paths, reusable direct Agent refs, and canonical result
refs already supplied as evidence. File preparation uses the same canonical
submission-time behavior and configured byte limits as Agent messages.

## `staff_reply`

```json
{
  "session": "<exact full Pi session ID>",
  "askId": "<exact pending ask ID>",
  "message": "Proceed.",
  "files": ["/tmp/decision.md"]
}
```

Replies to one exact pending direct-report question.

The unchanged ask ID, report identity, direct-supervisor relationship, and
current lease must still validate. Once the exact reply is durably queued,
`needs_you` becomes false even though the pending ask remains until accepted
delivery.

Report activity returns asynchronously. Continue only independent coordination
work, otherwise end the turn instead of polling.

## `staff_delegate`

Manager only.

Start new project work with `task` and optional `branch`, `base`, and `files`:

```json
{
  "task": "Implement the change",
  "branch": "feat/example"
}
```

Resume existing project work by branch only:

```json
{
  "branch": "feat/example"
}
```

If a branch already has project work, a new task, base, or files cannot replace
it. If a branch has no work, `task` is required. The first delegation can
create the first linked worktree; no existing linked worktree is required.

An existing unoccupied Herdr worktree is reused whether open or closed. `base`
applies only when a new worktree must be created. A different live Lead
occupying that worktree prevents another managed writer.

Herdr supplies exact workspace, tab, and pane placement. Workspace membership
does not establish assignment ownership.

Manager-created Leads inherit the Manager session's effective project-trust
decision for that run: trusted launches Pi with `--approve`, untrusted with
`--no-approve`. This does not modify Pi's persistent trust store.

Paused work resumes the same saved project session. Repeating delegation for
already-running work returns the current Lead instead of starting another. An
existing assignment with no matching worktree remains `paused`: restore or
open its checkout and retry, or discard the assignment and delegate again.
Herdsman does not recreate it from a historical base. A closed workspace is
reopened without a second checkout; contradictory or ambiguous current
evidence fails closed.

The assigned Lead completes through
[`supervisor_result`](supervisor.md#supervisor_result). A durable result prevents
restart. If a Manager is active, completion queues a durable notification for
it; otherwise the saved result is reconciled by the next Manager. The
assignment is removed only after accepted result delivery.

## `staff_close`

```json
{
  "session": "<exact live direct Lead session ID>"
}
```

Stops the exact Lead and its owned Agent execution tree.

For managed project work this pauses execution while preserving the assignment,
Pi session, Git branch, and worktree. Resume it with `staff_delegate` using the
branch.

An unassigned direct Lead can also be closed without creating project work.
Failed or ambiguous cleanup does not silently discard work.

## `staff_discard`

Manager only.

```json
{
  "branch": "feat/example"
}
```

Abandons project work by branch. Herdsman stops its execution tree and removes
the assignment only after proving execution has stopped.

The Git branch, worktree, and files remain. A durable completed result cannot be
discarded; it must be settled instead. Current worktree panes are checked for a
possible Pi executor; if execution cannot be proven absent or a result appears
during discard, the assignment remains.

## See also

- [Project orchestration](../guides/project-orchestration.md)
- [Supervisor tools](supervisor.md)
- [Commands](commands.md)
- [Status widget](status-widget.md)
