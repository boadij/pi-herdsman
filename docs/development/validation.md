# Development validation

[Documentation index](../README.md)

Repository handoff is not complete until the current validation gates have been
run or a concrete environment blocker is recorded.

## Validation order

Focused tests, smoke testing, review, and all intermediate checks happen first.
Do not format during those phases. Once implementation and review are
complete, run the following as the final pre-commit sequence:

```sh
# Final pre-commit mutation; run once only.
prettier . --write

# Read-only verification before staging or committing.
npm run check
git diff --check
```

Do not run formatting again between these verification commands and staging or
committing.

When reviewing staged work, also run as appropriate:

```sh
git diff HEAD --check
```

## What `npm run check` does

The repository check command runs the complete Node test set in one detached,
isolated process group with a bounded suite deadline. Node's native TypeScript
support strips types while loading the source, and the test runner discovers
the `.test.ts` files automatically.

The test runner uses:

```text
--experimental-test-module-mocks
--test
--test-timeout=10000
```

## Process containment

The test runner runs in a detached POSIX process group.

On the suite deadline, the runner attempts:

1. `SIGTERM`;
2. a bounded grace period;
3. `SIGKILL` when required;
4. bounded proof that the process group disappeared.

A test runner that leaks descendants after normal exit is reported as a failure
and cleaned through the same group boundary.

Windows is not supported by this process-group validation runner.

## Focused tests

During implementation, use Node's direct test runner through the normal npm
interface:

```sh
# all tests
npm test

# one test file
npm test -- extension/<area>.test.ts

# one test name within a selected file
npm test -- --test-name-pattern="<pattern>" extension/<area>.test.ts
```

For supervision changes, useful focused examples are:

```sh
npm test -- extension/supervision.test.ts
npm test -- --test-name-pattern="lease" extension/supervision.test.ts
npm test -- --test-name-pattern="inspect" extension/controller-api.test.ts
```

These are command examples, not recorded results. Live Pi/herdr acceptance is
tracked separately in [Smoke testing](smoke-testing.md).

File selection is the primary focusing mechanism. A name pattern narrows the
tests within the selected file; it does not select which files Node loads.

After focused tests, smoke testing, review, and intermediate checks are
complete, run the final pre-commit sequence above. The full repository check is
the read-only verification step:

```sh
npm run check
```

`npm run check` remains the bounded full check, including process-group cleanup
when the test runner times out or leaks descendants.

## Dependency availability

A fresh auxiliary worktree may not contain `node_modules`.

Do not silently install dependencies as part of a source-only task unless that
installation is authorized. If validation uses an existing dependency tree via a
temporary link, record that fact and remove the link afterward.

## Failed or non-converging check

Record:

- exact command;
- exit/result classification;
- process evidence when relevant;
- cleanup result;
- whether failure is source-related or environment-related.

Do not claim a passing full check from a partial focused run.

## Live verification

Deterministic tests are the repository gate. Cross-process Pi/herdr behavior may
also require the live smoke suite.

See [Smoke testing](smoke-testing.md).
