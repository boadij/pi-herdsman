---
name: agentic-system-audit
description: Audit an agentic software system end to end for contradictions, gaps, inconsistent contracts, capability mismatches, instruction conflicts, ambiguous results, stale documentation, unsafe lifecycle behavior, redundant guidance, missing enforcement, test blind spots, and architectural drift. Use when reviewing the overall health and coherence of an agent/tool system, especially systems with prompts, tools, subagents, lifecycle state, dynamic results, configuration, documentation, and multiple instruction layers.
---

# Agentic System Audit

Audit the **whole agentic contract**, not isolated files.

Find where code, prompts, tools, state, results, docs, tests, configuration, packaging, or runtime capabilities disagree or leave the next safe action ambiguous.

Prefer deletion, consolidation, one canonical owner, and the smallest durable correction.

This is a **read-only audit**. Do not modify the repository.

# Operating model

Delegate the audit. The orchestrator coordinates and returns the result; it should not perform a competing repository review.

Use:

- `reviewer`: lead auditor, evidence reconciliation, synthesis;
- `scout`: focused local evidence;
- `researcher`: external/API verification when material conclusions depend on it;
- `implementer`: never during the audit;
- `generalist`: fallback only when the required role is unavailable and its effective policy is read-only.

Start with:

```json
{ "action": "list" }
```

Use effective capabilities from the current context. Do not assume definition-level delegation, tools, skills, or extensions survive overrides or depth.

## Preferred topology

```text
orchestrator
└── reviewer
    ├── scout A: runtime/contracts/reachability
    ├── scout B: instructions/capabilities
    ├── scout C: presentation/docs/tests/package glue
    └── researcher: only when the research trigger is met
```

Use one lead reviewer. Do not spawn a second generic reviewer by default.

## Leaf fallback

If the lead reviewer cannot delegate:

1. run the three scout lenses directly in parallel;
2. run researcher only when triggered;
3. pass exact scout/researcher `resultPath` values to one reviewer through `files`;
4. have that reviewer verify, reconcile, prioritize, and synthesize.

The orchestrator must not redo the scouts' analysis.

# Lead reviewer contract

The reviewer may not receive this skill directly, so its assignment must carry the rules required for a valid audit.

Give the reviewer this objective:

> Audit the repository as one agentic system. Remain strictly read-only.
>
> Delegate three focused scouts:
>
> - A: runtime producers, validation, state, identity, lifecycle, and production reachability;
> - B: instruction ownership and effective capabilities;
> - C: model/UI projections, docs, tests, and repository/package glue.
>
> Use researcher when a candidate material finding or its impact depends on external API/runtime truth.
>
> Before reporting any P0-P2 finding:
>
> - identify the semantic source and relevant producers;
> - prove the disputed state/value is reachable on a production path when behavior is at issue;
> - trace it through every consumer boundary relevant to the claim;
> - resolve material upstream/runtime assumptions for the repository's supported versions using primary evidence when available;
> - verify that a claimed regression check would fail for the old behavior.
>
> Do not report representable-but-unreachable states as defects. Do not treat differently named fields as equivalent without tracing semantics. Do not leave an answerable material uncertainty as follow-up.
>
> If required evidence genuinely cannot be established, report a bounded `Unverified risk`, not a definitive finding.
>
> Compare root/parent/child, definition/session/fork, model/UI, success/failure/recovery, configured/effective capability, and static/dynamic guidance.
>
> Independently verify material conclusions and return one de-duplicated report using the required output contract with the smallest durable fix for each finding.

Pass supplied canonical diffs, snapshots, specs, or source artifacts to scouts instead of making them rediscover the same material.

# Material finding closure

Scouts return **candidate evidence**. The reviewer closes candidates before severity is assigned.

Trace every boundary used by the claim. For result/state findings, prefer:

```text
semantic source
→ producer
→ validation/normalization
→ runtime/durable state
→ structured/public projection
→ model consumer
→ human/API consumer
→ docs/tests
```

