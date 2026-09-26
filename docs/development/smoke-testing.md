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
assignment unchanged. After both assignments finish, `agent_list` must show
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

## Managed-agent tool policy

Launch a delegating managed agent with an explicit ordinary execution-tool
allowlist and ask it to delegate one bounded scout task. Verify that it retains
those ordinary tools and can call all nine coordination tools plus
`ask_owner`, then verify that the spawned scout is a leaf with its normal tools
and `ask_owner` but no delegation tools. Also verify that role-required tools
are not removed by `excludeTools`.

For a definition with `tools` omitted, verify that launch does not add a
`--tools` option and Pi's configured/default selection remains in effect.
For an explicit `tools` list, verify that Pi receives the selected ordinary
tools augmented with the agent's required role tools. Confirm result delivery,
integration, and cleanup for all one-shot agents.

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
4. owner replies with exact `agent_reply`;
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
- does not poll `agent_list`;
- does not use `agent_inspect`, `agent_transcript`, or `agent_steer` merely to check progress;
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

Structured `agent_list` should still retain exact deterministic metadata.

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

- `agent_list` has no unintended managed agents;
- temporary global definitions are removed;
- temporary prompt/body files are removed;
- disposable herdr resources are closed by exact ID;
- no repository source file changed unless the smoke explicitly required it.

## Chief supervision live matrix

No live Pi/herdr smoke was run for the current worktree. Every scenario below
is **NOT RUN**, not a claim of failure or success. The automated tests are not
substitutes for these checks.

