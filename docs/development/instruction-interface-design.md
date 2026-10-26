# Instruction and Interface Design Principles

[Documentation index](../README.md)

Herdsman should minimize cognitive complexity for agents, users, and maintainers while preserving a complete, explicit, and reliable operational contract.

These principles apply to the repository as a whole, including runtime behavior, agent orchestration, instructions, tools, schemas, state, validation, documentation, tests, and public interfaces.

## Minimize model decision burden

Models should spend their judgment on the user's task, not on interpreting
Herdsman's interfaces, reconstructing known state, or choosing among redundant
ways to act.

Before exposing a choice, determine whether user intent, the effective role,
authoritative state, or existing policy already settles it. If so, derive the
value, supply the relevant context, apply a clear default, or narrow the
available actions instead of requiring the model to decide. This applies across
tools, schemas, instructions, context, and workflows, not just role definitions.

Keep alternatives when choosing among them genuinely requires task judgment or
user preference. Fewer tools, shorter prompts, and more restrictive roles are
not ends in themselves; hiding evidence or useful actions, guessing when state
is uncertain, or adding delegation overhead can increase the burden instead.

For each model-facing change, ask: **Which decision does this leave to the
model, and does that decision require its judgment?**

## Compose model-facing context for salience

Information placement can affect how reliably models use long context:
relevant material may be easier to use at the beginning or end than in the
middle ([Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/)).
This is a tendency, not an instruction hierarchy. Position alone does not
change instruction authority or make newer evidence binding.

When composing new model-facing context, clearly delimit supporting material
and, where semantics permit, place the current task or decision request and
its essential constraints near the end. Preserve meaningful source order,
provenance, and established instruction precedence. Avoid burying critical
information in lengthy middle sections or duplicating it solely for recency.

Optimize at composition time, not by rewriting previously delivered context.
Preserve reusable prompt prefixes and append-only Pi history per
[ADR 0009](../adr/0009-preserve-prompt-cache-continuity.md).
Prefer clear, deterministic composition over attention scoring or
provider-specific ordering heuristics.

## One invariant, one meaning

Every behavioral invariant should have one authoritative meaning. Runtime
behavior and authoritative runtime contracts define operational semantics;
skills, documentation, examples, and tests project those contracts rather
than independently redefining them.

The same invariant may appear in multiple surfaces when reinforcement, discoverability, validation, local context, or timing requires it. This includes deliberate reinforcement at model-facing decision points where salience materially improves reliability.

Every representation must preserve the same semantics. When practical, projections of the same invariant should derive from or reuse one canonical source rather than independently paraphrasing it.

When representations drift or conflict, fix the underlying invariant and its projections rather than adding clarification around the inconsistency.

## Keep replaceable definitions strategy-only

Bundled Agent and role definition bodies describe specialization,
discretionary working strategy, priorities, and output expectations.

Operational contracts belong to authoritative runtime instructions,
tool descriptions, schemas, validated state, and runtime enforcement.
Definition bodies must not independently define tool semantics,
parameter usage, authorization, evidence propagation, or lifecycle rules.

Replacing a bundled definition body must not remove essential
operational meaning.

Definition frontmatter remains the supported configuration surface
for launch policy and capabilities. Custom user instructions remain
subject to the established definition composition rules.

## Fix ambiguity at the source

When behavior is confusing or error-prone, identify the earliest source of ambiguity and correct it there.

Do not compensate for unclear state, interfaces, schemas, ownership, or instructions with downstream explanations.

Prefer, in order:

1. removing the ambiguity;
2. making the intended behavior structural;
3. validating or enforcing it;
4. explaining it in prose only when the system cannot express it directly.

Prefer removing the need for an explanation over improving the explanation.

## Prefer structure over instruction

Express operational rules through the system whenever practical.

Prefer mechanisms such as:

- tool availability;
- schemas and types;
- ownership boundaries;
- validated state;
- defaults and derived values;
- `available_tools`;
- runtime enforcement;
- explicit capabilities.

Do not ask the model to infer, remember, reconstruct, or supply information the system already knows.

Instructions should describe semantics the system cannot make sufficiently obvious or enforce directly.

## Keep shared instructions roster-agnostic

Shared runtime instructions, tool descriptions, and reusable workflows must not
assume particular Agent definitions exist. Describe work by responsibility and
required capability. Select from the effective roster, respecting availability,
permissions, and ownership boundaries. If no suitable Agent is available, use
permitted local capabilities or report the limitation.