Not every step applies to every finding.

## Provenance

Find where the disputed fact originates and how it changes.

Do not infer semantic equivalence from similar field names. Trace producers and scope first.

## Reachability

Do not confuse **representability** with **reachability**.

A type, schema, fixture, or doc proves a value can be described. A behavioral finding requires a production path that can actually produce the material state/value.

If the harmful state cannot occur on the claimed path, dismiss or narrow the candidate.

## Consumer contract

Establish what the actual consumer receives.

For model-visible claims, determine whether the model gets `content`, `details`, both, or another transformation.

For human claims, distinguish compact TUI, expanded TUI, plain/RPC/JSON, and logs/files.

Never assume renderer-visible metadata is model-visible.

## External contract

If a material conclusion depends on upstream behavior, resolve it for the repository's **supported version range**.

Prefer:

```text
supported-version primary source/API/type contract
→ supported-version official docs
→ installed dependency source
→ targeted runtime smoke only if still unresolved
```

Do not substitute latest behavior for the supported range. Do not require a smoke test when source plus local integration already establishes the behavior.

## Test discrimination

When claiming a test gap or proposing a regression:

> Would this test fail for the old bug and pass for the corrected behavior?

Do not count assertion volume as coverage.

## Closure outcomes

Every material candidate becomes exactly one of:

- **Verified finding**: evidence establishes defect and consequence.
- **Dismissed/narrowed**: intentional, unreachable, semantically different, or immaterial.
- **`Unverified risk`**: evidence genuinely cannot be established with available read-only capabilities.

An `Unverified risk` must state known evidence, missing evidence, version/runtime scope, why it matters, and one exact resolver.

Do not use it for an answerable question that was not investigated.

# Scout A: runtime contracts and reachability

Own:

> Can this state/value actually happen, where is it produced, and what runtime contract governs it?

Trace:

```text
schema/input
→ validation
→ effective configuration
→ execution
→ runtime/durable state
→ public result
→ next legal action
```

Check:

- schema vs runtime acceptance/rejection;
- defaults, normalization, mutually exclusive fields;
- validation before mutation;
- sibling-path validation consistency;
- logical label, definition, Pi session, owner, request, ask, run, workspace, tab, pane, Herdr identity;
- stale/replacement identity binding;
- public state vs actual action eligibility;
- `working`, `blocked`, `settling`, `unknown`, steerability, staleness, pending ask/result, child gating, cleanup convergence;
- fresh delegation, continuation, fork, replacement, completion, parent-child completion, ask/reply, close, rollback, restart/recovery;
- source identity, request correlation, result paths, truncation, cleanup warnings, primary/cleanup errors, rollback/retry state.

Return exact production paths, reachability evidence, and candidate mismatches. Do not decide architecture from local evidence alone.

# Scout B: instruction and capability stack

Own:

> Who owns this rule, and is it truthful for the effective execution context?

Map:

```text
system/base prompt
tool description
controller scope
shared agent prompt
role body
body @file
skills
dynamic success/error guidance
human docs
```

For each normative rule, find its intended single owner.

Flag:

- zero owner: instruction gap;
- multiple authoritative owners: `DUPLICATE_AUTHORITY`;
- conflicting owners: `CONTRADICTION`;
- wrong owner: `AUTHORITY_LEAK`.

Compare:

```text
definition
→ override composition
→ effective tools/skills/extensions/context
→ launch args
→ actual role/depth
→ model instructions
→ presentation
```

Find:

- `GHOST_CAPABILITY`;
- `HIDDEN_CAPABILITY`;
- root/parent/leaf capability mismatches;
- metadata advertising removed capabilities;
- infrastructure accidentally removable by normal policy;
- user-configurable policy treated as mandatory infrastructure;
- impossible or underspecified instructions;
- global policy embedded in role prompts;
- API mechanics redundantly taught by prompts/skills.

