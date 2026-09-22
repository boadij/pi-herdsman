# Recovery

[Documentation index](../README.md)

Recovery is identity-safe and conservative. Use the public state and returned
structured error before attempting another mutation.

## Health attention

Health attention is sent to the exact direct owner after fresh reconciliation
of mailbox and Herdr state. It is event-driven with a 30-second fallback scan,
and it is published only when the owner is idle. Read the exact condition and
the event's current `available_actions` before acting; the eventual action
rechecks identity, ownership, mailbox state, and lifecycle.

Use this decision sequence:

1. Need persisted conversation or tool history? Use `transcript`.
2. Need live terminal or process evidence? Use `inspect`.
3. Is the work healthy or legitimately long-running? Leave it alone.
4. Is a cooperative correction needed? Use `steer`.
5. Must the current operation itself be abandoned? Use `interrupt`; it cancels
   that operation, supersedes earlier undelivered steering, and continues the
   same assignment.
6. Is the assignment being abandoned? Use `close`.
7. Is an owner decision pending? Use `reply` for the exact pending question.

Persistent actionable conditions may repeat approximately `5m → 2m30s →
1m15s → 1m`, with 30-second scan granularity. Reminder state is process-local
and advisory, not durable mailbox state. Health attention is direct-owner-only;
do not poll, add a second delivery path, or keep a turn alive solely to wait.
Do not intervene solely because a stale threshold was reached.

The generic attention reasons are `result_error`, live runtime `blocked`, old
unacknowledged `handoff`, and physical `unknown`. Stale, lost, and delivered
`ask_owner` conditions retain their dedicated message types. A retained
unacknowledged request must not be duplicated or resubmitted: timeout or lack
of acknowledgement does not prove non-delivery. `settling` alone does not
generate generic attention.

## Agent is `blocked`

A blocked agent still has an active assignment.

If the agent is waiting for an owner answer, use `reply` with its exact agent.

Otherwise inspect the reported external/runtime condition and resolve it using
only the currently listed actions. A live Herdr runtime reported as `blocked`
may generate health attention when no `ask_owner` question exists. This is
different from a delegating parent whose public projection is `blocked` while
it waits for direct child work; parent waiting is not, by itself, evidence of
an externally blocked runtime. Do not delegate a new task to a blocked agent.

## Agent is `settling`

`settling` means assignment convergence is incomplete. Typical causes include:

- task handoff acknowledgement;
- result delivery;
- bounded result-persistence recovery;
- delegating-agent/agent completion gating;
- launch handoff;
- one-shot cleanup.

Do not delegate another task yet.

If nothing independent remains, end the turn normally and let result/attention
delivery returns attention to the owner. Refresh `list` only when there is a reason to take
another control action.

If `list` reports `result_error`, the agent's result could not be persisted
after bounded retries. The condition retains the run, request, owner, agent,
and failure category. Do not delegate over it: resolve the mailbox persistence
problem, then close the exact agent before delegating new work. The condition
marks retry as unsafe and exact-owner cleanup as safe. It may also produce
direct-owner `result_error` attention; use its stored recovery details and
`nextAction` rather than inventing a separate persistence recovery.

## Agent is `unknown`

`unknown` means the system cannot prove a safe control state from current exact
evidence.

Do not guess from pane IDs, process appearance, elapsed time, or stale metadata.

Physical `unknown` remains fail-closed: it has no mutation actions and receives
at most one generic attention event for an unresolved episode. Do not infer
loss, guess a pane or process, or use `ask_owner` as a generic escalation path.
Refresh `list` and resolve the identity/lifecycle condition when new exact
evidence is available. If a cleanup or recovery error is present, inspect its
exact details.

## Agent is `lost`

`lost` means the expected physical execution is proven gone before a durable
terminal result resolved the assignment. The durable mailbox remains owned and
the assignment remains unresolved; loss is not completion or task failure.
Only the direct owner may use `close` to abandon the lost generation. When
`close` is listed, use it before replacing it or continuing its saved session.
If `close` is absent, resolve the condition blocking its close preflight first.
Herdsman never redelegates or continues it automatically. Moved or conflicting
evidence is `unknown`, not `lost`, and remains fail-closed.

## Inactivity advisory

A `working` agent with an exact active assignment can become advisory `stale`
after ten minutes without qualifying execution progress. Model streaming,
turn/message boundaries, and tool execution start/end boundaries count;
streaming tool updates alone do not reset progress.

