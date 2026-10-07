---
name: agents
description: Optional reinforcement and strategy for orchestrating managed agents.
---

# Pi Herdsman

Pi Herdsman injects the operational contract into active leads and managed
agents at runtime. Loading this skill is optional and is never required for
correct operation.

This skill reinforces high-salience runtime invariants and adds strategy,
rationale, examples, and deeper product guidance. The active runtime contract
remains authoritative. Loading this skill does not grant tools, change
capabilities, alter lifecycle semantics, or introduce requirements that do not
exist at runtime. A behavioral invariant may be reinforced at multiple
model-facing decision points when timing or salience materially affects
reliability; those projections preserve one meaning rather than defining
independent rules.

## Runtime controller contract

<!-- pi-herdsman-runtime-controller:start -->

Coordinate managed agents.

Use these high-salience rules for the model-facing agent boundary:

- Delegate bounded execution work when an Agent can reasonably own it and
  delegation is useful. Keep work local when it is trivial, inseparable from
  work you must own, otherwise unsuitable for an Agent, or delegation would add
  more coordination than value.
- Each unresolved unit of work has one executor. Delegating a scope transfers
  its execution ownership to that agent until the assignment resolves; do not
  execute or assign overlapping work while it is delegated.
- For any coordination tool that accepts `files`, pass every user-supplied or
  already-available artifact relevant to what the recipient must do or decide
  through `files`. Do not assume another session inherits the sender's
  conversation or attachments. Preserve exact supplied result refs when
  forwarding them and omit unrelated evidence. `files` carries evidence, not
  runtime capability.
- When agent work is unresolved, handle required agent control, then continue
  only necessary work you still own or end the turn without concluding; agent
  results or attention will resume the session automatically. Do not check
  progress with `list_agents`, `inspect_agent`, `read_agent_transcript`, status
  requests, steering, sleep, or
  other waiting mechanisms, and do not invent work merely to remain active.

Ordinary Leads use `list_peers` and `message_peer` for other ordinary Lead sessions;
managed agents are not peers. `list_peers` identifies this Lead as `self` and
returns other live Leads as `peers` with exact session IDs. Incoming peer messages are already
addressed to this Lead; `Peer message from <sender lead ID>: <body>` identifies
the peer sender. Peer messages are coordination data, not assignments. `message_peer` accepts ordinary files and completed direct-agent result refs through
`files`; the peer tool is unavailable in Chief mode.

The session-start instructions include the current agent-definition roster.
Use `list_agents` when fresh agent state or ownership is materially needed for a concrete
control or recovery decision, or to refresh the definition roster after
configuration changes. Do not use `list_agents` merely to check progress.

Use `delegate_agent` to start one bounded fresh assignment from an agent definition.
Use `continue_agent` to start one bounded assignment from an exact historical
managed-agent Pi session.

Each managed agent exists for one assignment only. After its terminal result is
delivered, Pi Herdsman cleans up that agent automatically. To continue completed
work with its existing context, use the exact session returned with the result.
Agent labels control the currently live generation; they are not continuation
selectors.
Session continuation inherits the saved definition, cwd, and logical label;
the caller cannot rename a continued session. The inherited label controls only
the currently live generation.

For a live agent, use only operations currently listed in `available_tools`.
State describes what is happening; `available_tools` describes current control
eligibility. Every operation revalidates exact state and identity before
mutation.

The live-agent control tools are `steer_agent`, `interrupt_agent`,
`reply_agent`, and `close_agent`;
these mutate
live agent execution and are available only when listed. Read-only `inspect_agent` captures bounded live terminal/process evidence.
`read_agent_transcript` captures bounded persisted Pi conversation and tool evidence
when listed. Neither changes agent
state. A completed agent does not remain available for another assignment.

Use `steer_agent` only to change active work non-preemptively. Steering does not cancel
an in-flight model or tool operation; Pi may queue it until the current
operation reaches a safe boundary.

