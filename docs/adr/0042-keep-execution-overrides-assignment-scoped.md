# Keep execution overrides assignment-scoped

## Decision

Allow an authorized delegator to choose model and thinking settings for one
fresh assignment without changing the Agent definition. Keep the choice
opt-in and enforce the user's policy at runtime. By default, the policy
follows the caller's Pi scope; an explicit Herdsman selection takes precedence.
Continuation has no such inputs and retains its existing behavior under
[ADR 0004](0004-separate-delegation-from-continuation.md).

Herdsman owns assignment policy and authorization. Pi owns models, provider
resolution, thinking capabilities, and model defaults, consistent with
[ADR 0014](0014-use-integration-agnostic-orchestration-primitives.md). Selecting
a model without a thinking override leaves thinking to Pi for that model.

The live catalog reflects the same current policy used to validate a launch.
The session-start catalog is an advisory snapshot, not authorization. Keeping
it stable preserves reusable prompt context under
[ADR 0009](0009-preserve-prompt-cache-continuity.md).

## Rationale

A definition describes reusable responsibilities, capabilities, and execution
defaults. Assignments using the same definition may need different speed, cost,
or reasoning tradeoffs. Making those choices assignment inputs avoids copying
definitions or introducing persistent model routing in the orchestrator.