Individual definitions may describe their own roles and explicitly configured
child dependencies. Bundled Agent names in examples and test fixtures must not
become requirements for normal operation.

An Agent description is delegation-selection guidance: state the capabilities
it offers, when they are useful, and any meaningful selection boundary. Keep
descriptions accurate for the effective configuration. They must not imply
permissions, authority, or mandatory workflows that the runtime does not provide.

## Prefer positive steering

Design for desired behavior before constraining against undesired behavior.

Make correct behavior structural when practical through capabilities, tool availability, schemas, state, defaults, lifecycle boundaries, and validation. The strongest positive steering often removes the need for an instruction by making the intended action the natural available action.

When model guidance is still necessary, phrase it primarily as desired decisions, priorities, defaults, and actions. Prefer guidance such as "Use existing context before requesting additional information" or "Prefer the smallest durable solution" over enumerating unwanted behaviors.

Use negative constraints when the forbidden behavior is itself important to the contract or when a boundary is clearer in negative form. Reserve absolute terms such as `never`, `must not`, and `forbidden` for true invariants, authority, safety or security, integrity, destructive operations, or behavior that must categorically not occur.

Do not accumulate prohibitions to compensate for an interface or contract that can express the desired behavior directly. When a prohibited behavior can be made impossible structurally, enforce it through tools, schemas, capabilities, state, or validation instead of relying on prose alone.

## Treat the model-facing contract as one system

The model experiences Herdsman as the combination of:

- system and runtime instructions;
- tool descriptions and prompt guidance;
- schemas and parameters;
- automatic context and state;
- available actions and capabilities;
- agent definitions and role boundaries;
- validation and error guidance;
- skills and product documentation.

Design and review these surfaces as one coherent contract.

A change is correct only when the resulting whole is coherent, not merely when the modified surface is locally correct.

## Minimize concepts and degrees of freedom

Before adding an instruction, parameter, action, state, identifier, channel, abstraction, or special case, determine whether an existing concept can express the requirement cleanly.

Prefer:

- fewer concepts;
- fewer parameters;
- fewer actions;
- fewer identifiers;
- fewer state distinctions;
- fewer exceptional paths;
- strong defaults;
- derived values;
- inherited context where ownership determines it;
- one canonical mechanism for equivalent operations.

Remove distinctions once they no longer carry meaningful semantics.

Do not expose implementation details merely because they exist internally.

## Minimize model-facing reference burden

Treat file paths, identifiers, and artifact references exposed to models as
interface design decisions, not incidental storage details. Prefer omitting
or deriving an identity from verified runtime state; otherwise reuse a short,
stable, unambiguous semantic reference instead of exposing long absolute
paths, UUID-containing paths, generated filenames, or internal directory
layouts. Do not require models to construct, remember, or transcribe
information the system already knows.

Shorter strings are not inherently better. Do not add aliases, registries, or
lookup rules merely to hide complexity, or sacrifice identity, authority,
security, recoverability, or interoperability. Retain exact physical paths
and opaque IDs when required by the underlying tool or boundary, and resolve
simplified references deterministically against authoritative state.

For each model-facing reference, ask: **Does the model need to supply this,
and what is the simplest reliable way to identify it?**

## Do not accumulate defensive guidance

A model mistake is evidence to investigate, not automatically evidence that another instruction is needed.

Before adding guidance, determine whether the failure resulted from:

- ambiguity;
- duplicated or conflicting semantics;
- missing context or state;
- misleading interface design;
- weak validation;
- unnecessary degrees of freedom;
- insufficient salience at a known decision boundary;
- or a genuinely missing invariant.

Prefer correcting the underlying contract first.

Additional reinforcement is justified when no distinct new rule is needed, but repeating an existing invariant at a proven high-risk decision boundary materially improves reliability. Such reinforcement must preserve the same meaning and must not become an independent rule.

When touching an area, remove obsolete, overlapping, contradictory, or compensatory behavior and guidance when doing so improves the resulting design.

Current behavior should be understandable without knowing the system's history.

## Optimize the resulting system

Evaluate changes by the complexity and coherence of the system they leave behind, not only by the size of the immediate patch.

Prefer the smallest durable design that is:

- unambiguous;
- internally consistent;
- difficult to misuse;
- easy for models to understand;
- easy for humans to maintain;
- structurally enforceable where practical;
- adaptable without accumulating exceptions.

The goal is not simply fewer instructions or a smaller API.

The goal is the smallest coherent system in which correct behavior follows naturally from the design.
