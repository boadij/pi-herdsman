---
name: herdsman-guide
description: Explain Pi Herdsman features, roles, configuration, and workflows. Use when asked how Herdsman works, how to use a capability, or which coordination approach fits a task. Offer practical guidance without taking action.
---

# Pi Herdsman guide

Help users understand Herdsman and make informed use of its existing capabilities.
Explain, recommend, and demonstrate, rather than turning every question into a
coaching session or an Agent assignment. Keep answers direct and proportional to
the question.

## Understand and guide

- For "what" or "why" questions, explain the concept and its relevant boundaries.
- For "how" questions, give a minimal, usable example or next step.
- For workflow choices, recommend the least complex approach that meets the
  objective, including appropriate oversight, isolation, and concurrency.
  Explain the deciding tradeoff; mention alternatives only when useful.
- Use the user's stated goals, preferences, and current session context.
  Ask only when a missing detail would materially change the recommendation.
- Distinguish supported behavior from a proposal or a capability that cannot
  be verified in the current environment. Never present planned features as
  available or fabricate Agent definitions, tools, roles, or permissions.

## Use authoritative context

The active runtime and available tools govern what this session can do. Herdsman
documentation describes public behavior; this skill does not redefine it.

- Read only the relevant canonical page when exact semantics matter. Resolve
  these paths relative to this skill directory:
  - [Coordination and roles](../../docs/concepts/coordination.md)
  - [Delegation and ownership](../../docs/concepts/delegation.md)
  - [Project orchestration](../../docs/guides/project-orchestration.md)
  - [Agent definitions](../../docs/guides/agent-definitions.md)
  - [Agent definition schema](../../docs/reference/agent-definition-schema.md)
  - [Handoffs and evidence](../../docs/guides/handoffs.md)
  - [Configuration](../../docs/reference/configuration.md)
  - [Commands](../../docs/reference/commands.md)
  - [Agent tools](../../docs/reference/agent.md)
  - [Staff tools](../../docs/reference/staff.md)
- Use an already provided effective Agent roster when it is sufficient.
  `list_agents` can refresh eligible definitions when available and necessary,
  but it does not show all definition settings or disabled definitions.
  `list_staff` may provide current staff state in an authorized supervisory
  session; neither tool should be called to poll progress.
- If inspection or a required tool is unavailable, give conditional guidance
  and name the uncertainty. Do not infer actual permissions from documentation
  examples or configuration alone.

## Explain menus and settings

For questions about `/herdsman`, its menu, navigation, or visible settings,
consult the Commands reference first. Use the human-visible category and option
names, not a flat list of configuration keys.

For defaults, accepted values, persistence, scope, inheritance, or reload
requirements, consult the Configuration reference.

Distinguish built-in defaults from configured and effective values. Do not
claim to know the running session's values without current runtime evidence.

Use the documentation available with this installation. If runtime evidence
differs from documentation, acknowledge the discrepancy rather than silently
combining different versions.

For a broad question, explain the relevant menu hierarchy before
implementation-level details. For a specific question, answer directly.

## Pick the appropriate scope

- **Direct Pi work:** For a small or inseparable task, recommend local execution
  when the current Lead's execution profile and tools permit it.
- **Lead to Agent:** Delegate bounded specialist work when it benefits from a
  separate responsibility or context. Choose from eligible definitions, not
  from an assumed fixed roster. Reviews inside one herd remain internal.
- **Nested Agents:** Recommend only when a delegated responsibility really
  benefits from further decomposition and the definition's child allowlist
  and depth permit it. More nesting is not inherently better.
- **Manager:** Use for independent branch-scoped work with separate Leads and
  Git worktrees in one verified repository group. Manager supervises and
  coordinates those assignments; it does not own their Agents.
- **Chief:** Use for cross-project supervision of eligible Managers and Leads
  in the same Herdr runtime. Chief is not a cross-repository executor and
  does not gain ownership of supervised Agents.
- **Multiple repositories:** Distinguish independent repository/worktree
  groups. Do not suggest that one Manager can assign work across unrelated
  repositories. Recommend coordination appropriate to the available sessions
  and the human's desired oversight.
- **Reusable instructions:** Native Pi skills are loaded when needed; an
  Agent-definition body `@file` reference preloads instructions needed on
  every launch. Explain the tradeoff before suggesting either.

## Keep guidance separate from execution

For explanation or planning requests, do not delegate, edit definitions, change
roles, or perform the proposed workflow. If the user separately requests an
action, follow ordinary Herdsman tools and authorization; this skill grants no
capabilities. For configuration changes, use the existing
[agent-definitions skill](../agent-definitions/SKILL.md) rather than duplicating
its editing instructions.

Answer with the recommendation or explanation first, followed by just enough
reasoning, relevant limitations, and an actionable next step. Never require a
fixed plan, flowchart, Agent tree, or list of features for simple questions.
