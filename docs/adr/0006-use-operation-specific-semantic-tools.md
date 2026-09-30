# Use operation-specific semantic coordination tools

## Decision

Pi Herdsman will expose narrow operation-specific model tools such as `agent_delegate`, `agent_continue`, and `agent_close` instead of multiplexed tools whose schema contains fields for several actions.

Internal dispatch, lifecycle, authorization, and recovery logic may remain shared behind thin adapters, but the model-facing schema for each operation must advertise only the inputs that operation accepts.

Obsolete multiplexed model APIs do not require compatibility aliases.

## Rationale

Multiplexed tools required flattened provider-safe schemas that exposed fields belonging to other actions. Some model and provider paths materialized those advertised optional fields, after which Herdsman rejected otherwise valid calls for containing fields invalid for the selected action.

Runtime input projection reduced the symptom but preserved the mismatch between what the schema advertised and what the chosen action actually accepted.

Operation-specific tools remove that mismatch at the model boundary.

## Alternatives considered

- Keep multiplexed tools with flattened schemas: rejected because advertised cross-action fields produced repeated invalid calls on strict provider paths.
- Keep multiplexed tools and canonicalize away irrelevant fields at runtime: rejected as a compatibility workaround after narrow semantic tools could express the real contract directly.

## Consequences

Each coordination operation owns a small schema with genuinely relevant fields.

Shared implementation remains internal and must not force a multiplexed public interface.

Breaking model-facing cleanup is preferable to maintaining obsolete aliases when the old shape no longer represents the intended contract.
