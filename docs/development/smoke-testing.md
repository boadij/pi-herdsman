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

## Fork

Delegate to a definition with `fork` pointing to an exact saved session.

Verify:

- a new agent/session is created;
- the fork source is explicit;
- the current controller session is not implicitly used.

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
disposable Herdr worktree group and branch. Do not delete the delegated
linked-worktree workspace as part of completion.

Minimum live sequence:

1. Open a Herdr worktree group's primary workspace and start Pi; verify it starts
   as an ordinary Lead with `agent`, `supervisor`, and `peer`, but no `staff`.
2. With an owned Agent still unresolved, attempt `/manager`; verify activation
   is refused and the Lead retains its Agent controls. After resolving that
   work, activate `/manager`; verify the exclusive project lease is claimed, the
   distinct Manager coordination profile is active, `agent` is removed, and
   `staff`, `supervisor`, and `peer` plus ordinary project tools remain available,
   with bounded direct-Lead context and no Agent-definition roster/instructions.
3. Open a Lead in a linked-worktree workspace and verify `/manager` is unavailable. Attempt
   activation from a second primary-workspace session while Manager is active;
   verify it remains an ordinary Lead with no automatic elevation.
4. Delegate a disposable branch/task with Manager `staff.delegate`; verify
   Herdr creates a linked-worktree workspace in the same group and Pi starts
   in its pane only after the shell is ready. Also verify a delayed shell does
   not trigger an early `agent start`.
5. Interrupt or simulate a lost create response; verify `staff.list`, inspect,
   transcript, message, and reply only show/observe state and never resume
   creation. Verify an unrelated delegate request is rejected while the
   assignment is unresolved. Explicit recovery must retain its original task,
   branch, and base; verify a branch that exists but is unopened is recovered
   with Herdr `worktree open --branch ... --no-focus`.
6. Verify `staff.list` shows that exact Lead. Verify the Lead has `agent`,
   `supervisor`, and `peer`, and sees no Agents as peers.
7. Send `supervisor.ask` from the Lead; answer via Manager `staff.reply`.
   Complete with Lead `supervisor.result`; verify Manager receives
   `result:<assignment-id>` and can pass it to another Lead through `files`.
8. Activate Chief with `/chief` in another eligible Lead session; verify its
   roster and automatic state include both the Manager and direct Leads from
   another project without a Manager, not actionable nested Leads in the
   managed project. Direct targeting of a nested Lead fails.
9. Replace a Manager without changing the supervision edge; verify the
   replacement can answer the existing Lead ask after fresh validation. Then
   change the Lead's supervisor edge and verify the old ask cannot be rerouted.
10. Verify Manager peers see Managers and Lead peers see Leads; neither role
    appears in the other peer roster. Leave Manager with `/manager leave` and
    verify leave is refused with an active assignment or Manager-addressed ask.
    Resolve/answer them, leave, and verify its Lead tools/profile return and the
    lease is released.
11. Restart Manager once during an active assignment; verify the Lead remains
    alive and the replacement Manager rediscovers/reconciles it. Verify result
    completion leaves the worktree in place.

| Scenario                                                                                                                              | Result  |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| Session starts as ordinary Lead; `/manager` enters Manager only from primary workspace                                                | NOT RUN |
| `/manager leave` refuses outstanding assignments/asks; once clear, releases lease and restores Lead profile and exact Lead tools      | NOT RUN |
| Manager activation refuses while this session owns unresolved Agents                                                                  | NOT RUN |
| Lead in linked-worktree workspace cannot enter Manager; competing Manager claim leaves caller ordinary Lead                           | NOT RUN |
| Chief remains separate; Manager cannot activate `/chief`; Chief has exactly `staff`                                                   | NOT RUN |
| Manager uses distinct coordination profile with `staff`, `supervisor`, `peer`, ordinary project tools, and no `agent`                 | NOT RUN |
| Manager gets bounded direct-Lead context without Lead Agent-definition roster/instructions; status shows Manager supervision          | NOT RUN |
| Manager cannot own Agents or perform local implementation; `/manager leave` restores Lead profile and `agent`                         | NOT RUN |
| Lead has `agent`, `supervisor`, `peer`, and no `staff`; Agent has no `peer`                                                           | NOT RUN |
| Manager `staff.delegate` creates a linked-worktree workspace in the same group and starts Pi in the exact pane                        | NOT RUN |
| Requested branch is retained; omitted branch is derived from assignment ID, persisted before creation, and passed explicitly to Herdr | NOT RUN |
| Selected base is persisted with branch before creation and remains fixed on every recovery                                            | NOT RUN |
| Reads never resume create/start; unrelated delegation is rejected while prior creation/start is unresolved                            | NOT RUN |
| Explicit recovery reuses original task/branch/base and recovers an unopened existing branch with Herdr `worktree open`                | NOT RUN |
| Manager startup waits for delayed pane shell readiness and retains startup ownership/topology checks                                  | NOT RUN |
| Manager roster sees the exact delegated Lead and ordinary manually created Leads in its worktree group                                | NOT RUN |
| Lead sees only its project-group direct reports; Manager cannot act on Agent IDs                                                      | NOT RUN |
| Lead `supervisor.ask` routes to active Manager; Manager ask routes to Chief                                                           | NOT RUN |
| Without an active Manager, Lead `supervisor` routes to Chief                                                                          | NOT RUN |
| Same-edge supervisor replacement can answer pending ask after fresh validation                                                        | NOT RUN |
| Hierarchy-edge change cannot reroute an existing pending ask                                                                          | NOT RUN |
| Lead `supervisor.result` persists provenance and `result:<assignment-id>` before Manager notification                                 | NOT RUN |
| Manager receives result ref; assignment clears after acceptance while canonical artifact and worktree remain                          | NOT RUN |
| Manager restart during active assignment rediscovers Lead and reconciles ask/result                                                   | NOT RUN |
| Chief staff roster lists Managers when active; direct Lead supervision remains available without Manager                              | NOT RUN |
| Chief roster and automatic supervision state include Managers and direct Leads from projects without a Manager                        | NOT RUN |
| With an active Manager, Chief has no simultaneous direct authority over its project Leads                                             | NOT RUN |
| Chief cannot message, inspect, or reply to a nested Lead session ID                                                                   | NOT RUN |
| Manager peers see Managers; Lead peers see Leads; no project filter; no Agents or Chief peers                                         | NOT RUN |
| Uncertain creation is reconciled by branch and Herdr topology; no second branch/workspace is created                                  | NOT RUN |
| `/manager leave` is refused with outstanding assignments or Manager-addressed asks                                                    | NOT RUN |
| Herdr metadata displays roles but does not grant authority                                                                            | NOT RUN |

This worktree has no recorded live smoke result. Run the matrix against real Pi
and Herdr before merge; see [Development validation](validation.md) for the
required final validation order.
