# `ask_owner` API

[Documentation index](../README.md)

`ask_owner` is mandatory managed agent infrastructure for one direct-owner
decision required to continue the current assignment.

It is not a generic messaging channel.

## Availability

Every valid managed agent receives the `ask_owner` tool at launch.

Normal definition `tools`, `excludeTools`, and `noTools` policy cannot remove
this infrastructure capability.

## Request

```json
{
  "question": "Should I use option A or option B?",
  "files": [".pi-herdsman/options.md", "diagram.png"]
}
```

`question` must contain non-whitespace text.
`files` supplies supporting evidence using the same rules as `agent`: complete
strict UTF-8 text may be embedded, while other files are canonical local
references and are not copied or snapshotted. Relative paths use the agent's
working directory. This does not weaken the sole-final-tool-call rule.

## Turn rule

`ask_owner` must be:

- the agent's only tool call in the turn;
- the final tool call of the turn.

The agent then stops and waits.

A call made alongside another tool call is rejected.

## Eligibility

An agent can ask only while it has a valid active assignment and:

- has no outstanding ask;
- has no completed/final result pending;
- has no pending state transition;
- has no unacknowledged owner request;
- has no ordinary unresolved direct-agent work.

A delegation-enabled agent may ask its own owner when its unresolved direct
agents are themselves validly blocked on owner questions. Ordinary active
agents and pending agent results still block escalation.

## Durable effect

On acceptance, Pi Herdsman creates one correlated ask record and sets
`pendingAskId` while preserving the original active assignment request ID.

The tool result tells the agent that the assignment is blocked and returns
details containing:

```text
askId
assignmentRequestId
```

The agent public state projects as `blocked` after the turn settles.

Final assignment settlement is disabled while the ask remains pending.

## Owner delivery

The exact direct owner receives the question through the existing owner-session
delivery path.

The system does not automatically forward an agent question through an ownership
chain.

If a delegating agent needs a lead decision, it independently calls `ask_owner`
on its own direct ownership edge.

## Reply

The direct owner answers through the `agent` tool:

```json
{
  "action": "reply",
  "agent": "<exact agent>",
  "message": "Use option B."
}
```

The reply is correlated to:

- ask ID;
- original assignment request ID;
- run ID;
- owner session;
- workspace;
- agent label;
- pane;
- Pi session.

A mismatched or stale reply fails closed.

The agent clears the pending ask, acknowledges the reply request, and resumes
the same assignment with the owner answer.

## One outstanding question

Only one `ask_owner` question may be outstanding per assignment at a time.

There is no ask timeout.

The agent must not guess the owner answer and complete while blocked.

Rejected calls identify the known eligibility reason, such as no active
assignment, an existing owner question, settling state, a pending control
request, or active direct-agent work.

## Close

Closing the agent abandons the pending question as part of agent teardown.

## See also

- [`agent` `reply`](agent.md#reply)
- [Lifecycle](../concepts/lifecycle.md)
- [Delegation](../concepts/delegation.md)