Return exact instruction text, owner, effective runtime evidence, and candidate conflicts.

# Scout C: presentation, docs, tests, and repository glue

Own:

> Where does runtime truth go, what does each consumer actually see, and do docs/tests describe that contract?

## Model-visible presentation

Inspect list, assignment/steer/reply/close acknowledgements, completion delivery, errors, and truncation.

Ask:

> Using only what the model actually receives, can it identify the source, understand the state, and choose the next legal action?

Flag missing correlation, hidden material details, ambiguous terminology, duplicated IDs, static policy repeated on every result, or missing dynamic next-action evidence.

For opacity candidates, trace projection semantics, not just field names.

## Human presentation

Compare status widget, definitions view, completion renderer, warnings, compact/expanded views, and any plain/API surface.

Find hidden failures, duplicated data, display identity reused as machine identity, or UI claims stronger than runtime evidence.

## Documentation

Find shipped-but-undocumented behavior, documented-but-unshipped behavior, duplicate canonical owners, stale terminology, rejected examples, and implementation details presented as public contracts.

## Tests

Find public contracts without discriminating regressions, tests that pass for correct and broken behavior, mocks that cannot detect claimed integration failures, missing sibling invariants, and stale fixtures.

## Repository/package glue

Check package files, discovery, README links, AGENTS/maintainer guidance, validation scripts, dead compatibility/configuration, and removed concepts that still ship or remain referenced.

Return projection chains, consumer visibility, docs/tests evidence, and candidate mismatches.

# Research trigger

Research is conditional. Once triggered, verification is required when capability exists.

Trigger researcher when:

```text
a candidate likely to affect a P0-P2 finding, verdict, or remediation
depends on external API/runtime behavior
```

Research input should contain only:

```text
exact disputed assumption
supported version range
preferred primary source/repository
required direct answer
```

Require primary/official evidence, exact version relevance, and only material findings.

If web capability is unavailable:

1. inspect installed/local upstream source;
2. inspect pinned/supported dependency source where reachable;
3. use other authoritative read-only evidence;
4. otherwise return `Unverified risk`.

Do not add dependencies or require optional web tooling to run the audit.

# Cross-surface contract matrix

Cover each applicable chain.

## Input

```text
schema ↔ description ↔ validation ↔ errors ↔ docs ↔ tests
```

## Capability

```text
definition ↔ override ↔ effective config ↔ launch ↔ role/depth ↔ tools/prompts ↔ presentation
```

## Instruction

```text
controller ↔ shared prompt ↔ role body ↔ skills ↔ dynamic results
```

## Identity

```text
label ↔ definition ↔ session ↔ request ↔ owner ↔ Herdr identity ↔ result/error/UI
```

## State

```text
runtime evidence ↔ public state ↔ steerability ↔ eligibility ↔ displayed state ↔ next action
```

## Completion

```text
completion ↔ durable result ↔ result file ↔ owner message ↔ model content ↔ human rendering ↔ cleanup
```

## Configuration

```text
syntax ↔ parsing ↔ merge ↔ validation ↔ effective metadata ↔ runtime ↔ persistence/UI ↔ docs
```

## Recovery

```text
failure ↔ retained evidence ↔ rollback ownership ↔ structured error ↔ model/human guidance ↔ retry boundary
```

## Distribution

```text
repository ↔ package manifest ↔ installed files ↔ discovery ↔ maintainer guidance
```

# Mandatory boundary comparisons

Check where applicable:

## Controller depth

```text
root | direct agent/parent | nested child/leaf | unmanaged session
```

## Agent generation

```text
fresh | exact-session continuation | fork
```

## Visibility

```text
model content | structured details | compact TUI | expanded TUI | plain/RPC/JSON | logs/files
```

## Outcome

```text
success | blocked | failure | rollback failure | close | cleanup pending | overflow | restart recovery
```

## Configuration

