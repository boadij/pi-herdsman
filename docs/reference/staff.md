# Staff tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

Staff tools are available to active Chief and Manager sessions. Both roles can
use `list_staff`, `inspect_staff`, `read_staff_transcript`, and
`message_staff`. Manager additionally has the branch-based project operations
`delegate_project`, `resume_project`, and `stop_lead`.
Chief has no project-operation tools.

Lead-targeted actions use the exact full Pi `session` ID from a fresh
supervision snapshot or `list_staff`. Project actions use the Git branch.
Presentation state is not authority; every action revalidates current identity
and direct-report authority.

## Direct-report projection

Chief sees active Managers and ordinary unassigned Leads, even when an active
Manager shares their project scope. A Manager's nested assigned Leads may be
summarized for Chief but are not Chief targets. Manager sees only live exact
Leads named by current `ProjectAssignment` records for its repository; physical
scope, worktree membership, or which Manager created a Lead does not establish
authority. It may observe descendant Agent counts but cannot target another
Lead's Agents. Ambiguous duplicate assignments do not produce an actionable
report.

A direct-report record can expose the exact `session`, presentation-only
`display_name`, runtime state, Agent counts, `available_tools`, and optional
branch provenance. Use `session` as the target, never `display_name`. The
automatic supervision snapshot is bounded state, not terminal or transcript
evidence. Use `list_staff` when a fresh complete roster is materially needed.

## `list_staff`

```json
{}
```

Returns a fresh direct-report projection and fresh `available_tools`. For
Manager, `work` lists durable project assignments by branch with derived status
and a bounded task summary. Status is `active`, `paused`, or `conflict`; active
work may include the live Lead's separate `runtime_state`. Paused work remains
listed without a running Lead. Verified checkout absence retires the assignment;
unavailable or ambiguous Git inventory preserves it. Work items do not expose
assignment session IDs, workspace IDs, or pane IDs.

For Manager, `open_workspaces` separately reports current Herdr topology. It is
not assignment ownership. A branch is the project-work handle; a report's
`session` is the handle for live Lead actions.

Do not call `list_staff` merely to poll progress.

## `inspect_staff`

```json
{ "session": "<exact full Pi session ID>" }
```

Read-only. Requires a current exact direct-report session. Returns bounded live
terminal/process evidence. It does not expose persisted Pi conversation
history. Use it only when live terminal/process evidence materially matters.

## `read_staff_transcript`

```json
{ "session": "<exact full Pi session ID>" }
```

Read-only. Requires a current exact direct-report session and revalidates the
persisted Pi session before returning bounded visible conversation and tool
evidence. Reasoning, system messages, extension entries, and control markers
are excluded; the internal session-file path is not returned.

## `message_staff`

```json
{
  "session": "<exact full Pi session ID>",
  "message": "Please revise the error handling.",
  "files": ["/tmp/review.md", "result:implementation#1"]
}
```

Sends an asynchronous durable message to the exact current direct report. The
message is queued by Herdsman before submission. If the report is actively
running, supervisor direction uses Pi's cooperative steering lane; steering
does not abort the current operation or interrupt an in-flight tool call.
`files` accepts ordinary paths, reusable direct Agent refs, and canonical
result refs already supplied as evidence. Attachments are prepared at
submission; the coordination record carries the prepared text and any hidden
semantic-result bindings needed for the recipient to forward them.

## `delegate_project`

Manager only. Start new project work with a required `task` and optional
`branch`, `base`, and `files`:

```json
{ "task": "Implement the change", "branch": "feat/example" }
```

An existing assignment on that branch is rejected; use `resume_project` to
continue it. An unoccupied existing Herdr worktree may still be reused for new
work. A different live Lead occupying that worktree prevents another managed
writer.

For new work, `files` uses the same configured attachment sizing policy as
Agent delegation: `inlineAttachmentLimitBytes` controls per-file embedding and
`mailboxPayloadLimitBytes` bounds the durable project assignment. Non-text or
non-fitting files remain canonical references.

Manager-created Leads inherit the Manager session's effective project-trust
decision for that run; this does not modify Pi's persistent trust store.

## `resume_project`

Manager only. Resume existing unresolved project work using its exact branch:

```json
{ "branch": "feat/example" }
```

The assignment must already exist; resume does not create or replace it.
Resuming already-running work returns the current exact Lead instead of
starting another. A stopped Lead is relaunched with the same assignment while
its worktree exists. Verified checkout absence retires the assignment rather
than recreating it. A retired assignment cannot be resumed; new work may use
`delegate_project` with the remaining branch.

## `stop_lead`

```json
{ "session": "<exact live direct Lead session ID>" }
```

Stops only an exact currently assigned project Lead and its owned Agent
execution tree. The assignment, Pi session, Git branch, and worktree are
preserved. Resume the work with
`resume_project` using its branch. An unassigned Lead is not a Manager staff-stop
target. Failed or ambiguous cleanup does not retire an assignment. Successful
Herdr worktree removal or verified checkout absence retires the assignment and
removes pending project messages. Failed or ambiguous inventory preserves the
assignment. The
assigned Lead may separately release Manager authority through confirmed
`/takeover`, which removes the assignment and pending project messages without
stopping the session or owned Agents.

## See also

- [Project orchestration](../guides/project-orchestration.md)
- [Supervisor tools](supervisor.md)
- [Commands](commands.md)
- [Status widget](status-widget.md)
