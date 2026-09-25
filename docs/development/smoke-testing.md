# Smoke testing

[Documentation index](../README.md)

These are maintainer acceptance checks for behavior that benefits from a real
Pi/herdr boundary.

Use disposable agents and exact-ID cleanup. Do not disturb unrelated user
workspaces or agents.

## Preconditions

Verify:

```sh
node --version
pi --version
herdr status --json
herdr integration status
```

The `herdr status --json` output is the Herdr 0.9 CLI protocol compatibility
preflight. It must report a Herdr client version of `>=0.9.1`,
`server.running` as `true`, and `server.compatible` as `true`.

The supported repository contract requires:

- Node `>=22.19.0`
- Pi `>=0.87.0 <0.88.0`
- herdr `>=0.9.1`

Run focused tests and other intermediate checks before this smoke suite. Do
not format during smoke testing; complete smoke testing and review before the
final formatting and read-only verification sequence in
[Development validation](validation.md).

## Current mailbox contract

For a current managed run, inspect the persisted state, request, ask, and
result records and verify they use protocol version `4` and contain no lifetime
field. Control prompts use the `__PI_HERDSMAN_AGENT_V4__:` marker prefix.

## One-shot definition and session continuation

Delegate a small deterministic read-only task to the `scout` definition. Record
the returned agent, request, session, and pane identities.

Verify:

- one managed agent starts;
- the task is acknowledged;
- the agent completes with exactly one result reaching the owner;
- the terminal result identifies the exact session;
- cleanup removes the agent, pane, mailbox, and runtime;
- the exact Pi session remains available.

Use the exact returned session ID or path for a follow-up assignment:

```json
{
  "action": "continue",
  "session": "<exact session>",
  "task": "Continue the investigation with one short follow-up."
}
```

Verify:

- the same Pi session and session file are used;
- a new agent generation, run ID, request ID, and pane are created;
- the saved logical label is reused exactly (there is no continuation label override);
- the saved conversation context is available;
- the current effective definition configuration is used, with omitted model and
  thinking fields restoring the saved session settings;
- exactly one result reaches the owner;
- cleanup removes the second agent, pane, mailbox, and runtime.

While the continuation assignment is active, submit another `continue` request
for the same exact session. Verify it fails with
`agent_busy`, creates no duplicate agent or pane, and leaves the active
assignment unchanged. After both assignments finish, `agent list` must show
no completed idle agent.

## Historical session continuation

Use an exact saved session path or full UUID.

Verify:

- saved definition and cwd are respected;
- the saved logical label is reused exactly;
- session continuation uses the saved cwd;
- current effective agent override values are used for the new agent
  generation;
- the exact session continues.

## Inferred delegation

Use a bundled delegating agent definition whose source `tools` list does not explicitly
contain `agent`, such as the current `implementer`.

Ask it to delegate one bounded scout task.

Verify:

- the real Pi agent can call `agent`;
- agent result reaches the delegating agent;
- delegating agent integrates it once;
- all one-shot agents clean up.

This proves effective-definition inference reaches Pi launch policy rather than
only metadata.

## Body reference expansion

Create a temporary global definition with a whole-line body reference:

```markdown
---
name: generalist
bodyMode: append
---

@../temporary-policy.md
```

Use a distinctive instruction in the referenced file.

Verify the agent obeys that instruction through the expanded private prompt.

Afterward remove the temporary definition and referenced file, confirm discovery
no longer lists the temporary definition, and verify no repository file changed.

## `ask_owner` round trip

Give an agent a task whose correct continuation requires an owner choice.

Verify:

1. agent calls `ask_owner` alone;
2. owner receives one question;
3. agent becomes `blocked`;
4. owner replies with exact `agent reply`;
5. reply continues the same assignment;
6. agent produces exactly one final result;
7. no agent/mailbox leak remains.

## Delegating-agent turn ending

Ask a delegation-enabled controller to delegate required reconnaissance when no
other concrete, necessary independent work is known.

Inspect the actual transcript and verify the delegating agent:

- ends its turn after the assignment when nothing else useful is independently actionable;
- does not repeat the delegated reconnaissance locally;
- does not manufacture adjacent analysis merely to remain active;
- does not delegate substantially overlapping reconnaissance to another agent;
- does not poll `agent list`;
- does not use `agent inspect`, `agent transcript`, or `agent steer` merely to check progress;
- does not send "finish", "status", or equivalent progress nudges to a healthy
  agent;
- does not sleep or use another mechanism to keep the turn alive;
- the agent result resumes the controller session;
- integrates the result into one final delegating agent outcome.

## Useful concurrency

Delegate bounded task A and give the controller concrete, necessary independent
local task B.

