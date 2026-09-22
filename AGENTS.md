# Repository Project-Local AGENTS.md

## Repository documentation

All repository-local documentation must describe only the current extension
behavior.

- Keep `SKILL.md`, `docs/reference/`, `docs/guides/`, and all other docs
  current-version-only.
- Do not add historical release, migration, legacy-name, or compatibility
  guidance for removed behavior.
- Document only verified current semantics and known limitations.

## Instruction and interface design

Repository changes must follow the principles in
[Instruction and interface design](docs/development/instruction-interface-design.md).

Apply them across runtime behavior, model-facing instructions, tools, schemas,
state, validation, documentation, tests, and public interfaces.

## Runtime / skill instruction synchronization

The runtime operational contract must be self-contained. Loading root
`SKILL.md` must never be required for a lead session, delegating agent, or
managed agent to operate Pi Herdsman correctly.

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

## Runtime instruction authority

Runtime behavior and authoritative runtime contracts define Herdsman's
operational semantics. `SKILL.md`, documentation, examples, and tests project
those semantics; they do not independently redefine them.

The runtime contract must remain sufficient without loading `SKILL.md`.
`SKILL.md` may reinforce high-salience invariants and add strategy, rationale,
examples, and recovery detail.

When changing an invariant:

1. change its authoritative source first;
2. update only affected projections;
3. remove obsolete or overlapping reinforcement;
4. verify that all remaining representations preserve the same meaning.

A behavioral invariant may be reinforced at multiple model-facing decision
points when timing or salience materially affects reliability. Those projections
must preserve one meaning and must not evolve into independent rules.

Do not add runtime skill loading, generated prompt files, a prompt registry, or
another synchronization subsystem merely to keep prose copies aligned.

## Code map

- `extension/index.ts`: Extension integration and controller/agent lifecycle.
- `extension/agent-definitions.ts`: Agent-definition discovery, validation, overrides, and launch arguments.
- `extension/herdr.ts`: Herdr topology, startup, shutdown, and process ownership.
- `extension/mailbox.ts`: Durable mailbox protocol and record persistence.
- `extension/core.ts`: Shared lifecycle and message-preparation logic.
- `extension/errors.ts`: Structured extension error categories.
- `extension/lock.ts`: Process-lock ownership.
- `extension/presentation.ts`: Model, TUI, and status presentation.
- `extension/config.ts`: Flat Pi Herdsman configuration.
- `extension/supervision.ts`: Chief lease, supervision projection, lead transport, and staff tool contracts.
- `extension/support.ts`: Shared extension integration-test mocks and fixtures.
- `extension/extension-contract.test.ts`: Extension and model contract behavior.
- `extension/controller-api.test.ts`: Controller authorization and live-control behavior.
- `extension/herdr.test.ts`: Herdr inspection/read and topology contract behavior.
- `extension/controller-lifecycle.test.ts`: Authorized delegation lifecycle behavior.
- `extension/agent-runtime.test.ts`: Managed-agent runtime behavior.
- `extension/recovery.test.ts`: Failure, recovery, and cleanup behavior.
- `extension/commands.test.ts`: `/agents` and `/chief` configuration UI behavior.
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

Focused tests provide development feedback. Focused tests, smoke testing,
review, and all intermediate checks must happen before formatting. Do not
format during those phases. Before handoff, follow the detailed validation
order in [Development validation](docs/development/validation.md): run
`prettier . --write` once as the final pre-commit mutation, then run only the
read-only checks `npm run check` and `git diff --check` before staging or
committing.

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

- Follow the detailed validation order in [Development validation](docs/development/validation.md).