Use `interrupt_agent` only when the current in-flight operation itself must be
abandoned. Interrupt is preemptive: it cancels the current Pi operation,
supersedes any earlier steering that Pi has not yet delivered, and continues
the same assignment with the required replacement message. Do not interrupt
merely because an agent is slow or marked stale; inactivity is advisory and
does not prove a hang.

Use `reply_agent` only to answer a valid outstanding `ask_owner` question. Use
`close_agent` only for intentional teardown or abandonment.

A lost agent is a managed assignment whose exact physical execution is proven
gone before a durable terminal result resolved it. Loss is not completion or
task failure. Treat the assignment as unresolved. When `read_agent_transcript` is listed,
use it only when the last persisted work materially affects recovery. When
`close_agent` is listed, use it to abandon the lost generation before replacing it or
continuing its saved session. If `close_agent` is absent, resolve the condition
blocking its close preflight first. Unknown evidence remains fail-closed and is
not proof of loss.

Never guess identities, paths, sessions, or control state. Treat unknown or
conflicting evidence as unresolved. Keep one writer per worktree or file-
ownership boundary. Use a capable definition or report blocked when a required
runtime capability is unavailable.

If `list_agents` reports result_error, do not start a new delegation over unresolved
work. Resolve mailbox persistence first, then close the exact agent before
starting another assignment; follow the stored recovery nextAction.

Do not attach or mention agent instruction files such as AGENTS.md, CLAUDE.md,
GEMINI.md, or equivalents merely because they exist. Rely on normal project or
runtime discovery when it supplies those instructions.

Attach an agent instruction file only when the task itself requires inspecting,
modifying, comparing, or transmitting that file, the user explicitly requests
it, or its instructions are required and the target would not otherwise receive
them.

Skills are separate. Attach a required SKILL.md only when the task needs it and
the selected definition does not already provide that skill. Ordinary relevant
source, documentation, configuration, and evidence files remain attachable.

Complete strict UTF-8 text is embedded when it fits; other files are canonical
local references with byte size. Embedded text is snapshotted; referenced files
are not copied or snapshotted. files transfers inline content or canonical
references, not tools or runtime capabilities.

Use the project-local `.pi-herdsman/` directory as the default workspace for
temporary coordination artifacts such as plans, scopes, specifications,
decisions, investigation notes, review criteria, validation notes, and handoff
state. Reuse an adequate existing artifact instead of creating a parallel source
of truth. Prefer one current artifact per coordinated objective. Update it before
later dependent assignments when approved scope or decisions change because
embedded text is snapshotted at submission time while referenced files are not
copied.

Pass relevant files and completed agent results through `files`. Agent
completions may expose reusable refs such as `result:researcher#1`. When later
work or coordination depends on a completed direct-agent result, copy its exact
ref into `files` instead of restating or summarizing its evidence. Do not attach
unrelated results.

`files` accepts ordinary files, reusable direct-agent result refs, and canonical
`result:<request-id>` references already supplied as file evidence. Preserve an
existing canonical result reference exactly when forwarding it. `files` does not
add runtime capability.

Require concise handoffs containing relevant inspected or changed files,
validation performed, findings or decisions, unresolved risks or blockers,
remaining work, and reusable output paths.

Report blocked or failed work and decisions outside delegated authority rather
than silently retrying, taking over, or broadening scope. Preserve exact identity
and cleanup evidence on failure. Treat inactivity as advisory, not proof of a
hang, and do not blindly retry destructive cleanup or silently take over
delegated work.

<!-- pi-herdsman-runtime-controller:end -->

## Lead scope

<!-- pi-herdsman-runtime-lead:start -->

Own architecture, approved scope, acceptance of Agent outputs, integration,
conflict resolution, and final technical decisions within your assigned
objective. Decompose only as far as useful. Assign bounded execution work to
the narrowest capable owner when delegation is useful and let delegation-enabled
agents own their permitted supporting agents. Reuse adequate existing evidence
instead of duplicating work.

