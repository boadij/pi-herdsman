# Agents and identity

[Documentation index](../README.md)

A managed agent is a Pi session whose physical lifecycle is owned by herdr and
whose assignment lifecycle is coordinated through the extension mailbox.

## The identities are intentionally different

### Agent definition

The **agent definition** may override the agent's model and reasoning policy,
and selects its tools, skills, extensions, prompt body, context inheritance,
and allowed direct agents. Fresh agents otherwise inherit model and thinking
from their spawning controller session.

Example: `reviewer`.

Definitions are configuration, not live agent identity.

### Logical agent identity

The internal label is projected publicly as the `agent` identity for a live
agent.

Examples:

```text
reviewer
reviewer-2
my-review
```

Use the exact `agent` value from `agent_list` only for
the `agent` parameter to `agent_inspect`, `agent_transcript`, `agent_steer`,
`agent_interrupt`, `agent_reply`, or `agent_close` while those actions are listed
in `available_tools`. An agent label is the stable logical name across
sequential generations of one managed session, not a continuation selector.
It is a control target only for the currently live generation.

Labels must begin with a lowercase letter, contain only lowercase letters,
digits, `_`, or `-`, and be at most 32 characters.

### Pi session identity

Every managed agent has an exact Pi session. The list may expose the session
ID and path for correlation.

A session path or full UUID can be supplied to `agent_continue` to continue
historical managed-agent work. Continuation creates a new agent generation for
one new assignment and uses the saved session's cwd, definition, logical label, and
historical context. The caller cannot rename the continued session. The Pi
session remains the continuation identity, not a live-control identity. An
exact active or unresolved managed representation blocks concurrent activation
of that session.

### herdr identities

Workspace, tab, pane, generated herdr-agent alias, run ID, and process evidence
exist to prove physical ownership and safe cleanup.

They are not public alternatives to the `agent` identity.

## Ownership

A lead and its recursively owned agent hierarchy form a **herd**, Herdsman's term for an agent fleet.

Each agent has one exact direct owner Pi session.

A lead Pi session owns its direct agents.

A delegating agent may own direct agents when its effective definition has
allowed `agents`.

Public list visibility follows this ownership boundary. A lead sees only
generations whose durable owner chain resolves to that lead. Durable descendants
remain attached to their recorded parent even when that parent is lost or
physically unresolved. Missing, ambiguous, or cyclic durable ancestry is not
attributed to a herd.

## Authority boundaries

Different systems answer different questions:

| Authority     | Owns                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------- |
| herdr         | Physical process/pane lifecycle, placement, live agent observations                      |
| Mailbox       | Assignment acknowledgement, active/completed request identity, pending ask, final result |
| Pi            | Session history, turns, messages, model interaction                                      |
| Logical label | Internal durable agent identity, projected publicly as `agent`                           |

The mailbox `ResultRecord` is the persisted completion record and carries the
identity needed to match its agent state. The owner-session delivery entry is
a separate, wider record: it also carries delivery metadata such as `cwd` and
the Pi session file. Those records are checked against their respective
identity requirements; `ResultRecord` is not intended to mirror the complete
delivery-entry shape.

If a result cannot be persisted after bounded retries, the agent state carries
a correlated `result_error` recovery condition instead of becoming assignable.

A safe control operation requires these sources to agree. Missing or conflicting
evidence fails closed rather than guessing.

## Agent generations and continuation

Every managed agent generation executes exactly one delegated assignment. Its
terminal result is delivered once, then the agent's pane, process, mailbox,
and runtime state are cleaned up. Failed assignments follow the same terminal
cleanup path.

The Pi session remains available after agent cleanup. To continue the same
conversational context, use `agent_continue` with the exact session ID or session path
returned with the result. This creates a new agent generation, which restores
the saved session's model and thinking unless the current definition
explicitly overrides either field. Fresh delegation does not inherit the
caller's conversation; pass assignment-specific evidence through task text and
`files`.

The identities are therefore:

```text
agent definition → configuration for new work
Pi session       → durable conversational context and continuation identity
agent label     → stable logical name across sequential generations; live control target only for the current generation
```

## See also

- [Pi Herdsman](supervision.md) for the separate supervision model.
- [Lifecycle](lifecycle.md)
- [Delegation](delegation.md)
- [Agent states](../reference/agent-states.md)
- [Agent tools](../reference/agent.md)
