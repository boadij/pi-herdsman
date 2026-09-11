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

Optional model-facing reinforcement of the self-contained runtime operational
contract plus deeper strategy, rationale, examples, and recovery guidance.

It does not own product API schemas or runtime behavior.

## Runtime and skill synchronization

Pi Herdsman has one deliberate instruction duplication.

The runtime controller and managed agent instructions are the authoritative,
self-contained operational contract. Root `SKILL.md` intentionally mirrors
those mandatory operational instructions so loading the skill can reinforce
them in a long model context.

Therefore:

- every mandatory operational rule must exist at runtime;
- corresponding operational guidance must remain represented in `SKILL.md`;
- `SKILL.md` may add strategy, rationale, examples, and deeper explanation;
- no capability or normal workflow may depend on loading `SKILL.md`;
- runtime wins if the two surfaces conflict;
- a change to either mirrored runtime or skill instructions requires checking
  the other side in the same change.

This is intentional reinforcement, not competing authority.

Do not replace it with runtime skill loading, generated prompt files, a prompt
registry, or another synchronization subsystem.

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
