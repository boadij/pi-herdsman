---
name: agentic-system-audit
description: Audit an agentic software system end to end for contradictions, gaps, inconsistent contracts, capability mismatches, instruction conflicts, ambiguous results, stale documentation, unsafe lifecycle behavior, redundant guidance, missing enforcement, test blind spots, and architectural drift. Use when reviewing the overall health and coherence of an agent/tool system, especially systems with prompts, tools, subagents, lifecycle state, dynamic results, configuration, documentation, and multiple instruction layers.
---

# Agentic System Audit

Audit the **whole agentic contract**, not isolated files.

The goal is to find places where the system does not glue together cleanly:

- two surfaces claim different things;
- code permits something instructions forbid;
- instructions require something runtime cannot do;
- an agent has a capability it is not told about;
- an agent is told it has a capability it cannot actually receive;
- a result omits information required for the next correct action;
- metadata means different things in different layers;
- one rule has multiple competing owners;
- the same instruction is repeated unnecessarily;
- behavior changes across root/parent/child, definition/session/fork, UI/model, or success/failure paths without matching guidance;
- documentation, tests, schemas, prompts, and implementation have drifted apart;
- safety depends on convention where enforcement is required;
- validation protects one path but an equivalent sibling path bypasses it;
- obsolete compatibility, stale configuration, or dead abstractions remain;
- model-visible text is unnecessarily verbose, ambiguous, or operationally incomplete.

Prefer deletion, consolidation, one canonical owner, and the smallest durable correction.

This is a **read-only audit**. Do not modify the repository.

## Operating model

Delegate the audit work. The orchestrator coordinates and returns the final result; it should not perform a competing independent repository review.

Use the existing bundled roles:

- `reviewer`: lead auditor and final synthesis;
- `scout`: fast local evidence gathering;
- `researcher`: current upstream/API verification only when external truth materially affects a finding;
- `implementer`: never during the audit itself;
- `agent`: only as fallback when a required read-only role is unavailable.

Start with:

```json
{ "action": "list" }
```

Use the effective capabilities actually reported in the current context. Do not assume a role can delegate merely because its global definition normally can.

## Preferred topology

When a directly assigned `reviewer` can delegate, assign **one lead reviewer**.

Require that reviewer to launch three scouts in parallel with the lenses below and to use `researcher` only for material external-contract questions.

```text
orchestrator
└── reviewer: lead audit + synthesis
    ├── scout: runtime/contracts
    ├── scout: instructions/capabilities
    ├── scout: presentation/docs/tests
    └── researcher: only if upstream truth is material
```

This is the default because:

- reconnaissance happens in parallel;
- lenses do not overlap materially;
- one reviewer owns cross-surface reasoning;
- the orchestrator receives one coherent result;
- duplicate findings are removed before handoff.

Do not spawn a second generic reviewer by default.

## Leaf-constrained fallback

If the current execution context would make the lead reviewer a leaf that cannot delegate:

1. assign the three scout lenses directly in parallel;
2. optionally assign one researcher for identified external-contract questions;
3. wait for those results naturally;
4. assign one reviewer with the exact scout/researcher `resultPath` values through `files`;
5. ask that reviewer to verify, de-duplicate, prioritize, and synthesize.

Do not have the orchestrator redo the scouts' analysis itself.

## Lead-reviewer assignment

Give the reviewer this objective:

> Audit the repository as one agentic system. Delegate the three prescribed scout lenses in parallel. Use researcher only where current upstream/API behavior is necessary to establish whether a local assumption is correct. Independently verify every material conclusion before reporting it. Do not edit anything.
>
> Find contradictions, gaps, missing enforcement, misleading capability claims, instruction duplication, ambiguous identity/state/result semantics, context-dependent mismatches, stale docs/tests/configuration, safety holes, unnecessary architecture, token waste, and any other issue that could make an agent act incorrectly or make maintainers misunderstand the system.
>
> Compare behavior across root vs parent vs child, definition vs exact-session continuation vs fork, model-visible vs UI-visible output, success vs failure/recovery, configured vs effective capability, and static instruction vs dynamic result guidance.
>
> Return one de-duplicated health report with exact evidence and the smallest durable fix for every material finding.

