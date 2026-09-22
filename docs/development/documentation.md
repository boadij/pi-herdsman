# Documentation maintenance

[Documentation index](../README.md)

The documentation is deliberately split by responsibility so each feature stays
on its canonical page while readers can enter through audience-specific paths.

## Ownership rule

Every public concept has one canonical page.

Use the ownership table in [the documentation index](../README.md).

When another page needs the same concept:

- summarize only enough to establish context;
- link to the canonical page;
- do not paste the complete table or contract again.

Audience entry pages are navigation, not competing ownership. They may establish
reading order and show a minimal first-use example, but exhaustive behavior stays
on the canonical concept, guide, or reference page.

Asynchronous orchestration is owned by [Lifecycle](../concepts/lifecycle.md).
README, Getting started, and Agent coordination API may repeat the concise user
or caller consequence, but they must link back to Lifecycle for the exact
contract.

## Page types

### Audience entry points

The documentation index routes readers first by audience:

- [Getting started](../getting-started.md) is the shortest human UI and
  configuration path;
- [Agent coordination API](../agent-api.md) is the model and agent coordination
  reading path;
- development pages are maintainer-only.

These pages should link across audiences when useful, but must not grow parallel
copies of the same API, lifecycle, configuration, or presentation contract.

The physical `concepts`, `guides`, `reference`, and `development` directories
remain content-type organization. Do not add another documentation hierarchy or
navigation manifest just to represent audiences.

### Getting started

Shortest human path from prerequisites to useful Pi Herdsman delegation,
continued lead-session interaction, UI, configuration, and observability.

Do not turn it into a structured API reference.

### Agent coordination API

Reading order and first-use orientation for model and agent-facing coordination.

Link to the exact `agent`, `ask_owner`, lifecycle, delegation, handoff, state,
and error owners instead of restating their full contracts.

### Concepts

Explain mental models and invariants.

Do not enumerate every request field.

### Guides

Task-oriented procedures and examples.

Link to reference for exhaustive semantics.

### Reference

Exact accepted values, precedence, states, and API rules.

Avoid tutorial narrative.

### Development

Maintainer-only validation, smoke, and documentation-process material.

Do not mix these procedures into normal user setup.

### `SKILL.md`

Optional model-facing reinforcement of the runtime operational contract plus
deeper strategy, rationale, examples, and recovery guidance.

It does not own product API schemas or runtime behavior.

## Runtime and skill authority

Runtime behavior and runtime model contracts own operational semantics.

`SKILL.md` may reinforce high-salience runtime invariants and add strategy,
rationale, examples, and recovery detail, but it is not a second normative
owner.

When runtime guidance changes:

- update the authoritative runtime contract first;
- update affected skill or documentation projections;
- remove obsolete reinforcement rather than preserving historical wording;
- keep the runtime sufficient when `SKILL.md` is not loaded.

A behavioral invariant may be reinforced at multiple model-facing decision
points when timing or salience materially affects reliability. Those projections
must preserve one meaning and must not evolve into independent rules.

Do not add runtime skill loading, prompt generation, or another synchronization
framework merely to keep prose copies aligned.

## Style

- Plain Markdown.
- Relative repository links.
- One H1 per file.
- Short descriptive headings.
- Current behavior only.
- Spell the visible product name `Pi Herdsman`, the package and repository identifier `pi-herdsman`, the local coordination directory `.pi-herdsman`, the configuration file `config.json`, and the upstream dependency `herdr`.
- No backlog task numbers in product docs.
- Keep canonical user and reference pages focused on current behavior.
- Examples must match current accepted schemas.
- Never document unshipped backlog behavior as available.
- Avoid em dashes in product documentation.

## Cross-links

Every page under `docs/` links back to the documentation index.

Audience entry pages may also link directly to each other so a reader can switch
paths without returning to the index.

Use a `See also` section when the neighboring concept is useful.

Do not create a separate nav manifest or documentation framework unless plain
Markdown stops meeting a demonstrated need.

## Source verification

When implementation and existing prose disagree:

1. public source/test behavior is authoritative;
2. current accepted runtime evidence can clarify integration behavior;
3. stale prose should be deleted, not preserved as an alternative contract.

Particularly verify the runtime implementation for `agent`, `ask_owner`,
`/agents`, `/chief`, `staff`, states, definition schema/composition, text-file snapshots,
state projection, error categories, and presentation behavior;

- `package.json` for supported Pi versions and package resources.

## Link integrity

Before handoff, resolve every repository-relative Markdown link. Links must
target current repository pages and anchors; do not reference deleted pages or
removed examples.

## Update policy

A feature should normally change:

- its one canonical reference page;
- a guide or concept only when user workflow or mental model changes;
- an audience entry page only when its reading path or first-use experience
  changes;
- README only when first-use or product capability changes;
- SKILL only when controller coordination guidance changes.

Update only the surfaces whose current ownership or links change; keep README,
SKILL, smoke testing, guides, and status docs aligned with their responsibilities.
