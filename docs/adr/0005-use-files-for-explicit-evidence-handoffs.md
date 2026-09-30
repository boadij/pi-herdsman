# Use files for explicit Agent evidence handoffs

## Decision

Pi Herdsman will use `files` as the single model-facing channel for explicit assignment evidence.

Fresh Agents do not implicitly inherit the caller's conversation, attachments, or surrounding context. Controllers must pass relevant user-supplied or already-available artifacts through `files` when that evidence is needed by a fresh or updated assignment.

Historical context remains the responsibility of Pi session mechanisms such as continuation or forking, not automatic attachment inheritance.

## Rationale

Implicit context inheritance makes it unclear which evidence an Agent actually received and couples fresh assignments to caller-local context that may not exist in the child session.

A single explicit evidence channel keeps handoffs inspectable and lets ordinary paths, semantic result references, and already-received canonical artifacts flow through the same preparation pipeline.

## Alternatives considered

- Automatically inherit caller attachments and conversation context: rejected because fresh Agent sessions intentionally have an explicit context boundary.
- Add a separate result-specific evidence API: rejected because `files` already provides the common model-facing attachment channel.

## Consequences

Assignment instructions must name needed artifacts explicitly through `files`.

Result references remain valid evidence selectors within that channel.

Herdsman must not create hidden automatic attachment inheritance to compensate for incomplete delegation prompts.