Verify:

- B proceeds while A is active;
- B does not repeat A's assigned scope;
- once B is sufficiently complete, the controller reassesses instead of
  manufacturing more work;
- if further useful progress depends on A, the controller ends its turn;
- A's result resumes the controller and is integrated.

Also verify a controller with two already-known independent delegated objectives
may delegate A and B before ending its turn. It must not create a third
assignment merely to increase concurrency.

## Lead `/agents` commands

In a lead session with UI:

### `/agents definitions`

Verify the native Definitions selector shows:

- bundled, project (when trusted project discovery is enabled), and global
  definitions in the effective roster;
- project participation marked `[project]`, with `*` for a global override
  (`[project] *` means both layers contribute);
- compact, aligned name/model/thinking columns, including Unicode names;
- model, thinking, enabled, and details actions for a selected definition;
- `Inherit current session` for model and thinking;
- narrow panes remain width-safe.

Structured `agent list` should still retain exact deterministic metadata.

Select a disposable bundled, project, or global definition and change its
model, thinking, and enabled state. Confirm that project discovery requires Pi
project trust and that these edits write global overrides only, not project
files.

Verify unrelated frontmatter and body remain unchanged, `Inherit current session`
removes only the selected field, fresh definition delegations inherit the
spawning controller's current value, continuations restore the saved session's
value, and running agents are not mutated.

### `/agents placement`

Open the native selector, change to the alternate value, verify, then restore
the original value.

### `/agents stop`

With disposable owned agents, verify the owned tree closes while an unrelated
herdr agent remains untouched.

## Failure diagnostics

Use a disposable invalid resource/launch configuration only when safe.

Verify startup failure:

- settles within the bounded budget;
- reports the stage and best available diagnostic;
- performs exact ownership-safe rollback;
- does not leave a false successful agent.

## Cleanup checklist

After every smoke:

- `agent list` has no unintended managed agents;
- temporary global definitions are removed;
- temporary prompt/body files are removed;
- disposable herdr resources are closed by exact ID;
- no repository source file changed unless the smoke explicitly required it.

## Project Manager / Chief supervision live matrix

No live Pi/Herdr smoke was run for this worktree. Every scenario below is
**NOT RUN**; automated tests are not substitutes for these checks. Use a
disposable Herdr worktree group and branch. Manager runs from the group's
primary workspace and coordinates the group, not one worktree per Lead. Multiple
Leads can share one workspace; do not count those sessions as separate
worktrees. Do not delete the delegated linked-worktree workspace as part of
completion.

Minimum live sequence:

1. Open a Herdr worktree group's primary workspace and start Pi; verify it starts
   as an ordinary Lead with `agent`, `supervisor`, and `peer`, but no `staff`.
2. With an owned Agent still unresolved, attempt `/manager`; verify activation
   is refused and the Lead retains its Agent controls. After resolving that
   work, activate `/manager`; verify the exclusive project lease is claimed, the
   distinct Manager coordination profile is active, `agent` is removed, and
   `staff`, `supervisor`, and `peer` plus ordinary project tools remain available,
   with bounded direct-Lead context and no Agent-definition roster/instructions.
   Verify its status header says `manager` (not `chief`) and reports direct
   Leads as Leads. Restart this Manager session and verify the same Manager
   profile, UI, context, and tool set return without Lead Agent-roster discovery
   or Lead-owned Agent recovery.
3. Open a Lead in a linked-worktree workspace and verify `/manager` is unavailable. Attempt
   activation from a second primary-workspace session while Manager is active;
   verify it remains an ordinary Lead with no automatic elevation.
4. Delegate a disposable branch/task with Manager `staff.delegate`; verify
   Herdr creates a linked-worktree workspace in the same group and Pi starts
   in its pane only after the shell is ready. Verify Manager-created Pi receives
   `--session-id <assignment-id>` and the trust flag selected from the
   Manager's `ctx.isProjectTrusted()` decision: trusted Manager means
   `--approve` (not `--no-approve`), untrusted Manager means `--no-approve`
   (not `--approve`). Verify this does not modify Pi's persistent trust store
   or elevate trust beyond the Manager's current decision. Also verify a
   delayed shell does not trigger an early `agent start`. Exercise
   startup while Herdr reports a path whose initial session JSONL does not yet
   exist: Lead coordination state under the assignment ID should complete
   verification without waiting for that file, and a resolvable Herdr session
   identity must match the assignment ID. Inspect the live Pi pane/process during
   startup with trust-protected project resources in both Manager trust states:
   with a trusted Manager, verify Pi loads those protected resources; with an
   untrusted Manager, verify Pi uses `--no-approve` and skips those protected
   resources. Do not treat this as a claim that all project-local files are
   skipped. Confirm neither case writes the linked-worktree path to Pi's
   persistent trust store.
   Ask Manager to describe its topology: it should identify one Herdr worktree
   group from the primary workspace and the delegated branch's linked Git
   worktree/workspace. When multiple Lead sessions share a workspace, confirm
   Manager distinguishes those sessions from separate worktrees.
