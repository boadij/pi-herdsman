# Use progressive disclosure and single-owner documentation

## Decision

Pi Herdsman documentation will use progressive disclosure and one canonical owner for each public concept or interface.

The root `README.md` is a developer-facing product landing page, not a compressed reference manual. It should help a reader quickly understand what Pi Herdsman is, why it is useful, how to reach a first successful use, and where to continue.

Documentation depth is separated by purpose:

- entry pages orient and route readers;
- concepts explain mental models and durable invariants;
- guides explain task-oriented workflows;
- reference pages specify exact public behavior;
- development pages contain maintainer-only material.

Entry pages summarize only enough to support the reader's current decision and link to the canonical owner for deeper behavior. A new feature does not automatically justify README space or a new page; it should first be integrated at the shallowest existing layer that improves understanding.

Plain Markdown and GitHub-native rendering remain the default. Additional documentation frameworks, generated navigation, redirect layers, or parallel audience trees require a demonstrated need.

This decision governs information architecture, not exact wording, heading order, visual composition, or individual examples. Those may evolve without changing this ADR.

## Rationale

Pi Herdsman spans Agent ownership, asynchronous execution, project orchestration, supervision, Pi sessions, Herdr topology, and Git state. Presenting all of those concepts at once makes first use harder and encourages duplicated explanations to drift.

Progressive disclosure lets beginners reach useful work quickly while keeping exact contracts available to advanced readers. Single ownership makes updates local and predictable: a behavioral change has one authoritative documentation surface, while other pages provide only the context needed to route readers there.

As the product grows, the README should remain concise instead of accumulating every feature and edge case.

## Alternatives considered

- Put all important behavior in the README: rejected because the README becomes harder to scan as the product grows and duplicates deeper documentation.
- Maintain separate beginner and expert documentation trees: rejected because they duplicate concepts and create synchronization work.
- Give each feature its own page: rejected because page count should follow distinct reader tasks or contracts, not implementation feature count.
- Introduce a generated documentation site or navigation framework now: rejected because the current plain-Markdown structure already supports the required information architecture.

## Consequences

Every public concept or interface must have one canonical documentation owner.

README and other entry pages may describe capabilities, but exact schemas, lifecycle rules, edge cases, and maintainer procedures belong in deeper canonical pages.

New documentation should reuse an adequate existing page before creating another one.

Vocabulary should be introduced progressively. Internal identifiers, runtime records, and implementation mechanics stay out of introductory material unless they are required to understand public behavior.

Maintainers may freely improve copy, diagrams, examples, and layout as long as the progressive-disclosure and canonical-ownership structure remains intact.
