---
name: testing
description: Write and review tests that protect meaningful Herdsman behavior without creating redundant, brittle, or low-value coverage. Use whenever adding, changing, reviewing, or removing tests.
---

# Testing

Tests exist to catch plausible defects, not to increase test count or coverage.

## Before adding a test

Read the changed behavior and nearby tests first.

Add a test only when it protects at least one of:

- observable behavior or an authoritative internal invariant;
- a regression that could plausibly recur;
- a meaningful boundary or state transition;
- a realistic failure, recovery, concurrency, or cleanup path;
- wiring across layers that cannot be established at a lower layer.

If an existing test already proves the behavior, do not add another one.

Do not test:

- trivial getters, assignments, forwarding, or wiring with no independent behavior;
- Node.js, TypeScript, Pi, Herdr, or another dependency's own behavior;
- implementation details when the same contract can be tested directly;
- states already made impossible structurally unless testing the enforcing boundary;
- the same invariant again at every layer;
- mocks rather than the behavior they stand in for.

## Choose the smallest honest layer

Test behavior at its lowest authoritative layer.

Integration tests prove wiring and layer crossings. They do not repeat complete lower-layer behavior matrices.

Use live smoke only when behavior crosses the real Pi/Herdr runtime boundary.

Prefer real local objects, temporary directories, files, and processes. Mock only the boundary that must be controlled to reach otherwise inaccessible behavior or failure.

Use the repository's existing Node test stack. Add no testing dependency unless the existing platform cannot economically establish the required property.

## Make every test discriminate

For a bug fix, the regression test must fail for the defective behavior and pass for the correction.

For new behavior, ask what plausible wrong implementation the test would reject.

If no plausible defect makes the test fail, delete the test.

Expected values must be independent of the production calculation being tested.

Prefer exact behavioral assertions over existence, truthiness, call counts, or snapshots unless those are themselves the contract.

Table-drive variants of one invariant instead of copying tests.

## Failure and lifecycle behavior

Invalid input is not sufficient failure coverage when the meaningful risk is a dependency or lifecycle failure.

When relevant, exercise the actual failure boundary: I/O failure, stale state, interrupted process, failed persistence, timeout, cleanup, recovery, ownership, or state transition.

Test only behavior the contract actually promises. Do not invent retries, fallbacks, errors, or recovery semantics merely to test them.

Avoid sleeps as synchronization. Wait on observable conditions or use deterministic native test facilities where practical.

## Keep the suite smaller

A new test should increase confidence more than maintenance cost.

Delete tests made redundant by stronger tests or structural enforcement.

Do not introduce factories, builders, custom matchers, fixtures, helpers, property testing, fuzzing, mutation tooling, or another framework until repeated concrete need makes the simpler alternative worse.

Follow the repository's existing focused-test and validation contract instead of duplicating it here.
