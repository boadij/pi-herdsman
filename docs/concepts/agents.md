# Agents and identity

[Documentation index](../README.md)

A managed agent is a Pi session whose physical lifecycle is owned by herdr and
whose assignment lifecycle is coordinated through the extension mailbox.

## The identities are intentionally different

### Agent definition

The **agent definition** selects the agent's model, reasoning policy, tools,
skills, extensions, prompt body, context inheritance, and allowed direct
agents.

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

Use the exact `agent` value from `agent list` only for
`steer.agent`, `reply.agent`, or `close.agent` while those actions are listed
in `available_actions`. An agent label is the live execution identity for one
assignment, not a continuation handle.

Labels must begin with a lowercase letter, contain only lowercase letters,
digits, `_`, or `-`, and be at most 32 characters.

### Pi session identity

Every managed agent has an exact Pi session. The list may expose the session
ID and path for correlation.

A session path or full UUID can be supplied to the `continue` action to continue
historical work. Continuation creates a new agent generation for one new
assignment and uses the saved session's cwd, definition, logical label, and
historical context. The caller cannot rename the continued session. The Pi
session remains the continuation identity, not a live-control identity. An
exact active or unresolved managed representation blocks concurrent activation
of that session.

### herdr identities

Workspace, tab, pane, generated herdr-agent alias, run ID, and process evidence
exist to prove physical ownership and safe cleanup.

They are not public alternatives to the `agent` identity.

## Ownership

Each agent has one exact direct owner Pi session.

A lead Pi session owns its direct agents.

A delegating agent may own direct agents when its effective definition has
allowed `agents`.

Public list visibility follows this ownership boundary. Lead recovery may expose
a proven orphan descendant only when durable ownership and exact absence of its
former delegating agent are established.

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
conversational context, use `continue` with the exact session ID or session path
returned with the result. This creates a new agent generation, which uses the
current effective authorized configuration for the saved agent definition. To
derive a separate context instead, use `fork` on a `delegate` action.

The identities are therefore:

```text
agent definition → configuration for new work
Pi session       → durable conversational context and continuation identity
agent label     → live control identity for one assignment
```

## See also

- [Pi Herdsman](supervision.md) for the separate supervision model.
- [Lifecycle](lifecycle.md)
- [Delegation](delegation.md)
- [Agent states](../reference/agent-states.md)
- [`agent` API](../reference/agent.md)
