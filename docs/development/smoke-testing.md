# Smoke testing

[Documentation index](../README.md)

These are maintainer acceptance checks for behavior that benefits from a real
Pi/herdr boundary.

Use disposable workers and exact-ID cleanup. Do not disturb unrelated user
workspaces or agents.

## Preconditions

Verify:

```sh
node --version
pi --version
herdr --version
herdr integration status
```

The supported repository contract requires:

- Node `>=22.19.0`
- Pi `>=0.84.2 <0.86.0`
- herdr `>=0.8.0`
- herdr Pi integration version `2` or newer

Run the repository validation gate first.

## Current mailbox contract

For a current managed run, inspect the persisted state, request, ask, and
result records and verify they use protocol version `3` and contain no lifetime
field. Control prompts use the `__PI_HERDSMAN_WORKER_V3__:` marker prefix.

## One-shot definition and session continuation

Delegate a small deterministic read-only task to the `scout` definition. Record
the returned worker, request, session, and pane identities.

Verify:

- one managed worker starts;
- the task is acknowledged;
- the worker completes with exactly one result reaching the owner;
- the terminal result identifies the exact session;
- cleanup removes the worker, pane, mailbox, and runtime;
- the exact Pi session remains available.

Use the exact returned session ID or path for a follow-up assignment:

```json
{
  "action": "delegate",
  "session": "<exact session>",
  "task": "Continue the investigation with one short follow-up."
}
```

Verify:

- the same Pi session and session file are used;
- a new worker generation, run ID, request ID, and pane are created;
- the saved conversation context is available;
- the current effective definition configuration is used;
- exactly one result reaches the owner;
- cleanup removes the second worker, pane, mailbox, and runtime.

While the continuation assignment is active, submit another
`delegate.session` request for the same exact session. Verify it fails with
`worker_busy`, creates no duplicate worker or pane, and leaves the active
assignment unchanged. After both assignments finish, `worker list` must show
no completed idle worker.

## Historical session delegation

Use an exact saved session path or full UUID.

Verify:

- saved definition and cwd are respected;
- session delegation uses the saved cwd;
- current effective agent override values are used for the new worker
  generation;
- the exact session continues.

## Fork

Delegate to a definition with `fork` pointing to an exact saved session.

Verify:

- a new worker/session is created;
- the fork source is explicit;
- the current controller session is not implicitly used.

## Inferred delegation

Use a bundled delegating worker definition whose source `tools` list does not explicitly
contain `worker`, such as the current `implementer`.

Ask it to delegate one bounded scout task.

Verify:

- the real Pi worker can call `worker`;
- worker result reaches the delegating worker;
- delegating worker integrates it once;
- all one-shot workers clean up.

This proves effective-definition inference reaches Pi launch policy rather than
only metadata.

## Body reference expansion

Create a temporary global definition with a whole-line body reference:

```markdown
---
name: worker
bodyMode: append
---

@../temporary-policy.md
```

Use a distinctive instruction in the referenced file.

Verify the worker obeys that instruction through the expanded private prompt.

Afterward remove the temporary definition and referenced file, confirm discovery
no longer lists the temporary definition, and verify no repository file changed.

## `ask_owner` round trip

Give a worker a task whose correct continuation requires an owner choice.

Verify:

1. worker calls `ask_owner` alone;
2. owner receives one question;
3. worker becomes `blocked`;
4. owner replies with exact `worker reply`;
5. reply continues the same assignment;
6. worker produces exactly one final result;
7. no worker/mailbox leak remains.

## Delegating-worker natural waiting

Ask a delegating worker to delegate required reconnaissance when no useful independent
local work remains.

Inspect the actual transcript and verify the delegating worker:

- ends its turn normally after the assignment;
- does not poll `worker list`;
- does not sleep or use a separate wait mechanism;
- wakes when the worker result is delivered;
- integrates the result into one final delegating worker outcome.

## Useful concurrency

Give a delegating worker one delegated task A and independent local task B.

Verify it can work on B while A is active, then ends its turn when no useful
independent work remains and integrates A after result delivery.

## Lead `/workers` commands

In a lead session with UI:

### `/workers agents`

Verify the native Definitions selector shows:

- bundled, project (when trusted project discovery is enabled), and global
  definitions in the effective roster;
- project participation marked `[project]`, with `*` for a global override
  (`[project] *` means both layers contribute);
- compact, aligned name/model/thinking columns, including Unicode names;
- model, thinking, enabled, and details actions for a selected definition;
- `Use default` for model and thinking;
- narrow panes remain width-safe.

Structured `worker list` should still retain exact deterministic metadata.

Select a disposable bundled, project, or global definition and change its
model, thinking, and enabled state. Confirm that project discovery requires a
trusted project's `piHerdsman.projectAgents: true` setting and that these edits
write global overrides only, not project files.

Verify unrelated frontmatter and body remain unchanged, `Use default` removes
only the selected field, fresh definition delegations and session continuations
use the current effective value, and running workers are not mutated.

### `/workers placement`

Open the native selector, change to the alternate value, verify, then restore
the original value.

### `/workers stop`

With disposable owned workers, verify the owned tree closes while an unrelated
herdr agent remains untouched.

## Failure diagnostics

Use a disposable invalid resource/launch configuration only when safe.

Verify startup failure:

- settles within the bounded budget;
- reports the stage and best available diagnostic;
- performs exact ownership-safe rollback;
- does not leave a false successful worker.

## Cleanup checklist

After every smoke:

- `worker list` has no unintended managed workers;
- temporary global definitions are removed;
- temporary prompt/body files are removed;
- disposable herdr resources are closed by exact ID;
- no repository source file changed unless the smoke explicitly required it.

## Chief supervision live matrix

No live Pi/herdr smoke was run for the current worktree. Every scenario below
is **NOT RUN**, not a claim of failure or success. The automated tests are not
substitutes for these checks.

| Scenario                                                                                                                             | Result  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| Normal lead has `worker` and `chief`, not `staff`                                                                                    | NOT RUN |
| Active Chief has exactly `staff`, not lead controller tools                                                                          | NOT RUN |
| Persisted Chief resume collision becomes suspended                                                                                   | NOT RUN |
| Ordinary losing `/chief` collision remains a lead with its tools and offers Focus/Cancel                                             | NOT RUN |
| Delegating worker and worker retain their current role tools                                                                         | NOT RUN |
| Activate one Chief with `/chief`                                                                                                     | NOT RUN |
| Activation refuses a lead with owned or unresolved worker work                                                                       | NOT RUN |
| Two exact simultaneous Chief claims have one winner                                                                                  | NOT RUN |
| Stale exact lease recovery                                                                                                           | NOT RUN |
| Malformed role, lead state, lease, or descriptor fails closed; coordination publication invalidates stale state and disables actions | NOT RUN |
| Discover leads across multiple workspaces                                                                                            | NOT RUN |
| Exclude managed workers and the active Chief from leads                                                                              | NOT RUN |
| Worker exclusion uses the production validated snapshot and stale/ambiguous generations fail closed                                  | NOT RUN |
| Herdr `agent_status ?? status` lifecycle normalization is reflected                                                                  | NOT RUN |
| Nested worker aggregation attaches only to the proven lead                                                                           | NOT RUN |
| A blocked worker does not mark its lead `needs you`                                                                                  | NOT RUN |
| Duplicate live agents, coordination records, or worker evidence fail closed                                                          | NOT RUN |
| Target disappearance or replacement between list and action is rejected                                                              | NOT RUN |
| Inspect a lead and compare bounded peek evidence                                                                                     | NOT RUN |
| Focus a lead after exact revalidation                                                                                                | NOT RUN |
| Chief `message` to idle, working, or blocked leads                                                                                   | NOT RUN |
| Two Chief messages queue and arrive once and in order                                                                                | NOT RUN |
| A quarantined message does not block a new message to the same lead                                                                  | NOT RUN |
| Leads retain descendant ownership after a Chief `message`                                                                            | NOT RUN |
| Lead `chief message` reaches the active Chief                                                                                        | NOT RUN |
| Lead `chief ask` reaches the active Chief and creates one pending ask                                                                | NOT RUN |
| Pending ask projects as `needs_you` with bounded public question and exact reply action                                              | NOT RUN |
| A second lead ask while one is pending is rejected                                                                                   | NOT RUN |
| Exact Chief `reply` reaches the lead and clears the ask after local acceptance                                                       | NOT RUN |
| Pending ask remains replyable after chief replacement using the unchanged ask ID/current lease                                       | NOT RUN |
| Failed ask queue restores the exact previous pending-ask state                                                                       | NOT RUN |
| Metadata publication failure does not remove communication eligibility                                                               | NOT RUN |
| Ordinary lead messages leave lead coordination state unchanged                                                                       | NOT RUN |
| Follow-up delivery while the receiver is streaming, never steering                                                                   | NOT RUN |
| Receiver restart delivers each queued message once                                                                                   | NOT RUN |
| Accepted-before-delete crash deduplicates without reinjection                                                                        | NOT RUN |
| Failed delivery/acceptance retains the queued record                                                                                 | NOT RUN |
| Transient authorization lookup failure retains the queued message                                                                    | NOT RUN |
| Stale lease, wrong sender/generation, duplicate identity, and malformed records fail closed                                          | NOT RUN |
| Lead/Chief messages show bounded direction-aware model-visible sender and target identity                                            | NOT RUN |
| Queued inbox records are ordered by `createdAt`, then ID                                                                             | NOT RUN |
| Resume with a free or occupied lease                                                                                                 | NOT RUN |
| Confirm `/chief leave` without mutating supervised leads                                                                             | NOT RUN |
| Empty-roster Escape closes the native custom UI                                                                                      | NOT RUN |
| Empty-roster Ctrl+C closes the native custom UI                                                                                      | NOT RUN |
| Real terminal arrow sequences navigate the visual order                                                                              | NOT RUN |
| Space switches overview to peek and Escape/Space returns without nested custom UI                                                    | NOT RUN |
| Ctrl+C closes from peek                                                                                                              | NOT RUN |
| Enter focuses the lead and closes the overview                                                                                       | NOT RUN |
| Background refresh redraws the open overview                                                                                         | NOT RUN |
| Ambient and overview rendering stay within the supplied width                                                                        | NOT RUN |
| Named herdr sockets independently support one Chief each                                                                             | NOT RUN |

Named herdr socket independence is also **NOT RUN** because no live Pi/herdr
runtime was available for this worktree.

The automated test gate is the available evidence for this worktree; see
[Validation](validation.md).