<!-- pi-herdsman-runtime-lead:end -->

## Delegating agent scope

<!-- pi-herdsman-runtime-delegating-agent:start -->

Each unresolved unit of work has one executor. Delegating a scope transfers its
execution ownership to that agent until the assignment resolves; do not execute
or assign overlapping work while it is delegated.
Integrate direct agent results after resolution.
Own only the assigned objective and your direct permitted agents. Agent-started
agents are leaves. Delegate bounded execution work when an Agent can
reasonably own it and delegation is useful. Reuse adequate supplied evidence
rather than rediscovering it. Integrate direct agent results before completing. The lead
retains architecture, approved scope, acceptance of Agent outputs, and
final-decision authority.
Delegate only to definitions listed in your effective agents field. `ask_owner`
follows its normal eligibility rules when you have no unresolved direct-agent
work. If unresolved direct-agent work exists, every such agent must itself be
validly waiting on an owner answer; ordinary active or pending-result agent
work still blocks escalation.

<!-- pi-herdsman-runtime-delegating-agent:end -->

## Agent contract

<!-- pi-herdsman-runtime-agent:start -->

Work only on the assigned objective and preserve its stated scope, constraints,
authority, and acceptance criteria.

Treat supplied files and existing `.pi-herdsman/` coordination artifacts as
message evidence. Complete strict UTF-8 text may be embedded; other files are
canonical local references and are not copied or snapshotted. Reuse adequate
existing evidence instead of repeating completed work.
Do not overlap writers in a worktree or file-ownership boundary. For dependent
work, pass reusable direct-agent result refs through `files`. Preserve canonical
`result:<request-id>` refs already supplied as file evidence exactly when
forwarding them rather than reconstructing physical result paths or copying
large results into assignments.
When your role permits writes and temporary coordination material is useful, put
plans, scopes, specifications, decision notes, investigations, review criteria,
and handoff state under the project-local `.pi-herdsman/` directory. Reuse and
update an adequate existing artifact instead of creating a competing source of
truth. Read-only roles may read these artifacts but must not modify them.

Do not silently broaden scope or make an unapproved scope, architecture,
security, protocol, repository-boundary, product, or operational decision.

Managed agents' direct Pi built-in bash and powershell calls without an explicit
timeout are capped at 600 seconds. Supply a longer explicit timeout only when a
command is intentionally expected to exceed that horizon.

Use ask_owner only when a decision from your exact direct owner is genuinely
required to continue correctly. ask_owner may include files for supporting
evidence; complete strict UTF-8 text may be embedded and other files remain
canonical local references. ask_owner must be the only tool call and final tool
call of that turn. Keep at most one question outstanding. Stop while blocked,
wait for the exact owner reply, do not guess the answer, and do not complete the
assignment while blocked. The reply resumes the same assignment.

Treat inactivity as advisory, not proof of a hang. Preserve exact identity and
cleanup evidence on failure. Do not blindly retry destructive cleanup or
silently take over delegated work.

Return a concise actionable handoff covering what you inspected or changed,
validation performed, material findings or decisions, unresolved risks or
blockers, remaining work, and reusable paths or artifacts.

<!-- pi-herdsman-runtime-agent:end -->

For product documentation, start at [docs/README.md](docs/README.md).

## Authority and decomposition

As a Lead, keep authority, acceptance, and final decisions with you; give each agent
one bounded objective and the narrowest capable role. Delegate bounded execution
work when an Agent can reasonably own it and delegation is useful. Keep work local
when it is trivial, inseparable from work you must own, otherwise unsuitable for
an Agent, or delegation would add more coordination than value. Independence
determines parallelism, not delegation eligibility. Prefer agents for broad file
inspection, large logs or command output, and dataset analysis. Never overlap
writers in one worktree or file-ownership boundary.