| Scenario                                                                                                                                                                       | Result  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Normal lead has Agent, supervisor, and peer semantic tools, not staff tools                                                                                                    | NOT RUN |
| Active Chief has exactly the five staff semantic tools, not lead controller tools                                                                                              | NOT RUN |
| Active Chief remains exactly `staff_*` after `/tree` restores a pre-Chief Lead branch                                                                                          | NOT RUN |
| Leaving Chief persists `role` plus exact `leadTools`; resume repairs stale restored `staff_*` before another model turn                                                        | NOT RUN |
| A legitimate ordinary branch loadout is preserved instead of being overwritten by an older `leadTools` checkpoint                                                              | NOT RUN |
| Persisted Chief resume collision becomes suspended                                                                                                                             | NOT RUN |
| Ordinary losing `/chief` collision remains a lead with its tools and offers Focus/Cancel                                                                                       | NOT RUN |
| Delegating agent and agent retain their current role tools                                                                                                                     | NOT RUN |
| Activate one Chief with `/chief`                                                                                                                                               | NOT RUN |
| Activation refuses a lead with owned or unresolved agent work                                                                                                                  | NOT RUN |
| Two exact simultaneous Chief claims have one winner                                                                                                                            | NOT RUN |
| Stale exact lease recovery                                                                                                                                                     | NOT RUN |
| Malformed role, lead state, lease, or descriptor fails closed; coordination publication invalidates stale state and disables actions                                           | NOT RUN |
| Discover leads across multiple workspaces                                                                                                                                      | NOT RUN |
| Exclude managed agents and the active Chief from leads                                                                                                                         | NOT RUN |
| Agent exclusion uses the production validated snapshot and stale/ambiguous generations fail closed                                                                             | NOT RUN |
| Herdr `agent_status` lifecycle normalization is reflected                                                                                                                      | NOT RUN |
| Nested agent aggregation attaches only to the proven lead                                                                                                                      | NOT RUN |
| A blocked agent does not mark its lead `needs you`                                                                                                                             | NOT RUN |
| Duplicate live agents, coordination records, or agent evidence fail closed                                                                                                     | NOT RUN |
| Target disappearance or replacement between list and action is rejected                                                                                                        | NOT RUN |
| Inspect a lead and compare bounded peek evidence                                                                                                                               | NOT RUN |
| Read `staff_transcript` when `transcript` is advertised; the action validates the persisted session header, version, and exact Pi session ID; content is bounded and read-only | NOT RUN |
| `staff_inspect` exposes live terminal/process evidence while `staff_transcript` exposes persisted conversation/tool evidence                                                   | NOT RUN |
| Focus a lead after exact revalidation                                                                                                                                          | NOT RUN |
| Chief `message` to idle, working, or blocked leads                                                                                                                             | NOT RUN |
| Two Chief messages queue and arrive once and in order                                                                                                                          | NOT RUN |
| A quarantined message does not block a new message to the same lead                                                                                                            | NOT RUN |
| Leads retain descendant ownership after a Chief `message`                                                                                                                      | NOT RUN |
| Lead `supervisor_message` reaches the active Chief                                                                                                                             | NOT RUN |
| Lead `supervisor_ask` reaches the active Chief and creates one pending ask                                                                                                     | NOT RUN |
| Pending ask projects as `needs_you` with bounded public question and exact reply action                                                                                        | NOT RUN |
| A second lead ask while one is pending is rejected                                                                                                                             | NOT RUN |
| Exact Chief `reply` reaches the lead and clears the ask after local acceptance                                                                                                 | NOT RUN |
| Pending ask remains replyable after chief replacement using the unchanged ask ID/current lease                                                                                 | NOT RUN |
| Failed ask queue restores the exact previous pending-ask state                                                                                                                 | NOT RUN |
| Metadata publication failure does not remove communication eligibility                                                                                                         | NOT RUN |
| Ordinary lead messages leave lead coordination state unchanged                                                                                                                 | NOT RUN |
| Follow-up delivery while the receiver is streaming, never steering                                                                                                             | NOT RUN |
| Receiver restart delivers each queued message once                                                                                                                             | NOT RUN |
| Accepted-before-delete crash deduplicates without reinjection                                                                                                                  | NOT RUN |
| Failed delivery/acceptance retains the queued record                                                                                                                           | NOT RUN |
| Transient authorization lookup failure retains the queued message                                                                                                              | NOT RUN |
| Stale lease, wrong sender/generation, duplicate identity, and malformed records fail closed                                                                                    | NOT RUN |
| Lead/Chief messages show bounded direction-aware model-visible sender and target identity                                                                                      | NOT RUN |
| Queued inbox records are ordered by `createdAt`, then ID                                                                                                                       | NOT RUN |
| Resume with a free or occupied lease                                                                                                                                           | NOT RUN |
| Confirm `/chief leave` without mutating supervised leads                                                                                                                       | NOT RUN |
| Suspended Chief retains no Herdsman authority tools                                                                                                                            | NOT RUN |
| Descendant `working`, `settling`, and `blocked` states remain exact; counts report `active`, `blocked`, and `total`                                                            | NOT RUN |
| Chief rows separate `!` attention from lifecycle: `●` working, `◐` blocked, `?` unknown, and `◉` delegated active descendants                                                  | NOT RUN |
| Empty-roster Escape closes the native custom UI                                                                                                                                | NOT RUN |
| Empty-roster Ctrl+C closes the native custom UI                                                                                                                                | NOT RUN |
| Real terminal arrow sequences navigate the visual order                                                                                                                        | NOT RUN |
| Space switches overview to peek and Escape/Space returns without nested custom UI                                                                                              | NOT RUN |
| Ctrl+C closes from peek                                                                                                                                                        | NOT RUN |
| Enter focuses the lead and closes the overview                                                                                                                                 | NOT RUN |
| Background refresh redraws the open overview                                                                                                                                   | NOT RUN |
| Ambient and overview rendering stay within the supplied width                                                                                                                  | NOT RUN |
| Named herdr sockets independently support one Chief each                                                                                                                       | NOT RUN |

Named herdr socket independence is also **NOT RUN** because no live Pi/herdr
runtime was available for this worktree.

The automated test gate is the available evidence for this worktree; see
[Validation](validation.md).
