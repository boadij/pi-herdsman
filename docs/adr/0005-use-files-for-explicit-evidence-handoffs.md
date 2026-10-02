# Use `files` for explicit evidence handoffs

## Decision

`files` is the single model-facing channel for explicitly transferring relevant
evidence across Herdsman coordination boundaries that support file evidence.

A recipient session does not implicitly inherit the sender's conversation,
attachments, or caller-local context. When the recipient's work or decision
depends on a user-supplied or already-available artifact, the sender passes that
artifact explicitly through `files`.

Historical context remains the responsibility of Pi session mechanisms such as
continuation or forking, not automatic attachment inheritance. Continuation
mechanisms that deliberately reuse an existing assignment or historical session
retain their own semantics; this decision does not imply that every lifecycle
operation accepts or requires `files`.

## Rationale

Implicit context inheritance makes it unclear which evidence a recipient
actually received and couples coordination to caller-local context that may not
exist in the recipient session.

A single explicit evidence channel keeps handoffs inspectable and lets ordinary paths, semantic result references, and already-received canonical artifacts flow through the same preparation pipeline.

## Alternatives considered

- Automatically inherit sender attachments and conversation context: rejected
  because coordination boundaries need an explicit evidence channel.
- Add a separate result-specific evidence API: rejected because `files` already provides the common model-facing attachment channel.

## Consequences

When the recipient's work or decision depends on relevant artifacts, senders
must pass them explicitly through `files`.

Result references remain valid evidence selectors within that channel.

Herdsman must not create hidden automatic attachment inheritance to compensate
for incomplete coordination messages.
