# Workers and identity

[Documentation index](../README.md)

A managed worker is a Pi session whose physical lifecycle is owned by herdr and
whose assignment lifecycle is coordinated through the extension mailbox.

## The identities are intentionally different

### Agent definition

The **agent definition** selects the worker's model, reasoning policy, tools,
skills, extensions, prompt body, context inheritance, and allowed direct
workers.

Example: `reviewer`.

Definitions are configuration, not live worker identity.

### Logical worker identity

The internal label is projected publicly as the `worker` identity for a live
worker.

Examples:

```text
reviewer
reviewer-2
my-review
```

Use the exact `worker` value from `worker list` only for
`steer.worker`, `reply.worker`, or `close.worker` while those actions are listed
in `available_actions`. A worker label is the live execution identity for one
assignment, not a continuation handle.

Labels must begin with a lowercase letter, contain only lowercase letters,
digits, `_`, or `-`, and be at most 32 characters.

### Pi session identity

Every managed worker has an exact Pi session. The list may expose the session
ID and path for correlation.

A session path or full UUID can be supplied as `delegate.session` to continue
historical work. It is the continuation identity, not a live-control identity.
Session delegation creates a new worker generation for one new assignment and
uses the saved session's cwd and historical context. An exact active or
unresolved managed representation blocks concurrent activation of that session.

### herdr identities

Workspace, tab, pane, generated herdr-agent alias, run ID, and process evidence
exist to prove physical ownership and safe cleanup.

They are not public alternatives to the `worker` identity.

## Ownership

Each worker has one exact direct owner Pi session.

A lead Pi session owns its direct workers.

A delegating worker may own direct workers when its effective definition has
allowed `workers`.

Public list visibility follows this ownership boundary. Lead recovery may expose
a proven orphan descendant only when durable ownership and exact absence of its
former delegating worker are established.

## Authority boundaries

Different systems answer different questions:

| Authority     | Owns                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------- |
| herdr         | Physical process/pane lifecycle, placement, live agent observations                      |
| Mailbox       | Assignment acknowledgement, active/completed request identity, pending ask, final result |
| Pi            | Session history, turns, messages, model interaction                                      |
| Logical label | Internal durable worker identity, projected publicly as `worker`                         |

The mailbox `ResultRecord` is the persisted completion record and carries the
identity needed to match its worker state. The owner-session delivery entry is
a separate, wider record: it also carries delivery metadata such as `cwd` and
the Pi session file. Those records are checked against their respective
identity requirements; `ResultRecord` is not intended to mirror the complete
delivery-entry shape.

If a result cannot be persisted after bounded retries, the worker state carries
a correlated `result_error` recovery condition instead of becoming assignable.

A safe control operation requires these sources to agree. Missing or conflicting
evidence fails closed rather than guessing.

## Worker generations and continuation

Every managed worker generation executes exactly one delegated assignment. Its
terminal result is delivered once, then the worker's pane, process, mailbox,
and runtime state are cleaned up. Failed assignments follow the same terminal
cleanup path.

The Pi session remains available after worker cleanup. To continue the same
conversational context, delegate a new assignment with the exact session ID or
session path returned with the result. This creates a new worker generation,
which uses the current effective authorized configuration for the saved agent
definition. To derive a separate context instead, use `fork` on a definition
delegation.

The identities are therefore:

```text
agent definition → configuration for new work
Pi session       → durable conversational context and continuation identity
worker label     → live control identity for one assignment
```

## See also

- [Pi Herdsman](supervision.md) for the separate supervision model.
- [Lifecycle](lifecycle.md)
- [Delegation](delegation.md)
- [Worker states](../reference/worker-states.md)
- [`worker` API](../reference/worker.md)
