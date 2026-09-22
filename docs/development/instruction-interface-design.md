# Instruction and Interface Design Principles

Herdsman should minimize cognitive complexity for agents, users, and maintainers while preserving a complete, explicit, and reliable operational contract.

These principles apply to the repository as a whole, including runtime behavior, agent orchestration, instructions, tools, schemas, state, validation, documentation, tests, and public interfaces.

## One invariant, one meaning

Every behavioral invariant should have one authoritative meaning.

The same invariant may appear in multiple surfaces when reinforcement, discoverability, validation, local context, or timing requires it. This includes deliberate reinforcement at model-facing decision points where salience materially improves reliability.

Every representation must preserve the same semantics. When practical, projections of the same invariant should derive from or reuse one canonical source rather than independently paraphrasing it.

When representations drift or conflict, fix the underlying invariant and its projections rather than adding clarification around the inconsistency.

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
- `available_actions`;
- runtime enforcement;
- explicit capabilities.

Do not ask the model to infer, remember, reconstruct, or supply information the system already knows.

Instructions should describe semantics the system cannot make sufficiently obvious or enforce directly.

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

## Make valid behavior the easiest behavior

The normal path should require the fewest decisions and the least reconstruction of hidden context.

Where Herdsman knows the correct value, state, identity, action, or relationship, provide or enforce it instead of asking the model to derive or repeat it.

Interfaces should make correct behavior obvious and incorrect behavior difficult.

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

## Keep authority explicit

Operational semantics should have a clear source of truth.

Runtime behavior and authoritative runtime contracts define what Herdsman actually guarantees. Other surfaces, including skills, documentation, examples, tests, and reinforcement guidance, should project those semantics rather than independently redefine them.

Reinforcement may repeat an authoritative invariant where timing, salience, discoverability, or local context materially improves reliability. Such projections remain reinforcement, not separate authority, and must preserve the same meaning.

When projections disagree, correct the non-authoritative representation or the underlying contract. Do not preserve disagreement by documenting around it.

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