Require the reviewer to pass any supplied canonical diff, repository snapshot, specification, or relevant source artifact to scouts instead of making each scout rediscover it independently.

---

# Scout lenses

Each scout gets **one lens only**.

Do not tell all scouts to "review everything."

## Scout A: runtime contract and state machine

Audit the executable control flow.

Inspect the smallest set of files necessary to trace:

```text
tool/schema input
→ validation
→ effective configuration
→ execution
→ durable state
→ public state projection
→ success/error result
→ next legal action
```

Check especially:

### Input contracts

Compare:

- tool parameter schema;
- runtime validation;
- mutually exclusive field combinations;
- defaults;
- normalization;
- trust-boundary validation;
- error messages.

Find:

- schema permits what runtime rejects without useful guidance;
- runtime accepts what schema/instructions omit;
- equivalent actions validate differently without reason;
- values are validated too late, after mutation;
- one branch bypasses shared validation.

### Identity

Trace every identity independently:

- logical label;
- agent definition;
- Pi session ID/path;
- owner session;
- request ID;
- ask ID;
- run ID;
- workspace;
- tab;
- pane;
- internal Herdr alias.

Find:

- overloaded field names;
- display identity stored where exact identity is expected;
- model told to control with a non-control identity;
- result/error loses the identity needed for the next action;
- stale identity can bind to a replacement generation;
- one path uses weaker proof than siblings.

### State

Trace:

```text
working
blocked
settling
unknown
```

plus independent flags such as `steerable`, inactivity/staleness, pending result, pending ask, child gating, launch/cleanup convergence.

Check:

- state meaning differs between API, UI, prompt, docs, and enforcement;
- next-action guidance disagrees with actual eligibility;
- state collapses two materially different situations the agent must distinguish;
- runtime supports a transition that no instruction explains;
- instruction suggests a transition runtime cannot accept.

### Lifecycle

Compare:

- fresh start;
- definition delegation;
- exact-session continuation;
- fork;
- replacement;
- completion;
- parent-child completion;
- owner question;
- close;
- rollback;
- restart/recovery.

Look for asymmetric behavior that is intentional in code but invisible in guidance.

### Results

Trace successful and failed outputs all the way to the owning model.

Check:

- structured `details` versus model-visible `content`;
- source agent identity;
- request correlation;
- result paths;
- truncation/overflow;
- cleanup warnings;
- failure evidence;
- whether the recipient can unambiguously decide what to do next.

Return only material findings and verified invariants.

---

## Scout B: instruction and capability stack

Audit what every agent is told versus what every agent can actually do.

Map all instruction layers:

```text
system/base prompt
tool description
controller-scope prompt/description
shared managed-agent prompt
agent-definition body
body @file content
skills
dynamic tool-result guidance
error guidance
human documentation
```

For each rule, identify its intended **single owner**.

Flag any rule with:

- zero owners: instruction gap;
- multiple authoritative owners: redundancy/drift risk;
- conflicting owners: contradiction;
- wrong owner: behavior depends on context the instruction layer cannot know.

### Capability truth

Compare:

```text
definition fields
→ override composition
→ effective tools/skills/extensions/context
→ inferred infrastructure
→ launch arguments
→ actual runtime role/depth
→ model instructions
```

Look for:

- **ghost capability**: prompt says the agent can do something unavailable at runtime;
- **hidden capability**: runtime exposes a required tool but the agent is never told when/how to use it;
- **context-dependent capability mismatch**: valid as root child but invalid as nested leaf;
- definition metadata that advertises capabilities removed at launch;
- infrastructure tools accidentally removable by normal policy;
- user-customizable policy accidentally treated as mandatory infrastructure.

### Instruction conflicts

Search for contradictions such as:

```text
"wait"
vs
"never poll"

"report blocked"
vs
"reply when blocked on owner"

"delegate when..."
vs
this execution context cannot delegate

"read-only"
vs
available or instructed mutation path

"replace"
vs
"append"

"exact label"
vs
display/composite identity
```

### Redundancy

Find repeated rules across:

- tool description;
- shared prompt;
- role body;
- skill;
- dynamic success result;
- dynamic error result.