```text
bundled | partial override | standalone global | empty fields | false | [] | invalid
```

# Defect taxonomy

Use consistently:

- `CONTRADICTION`: authoritative surfaces prescribe incompatible behavior.
- `GAP`: required knowledge/behavior has no appropriate owner or result.
- `GHOST_CAPABILITY`: instructions/metadata claim unavailable capability.
- `HIDDEN_CAPABILITY`: required capability exists without enough safe guidance.
- `DUPLICATE_AUTHORITY`: one normative rule has multiple authoritative owners.
- `AUTHORITY_LEAK`: policy is owned by a layer that should not control it.
- `CONTEXT_MISMATCH`: rule is correct in one context and wrong in another.
- `IDENTITY_AMBIGUITY`: identity loses exact or single semantic meaning.
- `STATE_AMBIGUITY`: displayed/instructed state does not map cleanly to legal actions.
- `RESULT_OPACITY`: receiver lacks material source, state, correlation, outcome, or next-action evidence.
- `FAIL_OPEN`: missing/ambiguous evidence causes unsafe continuation.
- `DRIFT`: code, tests, docs, metadata, examples, or prompts describe different generations.
- `TEST_BLIND_SPOT`: material public contract lacks a discriminating regression.
- `TOKEN_WASTE`: repeated model context adds no decision value.
- `DEAD_COMPLEXITY`: compatibility/abstraction/state/configuration has no justified current use.
- `UX_AMBIGUITY`: human presentation obscures correct system behavior.

Create another label only when none fits.

# Severity

- **P0**: unsafe/destructive behavior, wrong-target control, trust-boundary violation, data loss, or durable corruption.
- **P1**: materially wrong action, stuck lifecycle, broken delegation/control, or misunderstanding of an authoritative result.
- **P2**: meaningful confusion, drift risk, redundant authority, weak diagnostics, avoidable context cost, or recurring maintainer mistakes.
- **P3**: small cleanup, naming, presentation, or maintainability issue with little behavioral risk.

Do not inflate severity because a finding is interesting.

# Evidence standard

A material cross-surface finding needs:

```text
A: semantic behavior/claim + exact source
B: conflicting/missing behavior/claim + exact source
Connection: why A and B are the same contract crossing a boundary
Reachability: production path when behavior is at issue
Consequence: what can actually go wrong
Minimal correction: narrowest root owner
```

A scout's conclusion is evidence, not authority.

The lead reviewer independently verifies every P0/P1, every P2 affecting architecture/verdict/external assumptions, and any disputed conclusion.

Do not report architectural preference as a defect.

# Audit heuristics

Use these to find candidates. They do not replace closure.

- **Who owns this sentence?** One normative rule should normally have one authoritative owner.
- **Can the recipient act on this?** Check only what that consumer actually receives.
- **Can the agent do what it is told?** Compare prompts to effective capability at every depth.
- **Does runtime enforce the important part?** Safety, ownership, identity, validation, and data-loss boundaries should not rely only on prompts.
- **Does code know something the model does not?** Inspect `details`, hidden metadata, cleanup evidence, capability inference, state subconditions, correlation IDs.
- **Does the model know something code does not enforce?** Separate strategy from invariants such as exact ownership, read-only, no overlap, or one-shot rules.
- **What changes at continuation?** Generation-time facts described as dynamically refreshed are suspect.
- **What changes at root/child depth?** Global policy projected differently by depth is suspect.
- **What was deleted but still has a shadow?** Search docs, tests, package files, comments, compatibility branches, fields, examples.
- **Would this test fail for the old bug?** Prefer one discriminating regression over many weak assertions.
- **Is the same fact sent twice?** Check model/human identity, paths, model, state, warnings, next-action text.
- **Is this field mismatch semantic drift?** Find all producers, scope, reachability, and consumers first.

# Efficiency rules