5. Stall or simulate a lost create response for a delegation on `manager1`'s
   branch. While it remains unresolved, delegate `manager2` on a different
   branch and verify it starts independently. Verify a same-branch request
   conflicts with `manager1`; while its phase is `creating` or `starting`, the
   message directs recovery through `staff.delegate assignment=<id>`. Recover
   `manager1` using exactly
   `{"action":"delegate","assignment":"<id>"}` with `task`, `branch`,
   `base`, and `files` omitted; confirm no duplicate worktree or Pi is
   created. Verify a fresh delegation rejects an already-existing Herdr
   worktree on its branch rather than adopting its Lead. `staff.list`, inspect,
   transcript, message, and reply remain observational and never resume
   creation or remove assignments. During explicit recovery, verify a
   persisted placement is retired only when authoritative Herdr topology proves
   its worktree absent. Confirm the abandonment result says the branch
   reservation was released and permits a fresh delegation retry; uncertain
   topology fails closed. Confirm retries reuse the exact persisted base ref
   token (default `HEAD`), but do not imply that
   the token freezes a moving ref or identifies an immutable commit.
   Also verify that a conflict with an `active` or `settling` assignment directs
   the Manager to `staff list`, identifies the existing Lead session when
   available, and does not recommend `staff.delegate` recovery.
6. Verify `staff.list` shows that exact Lead and the assignment's branch name.
   Verify the Lead has `agent`, `supervisor`, and `peer`, and sees no Agents as
   peers.
7. Send a nonterminal `supervisor.message` from the Lead; verify Manager handles
   the inbound message locally and does not echo it to Chief via `supervisor`.
   Confirm the assignment remains active. Then complete the task with Lead
   `supervisor.result`; verify Manager receives `result:<assignment-id>`, the
   assignment settles/removes after accepted delivery, and the result ref can be
   passed to another Lead through `files`.
8. Activate Chief with `/chief` in another eligible Lead session; verify its
   roster and automatic state include both the Manager and direct Leads from
   another project without a Manager, not actionable nested Leads in the
   managed project. Direct targeting of a nested Lead fails.
9. Replace a Manager without changing the supervision edge; verify the
   replacement can answer the existing Lead ask after fresh validation. Then
   change the Lead's supervisor edge and verify the old ask cannot be rerouted.
10. Verify Manager peers see Managers and Lead peers see Leads; neither role
    appears in the other peer roster. Leave Manager with `/manager leave` and
    verify leave is refused with an active assignment, an ask from a Lead, and
    separately with the Manager's own pending ask to Chief.
    Resolve/answer them, leave, and verify its Lead tools/profile return and the
    lease is released.
11. Restart Manager once during an active assignment; verify the Lead remains
    alive and the replacement Manager rediscovers/reconciles it. Verify result
    completion leaves the worktree in place.