A rule should normally live in exactly one of:

```text
static invariant
dynamic next-action guidance
role-specific behavior
advanced optional strategy
```

Flag repeated prose that adds no new information.

### Prompt authority

Check whether role prompts contain global orchestration policy that should belong to the controller/tool layer.

Check whether shared prompts contain API mechanics better owned by the tool description.

Check whether optional skills reteach mandatory API rules rather than adding advanced strategy.

### Impossible or underspecified instructions

Find instructions that:

- require unavailable tools;
- assume internet access that is not guaranteed;
- require waiting but do not explain how;
- require owner approval without an escalation mechanism;
- say "use X when relevant" but never define relevance;
- tell the agent to preserve scope without identifying the authority for scope;
- tell a child to coordinate descendants it can never have.

Return exact conflicting statements and their runtime evidence.

---

## Scout C: presentation, documentation, tests, and repository glue

Audit everything that communicates the system outside the core execution branch.

### Model-visible presentation

Inspect:

- `list`;
- assignment acknowledgement;
- steer acknowledgement;
- reply acknowledgement;
- close result;
- completion delivery;
- errors;
- result truncation.

Ask:

> Does this result contain exactly the information the agent needs for its next legal decision?

Flag:

- important data only in UI/details but invisible to the LLM;
- raw metadata with no action value;
- ambiguous terminology;
- repeated IDs with unclear meaning;
- missing source identity;
- static policy repeated on every result;
- dynamic next-action advice missing when it is most useful.

### Human presentation

Inspect:

- status widget;
- `/agents definitions`;
- completion renderer;
- warnings;
- compact versus expanded views.

Find:

- machine envelope leaking into human preview;
- same datum shown twice;
- human display string reused as machine identity;
- UI claims stronger truth than runtime owns;
- important failures silently hidden.

### Documentation

Compare canonical docs against code and tests.

Find:

- shipped behavior undocumented;
- unshipped behavior documented as available;
- duplicate canonical owners;
- old filenames/concepts still packaged or referenced;
- docs explain implementation detail instead of public invariant;
- examples that runtime rejects;
- terminology differs from tool/runtime terminology.

### Tests

Do not count tests. Evaluate contract coverage.

Find:

- high-value public behavior with no discriminating regression;
- tests that would pass for both correct and incorrect behavior;
- tests assert internal formatting but not user/model semantics;
- sibling control paths lack the same invariant check;
- mocked tests cannot detect the integration failure they claim to cover;
- documented behavior has no test;
- test fixtures accidentally encode stale architecture.

### Repository/package glue

Check:

- package `files`;
- skill/package discovery;
- README links;
- AGENTS/maintainer instructions;
- validation scripts;
- stale compatibility;
- dead configuration;
- deleted features still named in package/docs/tests;
- source files intentionally excluded from formatting/testing without clear reason.

Return material drift and cleanup opportunities.

---

# Optional researcher lens

Use `researcher` only for a **specific external assumption** whose truth matters. For a material P0-P2 finding whose resolution depends on authoritative upstream/API behavior, run the researcher assignment in parallel with the required local scout and reconciliation workflow below; do not defer an answerable question to optional follow-up.

Good research questions:

- Does current Pi expose this hook on synthetic/custom-message turns?
- Does current Pi send custom-message `details` into model context?
- What exact precedence does Pi apply to `--tools`, `--no-tools`, and `--exclude-tools`?
- Does current Herdr return this identity/state field?
- Is a documented upstream behavior still true in the supported version range?

Bad research assignment:

> Research Pi and Herdr generally.

Require:

- current official or primary sources;
- exact version/date relevance;
- direct answer;
- only evidence material to the local finding.

External research must verify local assumptions, not broaden the audit into product research.

# Material uncertainty resolution

Whenever a material P0-P2 finding depends on an external or unverified runtime assumption, the lead reviewer must actively resolve it while keeping the audit read-only:

1. Assign one narrowly scoped local `scout` to trace the repository's actual path, installed dependency/source if available, launch arguments, and discriminating tests.
2. When authoritative upstream/API behavior is material, assign one narrowly scoped `researcher` in parallel, limited to the supported version range and primary sources.
3. Have the lead reviewer reconcile the local scout result and, when assigned, the researcher result; classify the outcome as verified runtime behavior, documentation/contract mismatch, test gap, or a bounded `Unverified risk` only when the evidence cannot establish it.
4. Where relevant, distinguish restored history/identity from current runtime configuration, and source-level evidence from a real-process integration guarantee.
5. Include exact evidence, version scope, remaining limitation, and the one targeted smoke test or upstream question needed if it genuinely cannot be resolved.

Do not leave an answerable question as a generic optional follow-up. These assignments and the reconciliation remain read-only.

---

# Cross-surface contract matrix

The lead reviewer must explicitly compare these chains.

## 1. Input contract

```text
tool schema
↔ tool description
↔ runtime validation
↔ errors
↔ docs
↔ tests
```

## 2. Capability contract

```text
definition
↔ override
↔ effective configuration
↔ launch arguments
↔ actual role/depth
↔ prompt/tool availability
↔ presentation
```

## 3. Instruction contract

```text
controller contract
↔ shared agent contract
↔ role body
↔ skills
↔ dynamic results
```

## 4. Identity contract

```text
label
↔ definition
↔ session
↔ request
↔ owner
↔ Herdr identity
↔ result/error/UI fields
```

## 5. State contract

```text
Herdr/Pi/mailbox evidence
↔ public state
↔ steerable
↔ tool eligibility
↔ displayed state
↔ next-action guidance
```

## 6. Completion contract

```text
agent completion
↔ durable result
↔ result file
↔ owner custom message
↔ LLM-visible content
↔ human rendering
↔ cleanup convergence
```

## 7. Configuration contract

```text
source syntax
↔ parsing
↔ merge
↔ validation
↔ effective metadata
↔ runtime
↔ persistence/editing UI
↔ documentation
```

## 8. Recovery contract

```text
failure
↔ retained evidence
↔ rollback ownership
↔ structured error
↔ model guidance
↔ human guidance
↔ safe retry boundary
```

## 9. Distribution contract

```text
repository
↔ package manifest
↔ installed files
↔ discovered extension/skill/docs
↔ maintainer instructions
```

A finding that appears only within one file is usually less important than a mismatch across one of these chains.

---

# Mandatory context comparisons

Many agentic bugs exist only at boundaries. Check these explicitly.

## Controller depth

Compare:

```text
root
direct agent / parent
nested child / leaf
unmanaged session
```

Ask whether the same definition, prompt, tool list, metadata, and instructions remain truthful in each context.

## Agent generation

Compare:

```text
fresh
exact-session continuation
fork
```

Ask what is re-resolved for each new agent generation and what historical Pi
session context remains stable.

## Visibility

Compare:

```text
LLM-visible content
structured details
TUI rendering
plain/RPC/JSON mode
logs/files
```

Never assume metadata visible to a renderer is visible to the model.

## Outcome

Compare:

```text
success
blocked
failure
rollback failure
close
cleanup pending
overflow/truncation
restart recovery
```

## Configuration state

Compare:

```text
bundled only
matching partial override
standalone global definition
empty override fields
explicit false
explicit []
invalid definition
```

---

# Defect taxonomy

Use these labels consistently.

## `CONTRADICTION`

Two authoritative surfaces prescribe incompatible behavior.

Example:

```text
role prompt: delegate to scout
runtime context: this agent is a leaf and cannot receive agent assignments
```

## `GAP`

The system requires knowledge or behavior that no appropriate instruction/result supplies.

Example:

```text
completion delivered without identifying which parallel agent produced it
```

## `GHOST_CAPABILITY`

Instructions or metadata claim a capability unavailable in the real execution context.

## `HIDDEN_CAPABILITY`

A required runtime capability exists but the agent lacks enough guidance to use it safely.

## `DUPLICATE_AUTHORITY`

The same normative rule is owned by multiple instruction layers.

## `AUTHORITY_LEAK`

A lower-level role/prompt owns policy that should be controlled by a higher-level orchestration or safety boundary.

## `CONTEXT_MISMATCH`

A rule is correct in one lifecycle/depth/visibility mode but incorrectly reused in another.

## `IDENTITY_AMBIGUITY`