1. Start from entry points and contract surfaces.
2. Search ownership before opening large files.
3. Trace callers and producers before declaring a bug.
4. Keep scouts inside their lenses.
5. Pass canonical artifacts instead of rediscovering them.
6. Research only external assumptions that can change a material conclusion.
7. Reviewer verifies candidate findings, not every inspected line.
8. Do not spawn agents merely to confirm `No findings.`
9. Use a second reviewer only for an uncertain P0/P1 or disputed architecture.
10. Never assign an implementer during diagnosis.
11. Stop when the contract matrix is covered and new searches produce no materially new issue class.

Optimize for useful evidence per agent, not agent count.

# Required output

## 1. Verdict

Exactly one:

```text
PASS
PASS WITH FINDINGS
FAIL
```

`PASS` means no material P0-P2 findings after required surfaces were covered and material candidates were closed.

## 2. Executive summary

At most five bullets.

## 3. Findings

Order by severity, then confidence.

```text
[P1][CONTEXT_MISMATCH] Short title

Evidence:
- path:line ...
- path:line ...

Why it matters:
...

Minimal durable fix:
...

Confidence: high
```

Do not bury findings in prose.

## 4. Instruction ownership map

Summarize meaningful ownership gaps/collisions across:

```text
tool schema
tool description
controller scope
shared agent prompt
role body
skill
dynamic success guidance
dynamic error guidance
human docs
```

## 5. Contract coverage

For:

```text
input
capability
instruction
identity
state
completion
configuration
recovery
distribution
```

report:

```text
status: verified | finding | not applicable | not verified
scope: what was actually traced
```

Example:

```text
recovery | verified | startup rollback, retained cleanup evidence, retry markers
completion | finding | compact cleanup-warning projection
```

`verified` applies only to the stated scope. Do not claim whole-system PASS with unexplained `not verified`.

## 6. Remediation order

Give the shortest dependency-aware sequence.

Prefer:

```text
fix root contract once
→ delete duplicate authority
→ add/update one discriminating regression
→ update canonical docs
```

## 7. Unverified risks

Include only genuinely unresolved material claims after the closure workflow. State known evidence, missing evidence, version/runtime scope, consequence, and exact resolver.

Omit when empty.

## 8. Non-blocking follow-up

Include only useful work not required to validate a material finding, such as a separate implementation task or non-material integration smoke.

Never put answerable material uncertainty here.

Omit when empty.

# Orchestrator finalization

Normally return the lead reviewer's report instead of writing a second review.

Before returning, verify:

- every required contract chain has scoped coverage;
- P0/P1 findings have exact evidence;
- material P2 findings have closed evidence;
- result/state findings trace producer, reachability, and consumer semantics;
- material external assumptions were resolved for supported versions when possible;
- duplicate scout candidates were consolidated;
- fixes target root owners, not symptoms;
- only genuinely unresolved claims are `Unverified risk`;
- no answerable material question was deferred to follow-up;
- implementation remains separate from diagnosis.

If a check fails, return the report to the reviewer for reconciliation.

Otherwise stop.

# After the audit

Do not automatically fix findings.

If implementation is requested later:

1. use the audit report as canonical scope;
2. assign the smallest capable `implementer`;
3. keep unrelated cleanup out unless it simplifies the same proven root cause;
4. independently review the final diff against the audit findings;
5. run focused and repository validation appropriate to the change.

# Success criteria

A successful audit can answer without material guessing:

```text
What can each agent actually do?
What is each agent told to do?
Who owns each normative rule?
Which identity is authoritative for each operation?
What does each public state permit next?
What changes by depth and generation?
What does the model see versus human/API surfaces?
Can each result be attributed to source/request?
Can each failure be acted on safely?
Does effective configuration match prompts/presentation?
Are reported states and error fields reachable?
Do tests discriminate the important contracts?
Do docs/package contents describe what ships?
Is important authority duplicated or missing?
Is unjustified complexity present?
```

If a material answer still requires guessing and the evidence was available, the audit is incomplete.
