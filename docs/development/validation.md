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
npm run format

# Read-only verification before staging or committing.
npm run format:check
npm run check
git diff --check
```

Do not run formatting again between these verification commands and staging or
committing.

`npm run format` applies formatting; `npm run format:check` verifies it without
changing files. Both use the locally installed Prettier version pinned by the
lockfile. `npm run check` runs the bounded behavioral test suite,
`npm run validate` composes formatting verification, tests, build, and package
audit, and `git diff --check` checks Git whitespace.

When reviewing staged work, also run as appropriate:

```sh
git diff HEAD --check
```

## What `npm run check` does

The repository check command runs the complete Node test set in one isolated
process tree with a bounded suite deadline. Node's native TypeScript support
strips types while loading the source, and the test runner discovers the
`.test.ts` files automatically.

The test runner uses:

```text
--experimental-test-module-mocks
--test
```

## Process containment

On POSIX systems the test runner runs in a detached process group. On Windows
it runs as a normal child process and uses the native `taskkill.exe /PID <pid>
/T /F` process-tree operation for timeout cleanup.

On POSIX suite deadline, the runner attempts:

1. `SIGTERM`;
2. a bounded grace period;
3. `SIGKILL` when required;
4. bounded proof that the process tree disappeared.

On Windows, the runner invokes `taskkill.exe /PID <pid> /T /F` and waits for
the runner process to disappear.

A test runner that leaks descendants after normal exit is reported as a failure
on POSIX and cleaned through the same process-group boundary. Windows timeout
cleanup covers the runner tree; post-parent descendant leak accounting would
require a Job Object and is not implemented.

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

`npm run check` remains the bounded full check, including platform-appropriate
process-tree cleanup when the test runner times out or leaks descendants.

## Dependency availability

A fresh worktree may not contain `node_modules`.

Before running local validation, ensure dependencies are installed in that
worktree. If `node_modules` is absent, run `npm ci` from that checkout.

### Optional setup for newly created worktrees

The repository includes a `post-checkout` hook that runs `npm ci` synchronously
when Git creates a new linked worktree. It is not enabled automatically. To
enable it, run these steps from the trusted **primary checkout** (not a linked
worktree).

First inspect the configured hook directory and its origin:

```sh
git config --show-origin --get core.hooksPath
```

Inspect its existing executable hooks as well; if `core.hooksPath` is unset,
inspect the repository's default hooks directory using
`git rev-parse --git-path hooks`.

If an existing hook configuration or hook manager would be displaced, retain
that configuration or integrate the script manually; this repository does not
install a dispatcher. `core.hooksPath` selects the whole hooks directory, so
changing it can disable other hooks. If no existing configuration would be
displaced, enable the repository hook locally:

```sh
git config --local core.hooksPath "$(pwd -P)/.githooks"
```

This local, optional setting affects only this repository. Its absolute path
deliberately points all linked worktrees to the same trusted script; ordinary
worktrees share the repository's common Git configuration. Enabling it is an
explicit developer trust decision: creating a new linked worktree in this
repository will run `npm ci`, which may execute dependency lifecycle scripts.
This authorization comes from the developer, not Pi's Agent approval system.
Only enable it for a repository and branches whose code you trust. Do not treat
externally supplied branches as implicitly safe, disable Pi authorization, or
load secrets from the primary checkout into worktrees. npm must also be
available in the environment of the Git process that creates the worktree (for
example, a long-lived Herdr server), not merely in an interactive shell.

The hook applies only to newly created linked worktrees. It does not prepare
existing worktrees, and an installation failure may leave the new checkout in
place even though Git reports failure. Inspect that checkout, resolve the
installation cause, run `npm ci` successfully in it, then retry delegation on
the existing branch. Do not assume failed creation removed the checkout.

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
also require isolated live smoke, selected according to the change being
verified:

```sh
npm run smoke
npm run smoke -- core
npm run smoke -- continuation
npm run smoke -- chief-tree
npm run smoke -- manager-recovery
```

`npm run smoke` defaults to `core`. Run it from an active Herdr-managed Pi
session; it incurs real provider usage and may fail. The smoke model is
configured once through `pi-herdsman.smoke-model` in Git configuration, or
overridden for one run with `--model`. See [Smoke testing](smoke-testing.md) for setup.
Live smoke is opt-in and not part of `npm run validate`. See [Smoke testing](smoke-testing.md)
for its one-invocation project trust scope and isolated runtime boundaries.