A field, label, or display string has more than one semantic meaning or loses exact correlation.

## `STATE_AMBIGUITY`

Displayed or instructed state does not map cleanly to legal next actions.

## `RESULT_OPACITY`

The receiver lacks source, outcome, correlation, or next-action evidence.

## `FAIL_OPEN`

Missing/ambiguous evidence causes the system to proceed when it should reject or preserve state.

## `DRIFT`

Code, tests, docs, package metadata, examples, or prompts describe different generations of the system.

## `TEST_BLIND_SPOT`

A material public contract lacks a discriminating regression.

## `TOKEN_WASTE`

Static instructions/results repeatedly spend model context without changing behavior or improving the next decision.

## `DEAD_COMPLEXITY`

Compatibility, abstraction, state, configuration, or code has no current justified owner/use.

## `UX_AMBIGUITY`

Human presentation makes the system harder to understand even when runtime behavior is correct.

Create another label only when none of these accurately describes the issue.

---

# Severity

Use four levels.

## P0

Can produce unsafe/destructive behavior, wrong-target control, security/trust-boundary violation, data loss, or corrupt durable state.

## P1

Can materially cause an agent to take the wrong action, become stuck, mis-handle delegation/lifecycle, or misunderstand an authoritative result.

## P2

Produces meaningful confusion, drift risk, redundant authority, weak diagnostics, avoidable context cost, or recurring maintainer mistakes.

## P3

Small cleanup, naming, presentation, or maintainability issue with little immediate behavioral risk.

Do not inflate severity because a finding is interesting.

---

# Evidence standard

Every material finding needs at least two sides when it is a cross-surface mismatch.

Use:

```text
Finding
  A: exact claim/behavior + source location
  B: conflicting/missing claim/behavior + source location
  Runtime consequence
  Minimal correction
```

Do not report speculative architectural preferences as defects.

If evidence remains incomplete after the material uncertainty resolution workflow:

```text
Unverified risk
```

and say exactly what evidence, version scope, limitation, and targeted smoke test or upstream question would establish or dismiss it. Do not use this label for an answerable question that was not investigated.

A scout's conclusion is evidence, not authority. The lead reviewer independently verifies every P0/P1 and any P2 that drives architectural change.

---

# Audit heuristics

Actively search for these patterns.

## "Who owns this sentence?"

For every normative instruction, ask:

> If this wording changes, what is the one file/layer that should change?

If the answer is multiple files, there is likely duplicate authority.

## "Can the recipient act on this?"

For every tool result/error/message, ask:

> After reading only the model-visible form of this result, can the receiving agent identify the source, understand the state, and choose the next legal action?

If not, there is a result gap.

## "Can the agent actually do what it is told?"

For every role instruction, compare against effective runtime capabilities in every possible depth.

## "Does runtime enforce the important part?"

Safety, ownership, identity, validation, and data-loss boundaries must not depend only on prompts.

## "Does code know something the model does not?"

Look especially at:

- `details`;
- hidden metadata;
- UI-only fields;
- internal IDs;
- cleanup evidence;
- capability inference;
- state subconditions.

## "Does the model know something code does not enforce?"

Look for instructions such as:

```text
only once
never overlap
must wait
exact owner
read-only
do not broaden scope
```

Determine which are strategic conventions and which require enforcement.

## "What changes at session continuation?"

Anything resolved at generation time but described as if dynamically refreshed is suspect.

## "What changes at root/child depth?"

Anything defined globally but projected differently by controller depth is suspect.

## "What was deleted but still has a shadow?"

Search docs, tests, package files, comments, compatibility branches, field names, and examples for removed concepts.

## "Is this test capable of failing for the old bug?"

Prefer discriminating regressions over assertion volume.

## "Is the same fact sent twice?"

Check model messages and human rendering for:

- result path;
- agent identity;
- model;
- state;
- warnings;
- next-action text.

---

# Efficiency rules

Do not turn this into a repository-wide file-reading contest.

