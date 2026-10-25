# Project orchestration

[Documentation index](../README.md) · [Coordination](../concepts/coordination.md)

Use Manager when independent project work deserves separate Leads and Git
branches instead of more Agents inside one Lead's worktree.

Manager project operations control only Leads named by current assignments.
Eligible ordinary Leads in the verified worktree group are also supervised for
observation and communication, not project operations. Project Leads own
technical decisions and orchestrate execution through their Agent trees.

Manager-assigned project Leads use only the reserved `managed-lead` definition,
regardless of an ordinary Lead's saved execution preference. The bundled
default keeps direct Lead work read-only and delegates executable project work
to managed Agents while the Lead retains decomposition,
architecture, scope, technical direction, integration, conflict resolution,
acceptance, and final technical decisions. Project and global overlays can
deliberately customize that launch policy; see
[Customizing bundled agents](customizing-agents.md#managed-project-lead).

## Enter Manager mode

Start Pi in the primary workspace of the Herdr worktree group and run:

```text
/manager
```

Optionally, enable `Manager auto-start` in `/agents` to have a session with no
persisted role intent attempt the existing Manager startup path when it starts
in the project's primary workspace. The preference does not persist Manager
intent; explicit session roles take precedence, and an ineligible or contended
attempt remains an ordinary Lead.

The current Lead must be eligible for Manager mode and must not still own
unresolved Agent work. Only one live Manager can hold authority for a project
scope at a time. No prior chat turn or existing linked worktree is required in
an ordinary Git primary workspace.

Manager's work projection reports `active`, `paused`, or `conflict`. A live
Lead's runtime state is separate from project status.

## Start and resume project work

Ask Manager for a bounded objective:

```text
Implement the API change on branch feat/api-change.
```

Manager delegates the work to a Lead. The Git branch is the durable semantic
work handle; the Lead is the current executor. Internal assignment IDs are not
project-work handles. A branch is optional when starting new work. If omitted,
Pi Herdsman can generate one. The first delegation can create the first linked
worktree, and an unoccupied existing worktree for the branch is reused.

Start new work with `delegate_project`. Resume existing work with
`resume_project` using its branch. A verified Git inventory showing the
assignment's worktree checkout is absent retires that assignment and its
pending project messages; failed or ambiguous inventory preserves it. A retired
assignment cannot be resumed, but a new delegation may start managed work from
the remaining Git branch. Retirement does not delete branches or Pi sessions.

A Lead with a verified project assignment receives a native Pi session name
from its branch. Existing names, including names explicitly cleared in Pi, are
preserved; use Pi's `/name` command to choose or change a name.

Whenever Herdsman actually launches the project Lead process, it resolves the
current `managed-lead` definition from the target worktree plus the global
overlay. A trusted project may therefore configure the Lead that works on its
branch. A Lead that is already live is not hot-reconfigured; changed launch
policy takes effect on its next start.

See [`delegate_project`](../reference/staff.md#delegate_project) and
[`resume_project`](../reference/staff.md#resume_project).

Files supplied to `delegate_project` are retained as required evidence for the
assignment and delivered to future delegated descendants. To make later
review material a continuing requirement while sending it to an assigned
Lead, a Manager uses `message_staff` with `retain: true`; the message text and
files then become required project evidence. The Manager alone controls
project requirements. Leads delegate corrections with recipient-specific
`files` and send continuing findings through `message_supervisor.files` for
Manager evaluation. On supported operations, omitted or false `retain` keeps
files limited to that handoff. Retention
requires verified assignment authority and eligible evidence, and failure is
explicit rather than falling back to an ordinary handoff. Ordinary Leads have
no automatic evidence scope. See [required assignment evidence](handoffs.md#required-assignment-evidence)
and the [`message_staff`](../reference/staff.md#message_staff) and
[`delegate_agent`](../reference/agent.md#delegate_agent) references.
To remove project-owned requirements, open the project assignment action menu,
choose **Retained evidence**, select the entry by ID, name, and origin, then
**Remove requirement…** and confirm **Remove requirement**. Inherited baseline
entries are protected. Removal leaves the snapshot, source file, and evidence
already accepted by Agents unchanged. The menu cannot remove managed-Agent-local
additions; assigned Leads have no separate removal UI.

## Run independent work in parallel

Independent branches can run concurrently:

```text
Manager
├─ feat/api-change → Lead → Agents
└─ feat/docs       → Lead → Agents
```

Keep overlapping writers out of the same worktree. Workspace membership does
not imply ownership, and Manager must not start another writer beside a Lead
that already occupies the relevant worktree. Use separate Leads when work is
independent enough to justify separate branch and execution boundaries.

## Integrate completed branches

When an assigned Lead has completed and validated its branch, the Manager can
accept its exact source commit and use the Manager-only `merge_project` staff
tool to fast-forward the verified primary branch. This is local Git
integration; it does not fetch, push, or merge a hosted pull request. The source
and target must be clean, and a branch that does not contain the current target
is returned as `needs_update`. That result is not proof of a content conflict.
Use `message_staff` to ask the responsible Lead to incorporate the reported
target revision, resolve any actual conflicts, run relevant checks, and report
the exact validated new source HEAD. Then accept that revision before retrying.

Independent feature branches may be integrated one at a time; a later branch
may need to incorporate earlier integration first. The Git branch is preserved.
After verified integration, the operation attempts guarded removal of the
exact source checkout and retirement of its assignment. `cleanup_pending`
means integration is verified but at least one cleanup fact is not; retry
with the same accepted SHA while permission remains enabled to retry the
guarded cleanup. If the checkout is already absent, reconciliation requires
independent Git proof that the accepted SHA is on the verified primary branch
and exact assignment/provenance checks. Checkout removal or assignment
retirement alone does not prove integration or project validation succeeded.

## Coordinate and review

While a Lead remains assigned, Herdsman automatically returns every completed
direct Lead response to the Manager role. If no Manager is available, the
handoff remains pending until a Manager can receive it. When managed Agent work
is active, the herd run owns that handoff until it settles; the response
summarizes outcome, validation, and important unresolved points. These nonterminal handoffs do not
close project work: assignments remain open through
review and requested corrections. Routine information that can wait should go
through the automatic result handoff. A managed Lead may use nonblocking
`message_supervisor` for a timely question, clarification, warning, or other
information the Manager needs before that boundary; the Lead may choose to wait
for a response through `message_staff`. A later automatic result may repeat
some information; separate messages and results are not deduplicated.

Automatic project reports transfer summary text only, not files. A result
reference mentioned in a report is informational; mentioning it does not itself
make that result available, though the Manager may already have its binding from
an earlier handoff. When asking the reporting Lead to revisit its own result,
the Manager can mention the reference in `message_staff.message` without
attaching it. Use `message_staff.files` to transfer relevant readable local
files or result references resolvable on the current Pi branch. A semantic
result reference is resolvable when the branch contains its direct Agent
completion or an explicitly imported binding; already-supplied canonical result
references may also be passed through. If the Manager needs an artifact for
review or onward delegation, the Lead explicitly transfers it through
`message_supervisor.files`.

Only a Lead turn with a verified current Pi `completed` outcome contributes a
successful response; text alone does not prove completion. On a model execution
failure, Herdsman publishes a factual, nonterminal execution-failure report,
including partial response text only as explicitly incomplete context. A failed
Lead run does not stop its Agents, integrate their work, or complete the project
assignment. Child completion later does not turn that failure into a successful
handoff. A restored unfinished herd run has no verified prior summary and is
reported as unresolved unless a later Lead execution completes successfully.
Cancellation is reported separately as a factual, nonterminal message without
partial assistant output.

An assigned Lead reports an execution failure to its Manager through the
durable project-message path. If the Manager is absent, the report remains
pending; when the exact current Manager returns idle, an unreceived failure
backlog message can trigger one follow-up turn. Historical ordinary reports
remain non-triggering, and a receipt in that Manager session prevents
redelivery. A Manager or an unassigned Lead reports failures to a currently
verified Chief. Chief's own Pi execution failure is exposed in its session. If
no Chief is verifiable, local Pi session evidence is retained; there is no
durable future-Chief inbox.

Treat execution failure and unresolved project work as separate facts. Do not
retry the model run or replay tool calls automatically. Before continuing the
same assigned session, inspect its transcript and any external effects because
a failed execution may have partially acted. Send an authorized message to the
exact live, idle Lead to continue; resume a deliberately stopped Lead with
`resume_project` on its branch. Do not create a second writer or treat
cancellation as a request to resume. Missing or conflicting runtime identity
fails closed; verify current assignment and supervisor authority before acting.
Managers should treat routine results as informational and act when useful
coordination is needed.

Use the current supervision state rather than repeatedly listing or inspecting
reports to poll for progress. Inspect live terminal or persisted transcript
evidence only when it materially matters.

## Pause and resume

`stop_lead` stops a Lead and its owned Agent execution tree while preserving
the assignment, Pi session, Git branch, and worktree. Resume the same work with
`resume_project` using its branch. `stop_lead` does not resolve project work.

See [`stop_lead`](../reference/staff.md#stop_lead) and
[`resume_project`](../reference/staff.md#resume_project).

## Retire project work

Verified worktree retirement atomically removes the exact assignment from active
authority and preserves it as pending context for the repository's Manager role.
The next verified Manager receives a factual, hidden Pi context message without
starting a turn or interrupting active work. Pre-turn reconciliation delivers
newly discovered retirement before the first model request; background delivery
waits for idle. Pre-turn processing is bounded; excess backlog remains pending
for later inbox passes. The notice does not establish completion, acceptance, merge, or
discard, and preserves the Git branch and Pi conversation.

Pending context survives Manager replacement. After assignment-scoped handoff
cleanup succeeds and Pi history proves delivery, it is consumed rather than
kept as a retirement log. An exact successful removal tool result in the receiving
Manager's history also proves awareness; a UI-only notification does not.
A crash between delivery and consumption can replay context to a replacement
Manager. Cleanup failures preserve pending evidence for a later inbox pass.

Successful Herdr worktree removal or verified checkout absence retires the
matching project assignment and any still-pending messages; the Git branch
remains. Failed or ambiguous inventory does not imply absence, so the
assignment is preserved until authoritative evidence is available. Settlement,
review, and user interaction do not release an assignment.

### Dedicated sessions and independent continuation

A Managed Lead keeps its immutable identity for its exact Pi session. Its
execution state is `managed` with a current exact assignment,
`managed · unavailable` when evidence is insufficient or contradictory, and
`managed · retired` when authoritative evidence confirms retirement or
replacement. Missing assignment evidence alone is not proof of retirement.
Neither inactive state allows fresh delegation, continued Agent work, ordinary
execution profiles, Manager/Chief activation, or ordinary global peer access.
History and independently authorized exact-owner Agent recovery remain available.
Retirement does not stop a live Pi process or imply Agent completion.

Use native Pi `/fork` or `/clone` to continue independently in a new ordinary
session with copied conversation history. The new exact session inherits
neither project authority nor Agent ownership, supervisory roles, or saved
execution policy. `/new` also starts a distinct ordinary session; `/resume`
preserves the selected session identity, and `/tree` cannot change it.
Copying history does not create a separate Git checkout, relaunch Pi, or reset
process-level model, extensions, skills, or filesystem environment. Choose a
separate checkout or process independently when needed; avoid overlapping writers.

For an explicitly requested checkout removal, an active Manager can use
`/manager remove <branch>` or the `remove_worktree` staff tool. Normally the
tool records a pending request and returns immediately; review it with
`/manager remove`. The request remains on the active Pi session branch across
reload and appears in native Pi status; it is intent, not deletion authority.
The exact bare `/manager remove` opens review, while `/manager remove ` starts
branch completion. Removal asks for typed `remove` unless this exact repository
has been preauthorized by a human with `/manager remove-preapproval on` or the
Project Overrides policy row.
Neither task completion, review, nor inactivity is approval. All paths validate
the exact Manager assignment and linked checkout, refuse dirty or ambiguous
targets, and use Herdr's non-forced worktree removal. A running assigned Lead
may be stopped first and is not automatically restarted if a later step fails.
The checkout result remains distinct from assignment retirement, and the Git
branch and Pi conversation are preserved.

## Leave and return

Run:

```text
/manager leave
```

Leaving Manager mode preserves project assignments. Current Herdr topology is
derived again when work is observed or resumed. A later Manager can continue
the same repository and branch-based work.

## Use Chief only for the next supervision layer

Chief is separate from project orchestration. It supervises Managers across
the current Herdr runtime and directly supervises ordinary Leads only when they
have no active project Manager. An active Manager supervises every eligible
Lead in its verified project worktree group, but controls project execution
only for Leads named by exact current project assignments. Ordinary Leads
remain independent while receiving the same verified direct-report inspection,
transcript (when valid persisted evidence exists), and messaging capabilities;
authorized messages can cooperatively steer an active Lead. Ambiguous
Manager evidence does not trigger Chief fallback. Assignment authority
survives Manager process replacement. A Manager does not become Chief or
forward assigned Leads into a parallel Chief control path.

Manually continuing the exact assigned Pi session within valid project scope
keeps it managed. Execution profiles configure behavior, not authority: only
the current exact `ProjectAssignment` establishes Manager control (see
[Coordination](../concepts/coordination.md)).

See [Coordination](../concepts/coordination.md) and
[Commands](../reference/commands.md).

## Reference

- [Staff tools](../reference/staff.md)
- [Supervisor tools](../reference/supervisor.md)
- [Peer tools](../reference/peer.md)
- [Status widget](../reference/status-widget.md)