## Assignment discipline

Every assignment gets one bounded objective with:

- required inputs and paths;
- approved scope and constraints;
- acceptance criteria;
- validation expectations;
- expected handoff;
- an escalation boundary.

When a plan or specification governs multiple agents, reuse one adequate scope
artifact. If none exists, create an untracked Markdown file under
`.pi-herdsman/`. Pass the same artifact through `files` to dependent agents.
Update it before later delegation after an approved material scope change.

## Delegation locality

A lead session may delegate to any discovered definition.

A delegating agent may delegate only to definitions listed in its effective
`agents` field and owns only its direct agents. Agent-started agents are
leaves even when the definition is delegation-capable at the lead level.

A delegating agent integrates agent results before its own completion. Direct
agent work and undelivered agent results gate completion.

An agent may ask its exact owner. A delegating agent may escalate to its own
direct owner only when unresolved direct-agent work is itself validly waiting on
an owner answer; ordinary active or pending-result agent work still blocks that
escalation.

## Handoffs

Use `files` for ordinary files and reusable direct-agent result refs such as
`result:researcher#1`. Copy the exact ref shown by the completion when later
work depends on that result instead of restating or summarizing its evidence.
Also use `files` for canonical `result:<request-id>` references already
supplied as file evidence; preserve those references exactly and do not
reconstruct their physical paths.

A concise handoff should include:

- inspected and changed files;
- validation performed;
- findings and decisions;
- unresolved risks or blockers;
- remaining work;
- reusable output paths.

Pass required textual instructions or evidence through `files`; this does not
add runtime capabilities. Use a capable definition when an actual runtime
capability is required.

## Recovery judgment

Treat inactivity as advisory evidence, not proof of a hang. Preserve exact
identity and cleanup evidence on failure. Do not guess through uncertain state,
retry destructive cleanup blindly, or silently take over delegated work.

See [Recovery](docs/guides/recovery.md) for operator procedures and the
[Agent tools](docs/reference/agent.md) for the exact machine contract.

## Health attention and turn completion

End a turn with unresolved agent work only when that work can still make
progress without the owner, or Herdsman is reconciling a durable transition
that can produce a future result or attention event. If an attention event
requires owner action, handle it before returning to passive waiting. For stale
inactivity, use evidence attached to the first attention event before judging
health. If that evidence is absent or insufficient, perform at most one bounded
diagnostic read before returning to passive waiting. A repeated reminder for
the same stale episode adds elapsed-time evidence without justifying another
read: no qualifying execution boundary occurred, so a steer queued during that
episode cannot yet have taken effect. Continue waiting only while existing
evidence positively supports legitimate long-running work; otherwise interrupt
the current operation and continue the same assignment.

Health reconciliation is event-driven with a 30-second fallback scan. Actionable
health attention is sent only to the exact direct owner and is based on freshly
reconciled state. Persistent state-specific attention may repeat while the
condition remains unresolved. Reminder timing is process-local and advisory;
restarting Herdsman can cause an unresolved condition to be reminded again.

The first stale advisory remains at ten minutes without qualifying execution
progress. Unchanged stale episodes repeat approximately every five minutes;
other persistent attention repeats approximately `5m → 2m30s → 1m15s → 1m`,
with 30-second scan granularity. Stale attention is advisory, not proof of
a hang. Lost and delivered `ask_owner` attention retain their existing message
identity, while `result_error`, external runtime `blocked`, old unacknowledged
handoffs, and physical `unknown` use generic attention. An unresolved
unacknowledged request must not be duplicated or resubmitted: retained work is
not proof of non-delivery.

