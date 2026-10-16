# Staff tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

Staff tools are available to active Chief and Manager sessions. Both roles can
use `list_staff` and `message_staff`. `inspect_staff` and
`read_staff_transcript` are available for Chief direct reports and Manager's
assigned Leads, not ordinary Manager-supervised Leads. Manager additionally has
the branch-based project operations `delegate_project`, `resume_project`,
`stop_lead`, and `remove_worktree`. Chief has no project-operation tools.

Lead-targeted actions use the exact full Pi `session` ID from a fresh
supervision snapshot or `list_staff`. Project actions use the Git branch.
Presentation state is not authority; every action revalidates current identity
and direct-report authority.

## Direct-report projection

Chief sees active Managers and ordinary Leads without an active project
Manager. Assigned Leads are never Chief targets. A Manager's nested assigned
and ordinary supervised Leads may be summarized for Chief but are not Chief
targets. Manager sees eligible Leads throughout its verified project worktree
group. A current `ProjectAssignment` marks an assigned report; an ordinary
report is derived supervision only and permits `message_staff`, not inspection,
transcript access, steering, stopping, or project lifecycle operations.
Ordinary Manager-supervised Leads are excluded from Chief's actionable roster.
Ambiguous duplicate assignments or unverified topology do not produce an
actionable report.

A direct-report record can expose the exact `session`, presentation-only
`display_name`, runtime state, Agent counts, `available_tools`, and optional
branch provenance. Manager reports also include a derived `relationship`
value of `assigned` or `supervised`. Use `session` as the target, never
`display_name`. The
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
message is queued by Herdsman before submission. If an assigned report is
actively running, supervisor direction uses Pi's cooperative steering lane;
steering does not abort the current operation or interrupt an in-flight tool
call. Messages to ordinary Manager-supervised Leads are passive: they are
appended without starting a turn when idle and remain queued while the Lead is
active.
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

## `remove_worktree`

Manager only. Remove an exact assigned project's linked checkout after
interactive human confirmation:

```json
{ "branch": "feat/example" }
```

Use this only for an explicitly requested checkout removal, never as an
inference from task completion, review, or inactivity. Herdsman requires the
active Manager's exact current assignment and matching linked checkout, refuses
ambiguous or dirty targets, and never forces removal. If the assigned Lead is
running, its proven owned execution is stopped before removal; a paused Lead is
not restarted. If a later removal step fails, the Lead can remain stopped; it is
not automatically restarted. A closed Herdr workspace may be reopened to
address its verified checkout. Herdr remains responsible for removing the
worktree.

The confirmation identifies the branch and project checkout, explains that
managed execution may be stopped, and says the Git branch and Pi conversation
remain while the assignment will be retired only after verified checkout
removal. Type the exact word `remove`; cancellation or any other response has
no destructive effect. Successful checkout removal is followed by
the existing assignment reconciliation, which retires the matching assignment
and pending project messages when authoritative checkout absence is verified.
The result includes checkout state (`removed`, `present`, or `unknown`) and an
`assignment_retired` status. It is true only when checkout absence and
assignment retirement are both confirmed; when checkout state is `unknown`, a
false value is not proof that the assignment remains. Overall success requires
both checkout absence and assignment retirement to be confirmed. Removal never
deletes the Git branch or Pi conversation.

## See also

- [Project orchestration](../guides/project-orchestration.md)
- [Supervisor tools](supervisor.md)
- [Commands](commands.md)
- [Status widget](status-widget.md)
