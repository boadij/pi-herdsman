# Preserve prompt-cache continuity

## Decision

Pi Herdsman will treat preservation of reusable model-request prefixes as a
first-class architectural constraint.

Where semantics permit, model-visible context should evolve without changing
content that was already sent in earlier requests. Existing conversation
history, instructions, and tool definitions should remain stable, and new
state should be appended rather than inserted into, reordered within, or used
to rewrite an existing reusable prefix.

Durable append-only context is therefore preferred over request-local context
transformations when both can express the same semantics. Dynamic content
should remain after stable reusable context where supported by Pi and the
provider contract.

This is an efficiency constraint, not a correctness mechanism. Correctness,
security, durable-state integrity, and supported Pi or Herdr contracts take
precedence, and Herdsman must never depend on a cache hit for correct behavior.

Provider-specific cache controls or breakpoints may be used when useful, but
Herdsman's semantic session state must not depend on a particular provider's
cache implementation.

## Rationale

Prompt caching reduces repeated model-input processing and can materially
reduce latency and provider cost during long-running Agent work.

Major model providers implement caching around reusable prompt prefixes. A
conversation that grows by appending new turns can therefore reuse progressively
more of its prior input, while changing earlier content reduces or invalidates
that reuse.

This matters especially for Herdsman because long-lived coding Agents can carry
large conversation histories, tool results, instructions, and repository
context. A small avoidable change near the front or middle of that context can
force substantially more input to be processed again on every later request.

Request-local transformations can also undermine continuity even when their
text is constant. If equivalent content is repeatedly inserted after an
ever-growing history, the previous complete request is no longer a prefix of
the next one. Persisting that content once allows later turns to extend it
naturally.

Prompt caching does not reduce the logical context size and cache hits are not
guaranteed. The architectural goal is therefore to avoid unnecessarily
preventing reuse, not to assume or require it.

## Alternatives considered

- Treat prompt caching as a provider implementation detail: rejected because
  Herdsman's context structure directly determines how much provider-side work
  can be reused and therefore affects recurring latency and cost.
- Require all model context to be permanently immutable: rejected because
  compaction, recovery, security, and other correctness requirements can
  legitimately require context changes.
- Build the architecture around one provider's explicit caching API: rejected
  because providers expose different caching controls while stable reusable
  prefixes are the common underlying property.

## Consequences

Features that alter model-visible context must consider whether they
unnecessarily disturb an existing reusable prefix.

Appending new conversation state is the default. Rewriting, reordering, or
inserting into earlier model-visible history requires a semantic reason rather
than implementation convenience.

Unnecessary changes to tool definitions, ordering, or leading instructions
should likewise be avoided when stable equivalents exist.

Compaction, truncation, recovery, model changes, dynamic tool exposure, and
other justified operations may reduce cache continuity. That is acceptable
when their semantic benefit outweighs cache reuse.

Cache performance may be measured and optimized independently, but no lifecycle
or correctness rule may rely on a particular provider returning a cache hit.