| Scenario                                                                                                                                                                                                                 | Result  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Session starts as ordinary Lead; `/manager` enters Manager only from primary workspace                                                                                                                                   | NOT RUN |
| `/manager leave` refuses outstanding assignments, incoming asks, and its own pending ask to Chief; once clear restores Lead profile/tools                                                                                | NOT RUN |
| Manager activation refuses while this session owns unresolved Agents                                                                                                                                                     | NOT RUN |
| Lead in linked-worktree workspace cannot enter Manager; competing Manager claim leaves caller ordinary Lead                                                                                                              | NOT RUN |
| Chief remains separate; Manager cannot activate `/chief`; Chief has exactly `staff`                                                                                                                                      | NOT RUN |
| Manager uses distinct coordination profile with `staff`, `supervisor`, `peer`, ordinary project tools, and no `agent`                                                                                                    | NOT RUN |
| Manager gets direct-Lead context and Manager status header; direct reports are Leads, not Managers                                                                                                                       | NOT RUN |
| Manager role contract identifies one worktree group from primary workspace; multiple Leads in one workspace are not separate worktrees                                                                                   | NOT RUN |
| Restored Manager returns to same profile/UI/context/tools; no Lead Agent roster discovery or Agent recovery                                                                                                              | NOT RUN |
| Manager cannot own Agents or perform local implementation; `/manager leave` restores Lead profile and `agent`                                                                                                            | NOT RUN |
| Lead has `agent`, `supervisor`, `peer`, and no `staff`; Agent has no `peer`                                                                                                                                              | NOT RUN |
| Manager `staff.delegate` creates a linked-worktree workspace in the same group and starts Pi in the exact pane                                                                                                           | NOT RUN |
| Manager Lead uses the assignment UUID as Pi `--session-id`; Lead state verifies under that ID without waiting for the initial session JSONL path to exist; resolvable Herdr ID matches                                   | NOT RUN |
| Missing persisted worktree on explicit recovery reports the branch reservation released and allows fresh delegation                                                                                                      | NOT RUN |
| Requested branch is retained; omitted branch is derived from assignment ID, persisted before creation, and passed explicitly to Herdr                                                                                    | NOT RUN |
| Exact base ref token (default `HEAD`) is persisted with branch and reused on recovery; moving refs are not described as frozen commits                                                                                   | NOT RUN |
| Different branches can be delegated independently while another assignment is unresolved; same branch has at most one creating/starting/active/settling assignment                                                       | NOT RUN |
| Same-branch `creating`/`starting` conflicts guide exact-ID `staff.delegate` recovery; `active`/`settling` conflicts direct to `staff list` and identify the Lead session when available                                  | NOT RUN |
| Fresh delegation never adopts an existing Herdr worktree/Lead                                                                                                                                                            | NOT RUN |
| `staff.list` reports each assignment's branch without task text; reads never resume mutations or remove assignments                                                                                                      | NOT RUN |
| Explicit recovery uses the exact `{"action":"delegate","assignment":"<id>"}` key, retains persisted inputs, and creates no duplicate worktree/Pi                                                                         | NOT RUN |
| Explicit recovery retires a persisted placement only when authoritative topology proves its worktree absent; uncertain topology fails closed                                                                             | NOT RUN |
| Manager startup waits for delayed pane shell readiness and retains startup ownership/topology checks                                                                                                                     | NOT RUN |
| Manager-created Pi inherits `ctx.isProjectTrusted()`: trusted uses `--approve` and loads trust-protected project resources; untrusted uses `--no-approve` and skips those resources; persistent trust store is unchanged | NOT RUN |
| Manager roster sees the exact delegated Lead and ordinary manually created Leads in its worktree group                                                                                                                   | NOT RUN |
| Lead sees only its project-group direct reports; Manager cannot act on Agent IDs                                                                                                                                         | NOT RUN |
| Lead `supervisor.ask` routes to active Manager; Manager ask routes to Chief                                                                                                                                              | NOT RUN |
| Manager handles inbound direct-Lead messages locally and does not echo them through `supervisor`                                                                                                                         | NOT RUN |
| Without an active Manager, Lead `supervisor` routes to Chief                                                                                                                                                             | NOT RUN |
| Same-edge supervisor replacement can answer pending ask after fresh validation                                                                                                                                           | NOT RUN |
| Hierarchy-edge change cannot reroute an existing pending ask                                                                                                                                                             | NOT RUN |
| `supervisor.message` is nonterminal progress/coordination and does not settle the assignment                                                                                                                             | NOT RUN |
| Lead `supervisor.result` completes assignment, persists provenance and `result:<assignment-id>` before Manager notification                                                                                              | NOT RUN |
| Manager receives result ref; assignment settles/removes after acceptance while canonical artifact and worktree remain                                                                                                    | NOT RUN |
| Manager restart during active assignment rediscovers Lead and reconciles ask/result                                                                                                                                      | NOT RUN |
| Chief staff roster lists Managers when active; direct Lead supervision remains available without Manager                                                                                                                 | NOT RUN |
| Chief roster and automatic supervision state include Managers and direct Leads from projects without a Manager                                                                                                           | NOT RUN |
| With an active Manager, Chief has no simultaneous direct authority over its project Leads                                                                                                                                | NOT RUN |
| Chief cannot message, inspect, or reply to a nested Lead session ID                                                                                                                                                      | NOT RUN |
| Manager peers see Managers; Lead peers see Leads; no project filter; no Agents or Chief peers                                                                                                                            | NOT RUN |
| Uncertain creation is reconciled by branch and Herdr topology; no second branch/workspace is created                                                                                                                     | NOT RUN |
| `/manager leave` is refused with assignments, Manager-addressed asks, or its own pending ask to Chief                                                                                                                    | NOT RUN |
| Herdr metadata displays roles but does not grant authority                                                                                                                                                               | NOT RUN |

This worktree has no recorded live smoke result. Run the matrix against real Pi
and Herdr before merge; see [Development validation](validation.md) for the
required final validation order.
