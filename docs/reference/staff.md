# Staff tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

`staff_*` is the direct-report interface for active Chief and Manager sessions.
Chief and Manager can list, inspect, read transcripts, and message direct
reports. Manager additionally owns branch-based project operations:
`staff_delegate`, `staff_stop`, `staff_complete`, and `staff_discard`.

Lead-targeted actions use the exact full Pi `session` ID from a fresh
supervision snapshot or `staff_list`. Project actions use the Git branch.
Presentation state is not authority; every action revalidates current identity
and direct-report authority.

## Direct-report projection

Chief sees active Managers and ordinary Leads whose project scope has no active
Manager. A Manager's nested Leads may be summarized for Chief but are not Chief
targets. Manager sees eligible ordinary Leads in its own Herdr worktree group,
including Leads it did not create. It may observe descendant Agent counts but
cannot target another Lead's Agents.

A direct-report record can expose the exact `session`, presentation-only
`display_name`, runtime state, Agent counts, `available_tools`, and optional
branch provenance. Use `session` as the target, never `display_name`. The
automatic supervision snapshot is bounded state, not terminal or transcript
evidence. Use `staff_list` when a fresh complete roster is materially needed.

## `staff_list`

```json
{}
```

Returns a fresh direct-report projection and fresh `available_tools`. For
Manager, `work` lists durable project assignments by branch with derived status
and a bounded task summary. Status is `active`, `paused`, or `conflict`; active
work may include the live Lead's separate `runtime_state`. Paused work remains
listed without a running Lead. A missing worktree can be reconstructed when
resuming the assignment and its branch remains available. Work items do not
expose assignment session IDs, workspace IDs, or pane IDs.

For Manager, `open_workspaces` separately reports current Herdr topology. It is
not assignment ownership. A branch is the project-work handle; a report's
`session` is the handle for live Lead actions.

Do not call `staff_list` merely to poll progress.

## `staff_inspect`

```json
{ "session": "<exact full Pi session ID>" }
```

Read-only. Requires a current exact direct-report session. Returns bounded live
terminal/process evidence. It does not expose persisted Pi conversation
history. Use it only when live terminal/process evidence materially matters.

## `staff_transcript`

```json
{ "session": "<exact full Pi session ID>" }
```

Read-only. Requires a current exact direct-report session and revalidates the
persisted Pi session before returning bounded visible conversation and tool
evidence. Reasoning, system messages, extension entries, and control markers
are excluded; the internal session-file path is not returned.

## `staff_message`

```json
{
  "session": "<exact full Pi session ID>",
  "message": "Please revise the error handling.",
  "files": ["/tmp/review.md", "result:implementation#1"]
}
```

Queues one bounded follow-up to the exact direct report without waiting for
completion. `files` accepts ordinary paths, reusable direct Agent refs, and
canonical result refs already supplied as evidence. Attachments are prepared
at submission; the coordination record contains text.

## `staff_delegate`

Manager only. Start new project work with `task` and optional `branch`, `base`,
and `files`:

```json
{ "task": "Implement the change", "branch": "feat/example" }
```

Resume existing project work by branch only:

```json
{ "branch": "feat/example" }
```

If a branch already has an assignment, new task, base, or files cannot replace
it. If it has no assignment, `task` is required. An unoccupied existing Herdr
worktree is reused. A different live Lead occupying that worktree prevents
another managed writer.

If an assigned worktree is missing, Herdsman recreates it from the same branch.
When the exact Pi session has persisted history, its saved cwd is used and the
same session ID resumes. If the branch no longer exists, recreation fails
closed rather than creating it from the current default branch.

Repeating delegation for already-running work returns the current Lead instead
of starting another. Manager-created Leads inherit the Manager session's
effective project-trust decision for that run; this does not modify Pi's
persistent trust store.

## `staff_stop`

```json
{ "session": "<exact live direct Lead session ID>" }
```

Stops the exact Lead and its owned Agent execution tree. For managed project
work, the assignment, Pi session, Git branch, and worktree are preserved. Resume
the work with `staff_delegate` using its branch. An unassigned direct Lead can
also be stopped without creating project work. Failed or ambiguous cleanup does
not resolve an assignment.

## `staff_complete` and `staff_discard`

Manager only. Both take the exact project branch:

```json
{ "branch": "feat/example" }
```

`staff_complete` resolves fulfilled work; `staff_discard` abandons it. Both
revalidate Manager authority and current topology, stop the exact Lead and its
owned Agent tree, and remove the assignment only after execution is proven
stopped. The Git branch and worktree remain. Ambiguous identity, possible live
Pi execution, or failed cleanup preserves the assignment. Retained project
messages are removed after assignment resolution.

## See also

- [Project orchestration](../guides/project-orchestration.md)
- [Supervisor tools](supervisor.md)
- [Commands](commands.md)
- [Status widget](status-widget.md)