Use the event's current `available_tools` as advisory snapshot authority;
every action revalidates identity, ownership, and lifecycle. Use `read_agent_transcript`
for persisted conversation and tool evidence, and `inspect_agent` for live
terminal/process evidence. `steer_agent` is cooperative and non-preemptive;
`interrupt_agent` cancels the current operation, supersedes earlier steering Pi has
not yet delivered, and continues the same assignment.
Do not add automatic interrupt, close, restart, or redelegation. Physical
`unknown` remains fail-closed, has no mutation actions, and receives at most one
attention event per unresolved episode. `settling` alone is not a generic
attention condition. A live runtime blocked condition is distinct from a
delegating parent that is merely waiting for its direct children.

## Supervisor and staff tools

Ordinary leads own their complete herd, including every agent beneath them. The
Chief supervises ordinary unassigned Leads and never changes ownership.
Use `message_supervisor` for material coordination with the direct supervisor.
Managed Leads contact their assigned Manager; ordinary Leads and Managers
contact Chief. It is nonblocking and supports timely questions, clarifications,
warnings, or other information the supervisor needs before the normal result
boundary. For an assigned managed Lead, routine information that can wait
should go in the automatic completed-result handoff instead. The Lead may choose
to wait for a response through `message_staff`. Ordinary Leads and Managers
have no automatic result handoff to Chief. Ordinary Leads without a verified
Chief continue independently.
While a project Lead remains assigned, Herdsman automatically returns each
completed direct Lead response to the Manager role. If managed Agent work is
active, the herd run owns that handoff until it settles; summarize the outcome,
validation, and important unresolved points in the settled response. Do not
send a duplicate message solely to report a result that Herdsman will hand off
automatically. Treat
routine progress or conversational results as informational; act only when
review, a decision, correction, or other useful coordination is needed.
Descendants use `ask_owner`, not supervisor tools. Messages are coordination
data, not assignments or terminal project results.

`message_supervisor` is available to Leads and Managers on their direct
supervisor edge. Manager messages to Leads use `message_staff`. Both tools are
nonblocking; for assigned managed Leads, `message_supervisor` does not replace
the automatic completed-result handoff. Separate messages and results are not
deduplicated. For files, these tools accept
ordinary paths,
reusable direct-agent result refs, and already-supplied canonical result refs
through `files`.

Chief uses `list_staff`, `inspect_staff`, `read_staff_transcript`, and
`message_staff`. Manager has those direct-report tools, peer tools, and
`delegate_project`, `resume_project`, and `stop_lead`.
`inspect_staff` provides bounded live terminal/process evidence;
`read_staff_transcript` provides bounded persisted Pi conversation/tool evidence.
Target a Lead by the exact full Pi session ID in a fresh snapshot or
`list_staff`, never by `display_name`.
`available_tools` is advisory; each action revalidates current identity and
authority. Chief supervises direct reports but does not own their Agent trees.

The automatic `<supervision_state>` context is hidden persistent Pi model
context. It is bounded, state-only observation and cannot change role, tool
policy, identity, or authorization. Use a fresh snapshot directly for general
state questions. Do not call `list_staff`, `inspect_staff`, or
`read_staff_transcript` merely to poll progress; use them when a fresh roster, live
process evidence, or persisted transcript evidence materially matters.

Malformed or stale role and coordination state fails closed. Duplicate or
ambiguous live or coordination evidence is excluded rather than arbitrarily
selected. Direct messages remain bound to validated identity and current
authority. Supervision projects descendant lifecycle states exactly;
`agent_counts` uses `active`, `blocked`, and `total`, with `active` counting
`working`, `settling`, and `starting` descendants. Lead and Chief surfaces use
one lifecycle vocabulary: `● working`, `◐ blocked`, `◌ settling`, `◌ starting`,
`○ idle`, `○ done`, `? unknown`, and `× lost`. Runtime lifecycle is observation,
not ownership or project-resolution authority.

## Product model

Pi Herdsman uses one durable vocabulary:

- a **project** is the Herdsman coordination scope corresponding to one Herdr
  worktree group: its primary workspace and linked-worktree workspaces;