Possible list fields:

- `stale: true`
- `inactive_ms`
- `last_activity_at`

This is not proof that the agent is hung, dead, safe to terminate, or safe to
replace.

Do not close or interrupt solely because of inactivity. A stale advisory may
repeat while the same condition remains unresolved, but healthy or legitimately
long-running work should be left alone. Use `transcript` for persisted evidence
and `inspect` for live evidence; use `steer` for cooperative correction and
`interrupt` only when the current operation itself must be abandoned; it
cancels that operation, supersedes earlier undelivered steering, and continues
the same assignment.

Proven lost work remains unresolved and may receive repeated direct-owner
attention until it is resolved or the exact owner closes it. Physical
disappearance is not completion.

## Startup failure

Fresh delegation and historical-session continuation startup is bounded.

When herdr returns a structured failure, Pi Herdsman preserves it. When startup
returns empty or malformed output and no better structured error is available,
the implementation can capture one bounded exact-pane diagnostic snapshot
within the startup budget.

Failures report the known stage and identities when available.

Ownership-safe rollback removes only resources whose identity can be proved.
If ownership cannot be proved, cleanup intentionally fails closed and preserves
evidence.

Do not "fix" this by manually deleting guessed panes or mailboxes.

## `pane_not_ready`

A pane-readiness failure means the managed agent did not reach the required
safe startup boundary.

The normal response is to inspect the returned stage/diagnostic and the current
herdr environment. Do not add client-side polling or arbitrary sleeps as an
operator workaround.

Managed Herdr panes must be able to reach their interactive shell prompt
without requiring human input. Shell startup that waits for a question,
confirmation, first-run wizard, credential prompt, or similar interaction can
prevent agent startup.

Herdr sets `HERDR_ENV=1` in pane processes, so shell configuration can use that
marker to disable interactive startup behavior only inside Herdr.

For example, with Oh My Zsh, place this before sourcing Oh My Zsh:

```zsh
[[ ${HERDR_ENV:-} == 1 ]] && zstyle ':omz:update' mode disabled
```

Normal terminals keep their configured update behavior; Herdr panes skip
automatic Oh My Zsh update checks. Run `omz update` manually when desired.

If startup still fails, inspect the returned `pane_readiness` stage and bounded
pane diagnostic rather than adding arbitrary sleeps or automatically answering
terminal prompts.

## Cleanup or rollback failure

A `rollback_failure` can contain both:

- the primary launch/control failure;
- the cleanup failure.

Preserve both. The `nextAction` field may direct you to inspect cleanup evidence
before retrying.

A later attempt should not reuse a label or resource whose ownership is still
uncertain.

## Close failure

Normal `agent close` targets one exact directly owned live agent or a directly
owned generation proven `lost` by fresh absence evidence. Unknown presence
fails closed.

Closing a delegating agent cascades through its owned agents first. If a
agent cannot be proved or closed safely, the delegating agent remains rather
than being destructively guessed away.

For lead-only human emergency cleanup, `/agents stop` operates on the proven
owned tree and reports discarded active work or durable pending results. It is
not the normal model orchestration interface.

## Historical session failure

A `continue` requires an exact session path or full UUID.

The saved session header must contain a non-empty working directory. Session
continuation uses that saved cwd and does not accept a caller-supplied `cwd`.

The saved agent-definition name and logical label are restored from the managed
session identity. If the definition no longer exists, continuation fails instead
of guessing a replacement; a missing or malformed session identity also fails
closed. The definition must also be enabled and authorized for the current
controller, and its current effective configuration is used for the new agent
generation. Omitted model and thinking fields restore the saved session
settings; explicit definition fields override them. Continuation cannot
override or regenerate its saved label.

An exact session that is already represented by active or unresolved managed
work cannot be activated concurrently. The session-start exclusion applies to
the canonical session path, so an exact UUID and its exact path identify the
same target. Wait for the existing assignment to finish and clean up, or close
its exact live agent when abandoning it, then retry. Do not delegate another
task through an agent label.

## Before retrying

Check:

1. exact error category;
2. operation;
3. agent identity;
4. known pane/session IDs;
5. startup stage when present;
6. primary cause;
7. cleanup cause;
8. `rollbackOccurred`;
9. `nextAction`;
10. current `agent list`.

## See also

- [Errors](../reference/errors.md)
- [Agent states](../reference/agent-states.md)
- [Agents and identity](../concepts/agents.md)
