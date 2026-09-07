# Repository Project-Local AGENTS.md

## Repository documentation

All repository-local documentation must describe only the current extension
behavior.

- Keep `SKILL.md`, `docs/reference/`, `docs/guides/`, and all other docs
  current-version-only.
- Do not add historical release, migration, legacy-name, or compatibility
  guidance for removed behavior.
- Document only verified current semantics and known limitations.

## Runtime / skill instruction synchronization

The runtime operational contract must be self-contained. Loading root
`SKILL.md` must never be required for a lead session, delegating worker, or
managed worker to operate Pi Herdsman correctly.

`SKILL.md` intentionally repeats mandatory runtime operational instructions as
optional reinforcement for long contexts and may add strategy, rationale,
examples, recovery detail, and product guidance.

When changing mandatory operational behavior or guidance:

1. update the corresponding runtime instructions in `extension/index.ts`;
2. update the matching mirrored operational section in `SKILL.md` in the same
   change;
3. update affected canonical documentation and focused contract tests;
4. never introduce a mandatory operational requirement only in `SKILL.md`.

Runtime instructions are authoritative if surfaces conflict. Do not remove
useful mirrored guidance from `SKILL.md`, and do not make runtime load, parse,
or depend on the skill.

## Code map

- `extension/index.ts`: Extension integration and controller/worker lifecycle.
- `extension/agents.ts`: Agent-definition discovery, validation, overrides, and launch arguments.
- `extension/herdr.ts`: Herdr topology, startup, shutdown, and process ownership.
- `extension/mailbox.ts`: Durable mailbox protocol and record persistence.
- `extension/core.ts`: Shared lifecycle and message-preparation logic.
- `extension/errors.ts`: Structured extension error categories.
- `extension/lock.ts`: Process-lock ownership.
- `extension/presentation.ts`: Model, TUI, and status presentation.
- `extension/settings.ts`: Persistent Pi Herdsman settings.
- `extension/supervision.ts`: Chief lease, supervision projection, lead transport, and staff tool contracts.
- `extension/support.ts`: Shared extension integration-test mocks and fixtures.
- `extension/extension-contract.test.ts`: Extension and model contract behavior.
- `extension/controller-api.test.ts`: Controller authorization and live-control behavior.
- `extension/herdr.test.ts`: Herdr inspection/read and topology contract behavior.
- `extension/controller-lifecycle.test.ts`: Authorized delegation lifecycle behavior.
- `extension/worker-runtime.test.ts`: Managed-worker runtime behavior.
- `extension/recovery.test.ts`: Failure, recovery, and cleanup behavior.
- `extension/commands.test.ts`: `/workers` and `/chief` configuration UI behavior.
- `extension/supervision.test.ts`: Chief roles, lease, supervision, transport, and staff tool behavior.
- `extension/supervision-malformed-cleanup.test.ts`: malformed supervision cleanup behavior.

## Development loop

During implementation, run the smallest relevant test file first:

```sh
npm test -- extension/<area>.test.ts
```

Narrow further when useful:

```sh
npm test -- --test-name-pattern="<pattern>" extension/<area>.test.ts
```

Focused tests provide development feedback. Before handoff, run the
authoritative final repository gate:

```sh
prettier . --write
npm run check
git diff --check
```

### Testing architecture

- Test behavior at its lowest authoritative layer.
- Integration tests prove wiring and layer crossings, not duplicate lower-layer matrices.
- Table-drive variants of one invariant.
- Keep separate test files only for source boundaries or required process/module-mock isolation.
- Add no dependency or fixture abstraction when `node:test` and a few lines suffice.

Use project-local `.pi-herdsman/` for temporary plans, scopes, specifications,
decisions, investigations, review criteria, and handoff state used to
coordinate repository work. Reuse an adequate artifact instead of creating a
parallel source of truth. These files remain untracked and are not product
documentation.

## Backlog

- The ignored `.backlog/` repository exists only in the main worktree.
  Run Backlog CLI reads and writes from the worktree where `.backlog/` exists;
  do not copy, synchronize, or manually edit it in another worktree.
- For each newly verified material issue, search first, then record the exact
  reproduction, expected and observed behavior, impact, and evidence through
  the CLI. Do not file speculative or duplicate issues; report the task ID,
  impact, and whether it blocks the current work.

## Validation

- Run validation before completing changes: `prettier . --write; npm run check`