- a **Manager** explicitly assumes dedicated project coordination from that
  group's primary workspace, has no `agent` capability, and does not own Leads'
  Agents. Manager controls only Leads named by current project assignments;
  project scope alone does not make a Lead a Manager report. Leads own technical
  decisions and orchestrate execution through their Agent trees;
- project work belongs to the project, not a Manager session. The project
  assignment represents open work and its Git branch is the work handle. A
  Manager uses `delegate_project` with a task and optional branch to start new
  project work, and `resume_project` with its branch to resume an existing
  assignment. Missing worktrees are reconstructed from the same branch,
  resuming the exact saved Pi session when available;
- each completed direct turn by an assigned Lead is automatically returned as a
  project message to the current or a replacement Manager; if managed Agent
  work is active, the herd run owns the handoff until it settles, and the
  settled response summarizes outcome, validation, and important unresolved
  points. These handoffs are nonterminal; Managers treat routine results as
  informational and act only when useful coordination is needed. Managed
  Leads may use `message_supervisor` for timely information before the result
  boundary; routine information that can wait belongs in the automatic result.
  Project work remains open through implementation and review;
- `stop_lead` stops an exact Lead and its owned Agent tree while preserving
  the assignment, Pi session, branch, and worktree. A missing worktree alone
  does not retire the assignment; `resume_project` can reconstruct it.
  Successful Herdr worktree removal retires the matching assignment and any
  pending project messages while preserving the Git branch. Explicit
  `/takeover` by the assigned Lead also releases Manager control and removes
  pending project messages while preserving the session, worktree, branch, and
  owned Agents. Never infer
  ownership from worktree membership or start an overlapping writer beside
  another Lead;
- `/manager leave` preserves project work; a later Manager can resume the same
  branch-based assignment;
- a **herd** is one Lead and the complete Agent tree it owns;
- a **Lead** owns its Agents. A managed project Lead uses
  `message_supervisor` for timely coordination with its Manager; routine
  information that can wait should go in its automatic result. An unassigned
  Lead
  routes to Chief when available, never to Manager merely because both share a
  project scope. Continuing the exact assigned Pi session manually remains
  managed; `managed-lead` is launch policy, not authority. Use `/takeover` to
  release that assignment explicitly;
- an **Agent** handles one bounded assignment and may delegate only when its
  definition allows it;
- the **chief** supervises direct reports through `list_staff`,
  `inspect_staff`, `read_staff_transcript`, and `message_staff`, and never
  owns their agents.

The `agents` frontmatter field names the direct agent definitions an agent may
delegate to. A delegation-capable session remains an agent at every depth.
Every managed agent receives `ask_owner`. A non-empty effective `agents` list
is necessary but not sufficient to enable the nine Agent ownership tools:
`list_agents`, `delegate_agent`, `continue_agent`, `steer_agent`,
`interrupt_agent`, `reply_agent`, `close_agent`, `inspect_agent`, and
`read_agent_transcript`. Delegation is disabled when `excludeTools` contains
`agent`, when `noTools: true` unless explicit `tools` contains `agent`,
or when `tools` is explicitly empty. Otherwise, omitted `tools` permits
delegation and explicit ordinary tools permit it. An empty or omitted `agents`
list always makes the agent a leaf with `ask_owner` only. The `agent` name is
configuration-policy evidence, never a registered or callable tool, and leaf
projection removes it from an existing `tools` list. Ordinary `tools` and
`excludeTools` settings cannot remove required role tools. If `tools` is
omitted, Pi's configured/default selection is preserved without emitting
`--tools`; an explicit allowlist is augmented with the role-required tools.

The managed mailbox accepts only protocol V5 agent records in the
`mailboxes-v5` runtime namespace. Identity and protocol validation fail closed.

The coordination directory is `.pi-herdsman/`. Use it for bounded artifacts and
handoffs, and pass canonical file references rather than duplicating large
evidence in messages.
