# Recovery

[Documentation index](../README.md)

Recovery is identity-safe and conservative. Use the public state and returned
structured error before attempting another mutation.

## Agent is `blocked`

A blocked agent still has an active assignment.

If the agent is waiting for an owner answer, use `reply` with its exact agent.

Otherwise resolve the reported external/attention condition. Do not delegate new
task to a blocked agent.

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
marks retry as unsafe and exact-owner cleanup as safe.

## Agent is `unknown`

`unknown` means the system cannot prove a safe control state from current exact
evidence.

Do not guess from pane IDs, process appearance, elapsed time, or stale metadata.

Refresh `list` and resolve the identity/lifecycle condition. If a cleanup or
recovery error is present, inspect its exact details.

## Inactivity advisory

A `working` agent with an exact active assignment can become advisory `stale`
after ten minutes without observed Pi turn, message, or tool activity.

Possible list fields:

- `stale: true`
- `inactive_ms`
- `last_activity_at`

This is not proof that the agent is hung, dead, safe to terminate, or safe to
replace.

Do not close solely because of inactivity.

## Startup failure

Fresh and historical-session delegation startup is bounded.

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

## Cleanup or rollback failure

A `rollback_failure` can contain both:

- the primary launch/control failure;
- the cleanup failure.

Preserve both. The `nextAction` field may direct you to inspect cleanup evidence
before retrying.

A later attempt should not reuse a label or resource whose ownership is still
uncertain.

## Close failure

Normal `agent close` targets one exact directly owned live agent.

Closing a delegating agent cascades through its owned agents first. If a
agent cannot be proved or closed safely, the delegating agent remains rather
than being destructively guessed away.

For lead-only human emergency cleanup, `/agents stop` operates on the proven
owned tree and reports discarded active work or durable pending results. It is
not the normal model orchestration interface.

## Historical session failure

A `delegate` with `session` requires an exact session path or full UUID.

The saved session header must contain a non-empty working directory. Session
delegation uses that saved cwd and does not accept a caller-supplied `cwd`.

The saved agent-definition name and logical label are restored from the managed
session identity. If the definition no longer exists, session delegation fails
instead of guessing a replacement; a missing or malformed session identity also
fails closed. The definition must also be enabled and authorized for the current
controller, and its current effective configuration is used for the new agent
generation. A continuation cannot override or regenerate its saved label.

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