1. Start from entry points and contract surfaces.
2. Trace callers before declaring a local bug.
3. Have scouts use search/grep to map ownership before opening large files.
4. Each scout stays within its assigned lens.
5. Researcher receives specific questions only.
6. Reviewer verifies material scout findings, not every line scouts inspected.
7. Do not spawn another agent merely to confirm `No findings.`
8. Use a targeted second reviewer only for an uncertain P0/P1 or a disputed architectural conclusion.
9. Do not assign an implementer during diagnosis.
10. Stop when the contract matrix is covered and new searches produce no materially new issue class.

The objective is maximum useful insight per agent, not maximum agent count.

---

# Lead-reviewer output

Return one report in this order.

## 1. Verdict

Exactly one:

```text
PASS
PASS WITH FINDINGS
FAIL
```

`PASS` means no material P0-P2 findings after the required surfaces were covered.

## 2. Executive summary

At most five bullets covering the highest-impact system-health conclusions.

## 3. Findings

Order by severity, then confidence.

Format:

```text
[P1][CONTEXT_MISMATCH] Nested reviewer is instructed to delegate but launches as a leaf

Evidence:
- extension/agent-definitions/reviewer.md: ...
- extension/index.ts: ...

Why it matters:
...

Minimal durable fix:
...

Confidence: high
```

For contradictions, quote or precisely paraphrase both competing contracts.

Do not bury findings in prose.

## 4. Instruction ownership map

Summarize the desired/current ownership of:

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

Flag only ownership collisions that remain after de-duplication.

## 5. Contract coverage

Mark each as:

```text
verified
finding
not applicable
not verified
```

for:

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

Do not claim whole-system PASS with an unexplained `not verified`.

## 6. Healthy invariants

List only important invariants that were explicitly checked and found coherent.

This prevents future reviewers from reopening already-verified architecture without evidence.

## 7. Remediation order

Give the shortest dependency-aware sequence.

Prefer:

```text
fix root contract once
→ delete duplicate instructions
→ update focused tests
→ update canonical docs
```

over one patch per symptom.

Call out deletions and consolidations explicitly.

## 8. Optional follow-up

Only include:

- a targeted runtime smoke that would materially increase confidence when the required workflow could not establish or dismiss the assumption;
- a specific upstream question still unresolved when the required workflow could not establish or dismiss it;
- a separate implementation task justified by the findings.

Do not append generic "more testing" advice or use optional follow-up for an answerable material uncertainty.

---

# Orchestrator finalization

The orchestrator should normally return the lead reviewer's synthesized report rather than writing a second competing review.

Before returning, check only:

- Did the audit cover all required contract chains?
- Are P0/P1 findings backed by exact evidence?
- Are duplicate scout findings consolidated?
- Does every proposed fix identify the correct root owner rather than a symptom?
- Did every material P0-P2 external or runtime uncertainty go through the required local/upstream verification and lead reconciliation?
- Are only bounded unresolved claims labeled `Unverified risk`, with exact evidence and limitations?
- Is implementation work clearly separated from diagnosis?

If a material P0-P2 finding remains uncertain after the required workflow, report it only as a bounded `Unverified risk` with the evidence, version scope, limitation, and targeted smoke test or upstream question that would resolve it. Do not leave an answerable question unresolved or in optional follow-up.

Otherwise stop.

---

# After the audit

Do not automatically fix findings.

If implementation is requested later:

1. use the audit report as the canonical scope artifact;
2. assign the smallest capable `implementer`;
3. keep unrelated cleanup out unless the audit proved it simplifies the same root cause;
4. after implementation, assign one independent `reviewer` against the audit findings and final diff;
5. run focused and full validation appropriate to the repository.

The audit itself remains read-only.

---

# Success criteria

A successful audit should make it possible to answer all of these without ambiguity:

```text
What is every agent allowed to do?
What is every agent told to do?
Which layer owns each instruction?
Which identity is authoritative for each operation?
What does every public state permit next?
What changes by root/parent/child depth?
What changes by definition/session/fork lifecycle?
What does the model actually see versus the UI?
Can every result be attributed to its source?
Can every failure be acted on safely?
Does configuration produce the capability/prompt that presentation claims?
Do tests discriminate the important contracts?
Do docs and package contents describe the shipped system?
Is any important rule duplicated?
Is any important rule missing?
Is any complexity present without a current need?
```

If any answer requires guessing, the audit is not complete.
