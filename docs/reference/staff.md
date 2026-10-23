# Staff tools

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

Staff tools are available to active Chief and Manager sessions. Both roles can
use `list_staff`, `inspect_staff`, and `message_staff`; `read_staff_transcript`
is available when persisted session evidence is available. Manager and Chief
have the same direct-report observation and communication capabilities.
Manager additionally has
the branch-based project operations `delegate_project`, `resume_project`,
`stop_lead`, `remove_worktree`, and `merge_project`. Chief has no
project-operation tools.

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
report is derived supervision, not project ownership. Both assigned and
ordinary Manager reports allow inspection, transcript access when valid
persisted evidence is available, and messaging. Project lifecycle operations
remain assignment-bound.
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
  "files": ["/tmp/review.md", "result:implementation#1"],
  "retain": true
}
```

Sends an asynchronous durable message to the exact current direct report. The
message is queued by Herdsman before submission. If an assigned report is
actively running, supervisor direction uses Pi's cooperative steering lane;
steering does not abort the current operation or interrupt an in-flight tool
call. Authorized Manager messages to ordinary Leads use the same cooperative
steering behavior, whether the Lead is active or idle.
`files` accepts ordinary paths, reusable direct Agent refs, and canonical
result refs already supplied as evidence. Supported UTF-8 text must fit both
configured per-file and complete-message limits or the handoff fails. The
compact coordination record carries the prepared message body separately when
needed, along with hidden semantic-result bindings for the recipient to
forward.
`retain` is optional and defaults to `false`. Set it to `true` only when the
message text and supplied files should become continuing required evidence
for the target's verified project assignment. The target must be an assigned
project Lead; ordinary supervised Leads have no project evidence scope.
Retention validates authority and evidence and fails explicitly when either is
unavailable; it is never silently treated as an ordinary message. Retention
and message delivery are one logical operation, but if persistence succeeds
and delivery fails, the outcome reports that partial success rather than
claiming the handoff completed. Initial `delegate_project.files` are required
as well. See [Handoffs and files](../guides/handoffs.md#required-assignment-evidence).

### Manage project required evidence

In the Manager project-assignment action menu, choose **Required evidence**
to inspect the assignment's required entries, including each exact ID, name,
and origin. Select an entry to review its details, then choose **Remove** and
confirm. This Manager-only action removes that exact project-owned requirement
record. Inherited baseline requirements are shown as protected and cannot be
removed there. Removal does not delete snapshots or source files and does not
change evidence already accepted by Agents. The project menu does not remove
managed-Agent-local additions; local-addition removal is an internal
capability, not a separate model-facing tool or UI. Project-wide required evidence is controlled only by the Manager; assigned
Leads use delegation files for recipient-specific evidence.

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
`mailboxPayloadLimitBytes` bounds the durable project assignment. Explicitly
supplied files are registered as required evidence for the assignment. Durable
registration requires supported UTF-8 text no larger than 1 MiB; unsupported,
binary, or oversized files fail instead of becoming required evidence. A
supported snapshot that does not fit inline is delivered by reference to the
preserved snapshot.

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
assignment. Retirement preserves the exact session’s Managed Lead identity and
Agent ownership. It grants no ordinary execution or fresh delegation authority;
exact-owner recovery remains independently authorized.

## `remove_worktree`

Manager only. Remove an explicitly requested assigned project's linked
checkout, or register an actionable approval request:

```json
{ "branch": "feat/example" }
```

Use this only for an explicitly requested checkout removal, never as an
inference from task completion, review, or inactivity. Herdsman requires the
active Manager's exact current assignment and matching linked checkout and
checks clean state and occupants. Without preauthorization, a valid request
returns promptly with `confirmation_required: true`, `pending: true`, and
`ok: false`, plus a correlated `request_id`. No removal, execution shutdown, or
operation lock occurs. Review it with `/manager remove`; unanswered requests do
not block coordination. Pi keeps the request on the active session branch, so
it remains reviewable after reloading that same session. A persistent native
status indicator points to the review command. A human preauthorization for
this exact repository skips only the extra prompt.

Pending intent never authorizes deletion by itself. Duplicate requests for the
same current target reuse the request identity; changed assignment or checkout
replaces it. Requests from another session branch do not carry over. Each human
approval validates current authority and the exact recorded target afresh.

Both human entry points share one confirmed destructive operation. It requires the
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
The human removal outcome includes checkout state (`removed`, `present`, or `unknown`) and an
`assignment_retired` status. It is true only when checkout absence and
assignment retirement are both confirmed; when checkout state is `unknown`, a
false value is not proof that the assignment remains. Overall success requires
both checkout absence and assignment retirement to be confirmed. Removal never
deletes the Git branch or Pi conversation.

## `merge_project`

Manager only. Integrate an assigned local branch into the verified primary
branch using fast-forward-only Git:

```json
{ "branch": "feat/example", "expected_head": "<full commit SHA>" }
```

`expected_head` is the exact source revision the Manager accepted after
validation; the source branch must still point to it. This operation is
separately controlled by the Manager local-merge policy (see
[Configuration](configuration.md#manager-local-merge)). It does not fetch,
push, create a merge commit, or delete the Git branch. Divergence returns
`needs_update` with the observed target revision; this means the source branch
must incorporate the target, not necessarily that Git found a content conflict.
The Lead remains responsible for resolving changes and validating the updated
branch before the Manager accepts a new revision.

The structured result reports `status`, `integrated`, `checkout_removed`, and
`assignment_retired` independently. `needs_update` leaves both checkouts
untouched. Successful integration triggers guarded cleanup of the exact
assigned checkout, followed by assignment reconciliation; `complete` requires
both cleanup facts. If either is incomplete, `cleanup_pending` reports the
partial result without claiming finalization. An authorized retry with the
same accepted SHA rechecks the exact assignment and policy and retries
guarded cleanup. If the checkout is already absent, it is reconciled only
after fresh Git evidence proves the accepted SHA is contained in the verified
primary branch, plus checkout provenance and exact-assignment checks. Absence
alone never proves integration. Other validation or Git-state uncertainty
fails closed; a `blocked` result may require inspecting the primary checkout
before retrying.

## See also

- [Project orchestration](../guides/project-orchestration.md)
- [Supervisor tools](supervisor.md)
- [Commands](commands.md)
- [Status widget](status-widget.md)
