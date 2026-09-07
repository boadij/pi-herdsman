# Pi Herdsman 🐏

![Pi Herdsman: orchestrate Pi agents as a herd](docs/assets/banner.webp)

**Asynchronous workers for [Pi](https://github.com/earendil-works/pi) in [herdr](https://github.com/herdrdev/herdr).**

Keep the conversation. Delegate the work.

Pi Herdsman combines Pi with [herdr](https://github.com/herdrdev/herdr) to run
managed workers independently while your lead session stays interactive. Keep
talking, planning, and delegating while they work. Results and questions return
to the same lead session when they need attention.

```text
You ↔ lead
      ├─ worker
      │  └─ worker
      └─ worker
```

Pi Herdsman is opinionated about coordination, not workflow. A lead owns its
workers, and a delegation-enabled worker may own permitted workers of its own.
Agent definitions, models, tools, extensions, and development process remain up
to you.

Chief supervision is separate from ownership:

```text
chief
  ├─ herd A / lead A
  │  └─ workers...
  └─ herd B / lead B
     └─ workers...
```

## Demo

![Pi Herdsman delegating a lifecycle fix to an implementer worker while the lead session remains interactive.](docs/assets/demo.gif)

## Install

```sh
pi install npm:pi-herdsman
```

The lead Pi session must run inside herdr.

## Try it

Ask Pi normally:

```text
Use an implementer worker to implement the approved change.
```

That is enough. The implementer runs asynchronously while the lead conversation
remains available.

Other useful requests look the same:

```text
Use scout to map the authentication flow.
Have researcher verify the current upstream API behavior.
Have reviewer inspect this diff for correctness and unnecessary complexity.
Run scout and researcher independently while we continue planning here.
```

Open the human worker management surface at any time with:

```text
/workers
```

To supervise independent leads across the current herdr runtime, use:

```text
/chief
```

Leave chief mode with:

```text
/chief leave
```

See [supervision](docs/concepts/supervision.md) and the
[supervision reference](docs/reference/supervision.md).

For the complete walkthrough, see [Getting started](docs/getting-started.md).

## Why Pi Herdsman?

- **Async by default.** Assignments return after acceptance while workers keep
  running and the owning lead session remains available. Results and owner
  questions return when they need attention.
- **One assignment per worker.** Each managed worker generation handles one
  bounded assignment, delivers its terminal result, and is cleaned up. Continue
  completed context by delegating to the exact returned Pi session.
- **One coordinated system.** Delegation-enabled workers can own and manage
  permitted workers themselves. Identity, ownership, steering, clarification,
  results, and cleanup share the same lifecycle across the hierarchy.
- **Your workflow stays yours.** Use the bundled portable roles, override them,
  or bring your own definitions, models, tools, extensions, and process. Pi
  Herdsman does not prescribe a plan, implementation, or review workflow.
- **Small and disciplined.** Pi Herdsman focuses on orchestration semantics.
  herdr manages physical sessions and placement; Pi keeps owning each
  conversation and turn state.

See [Lifecycle](docs/concepts/lifecycle.md) for the exact asynchronous contract.

## How it works

Pi Herdsman deliberately separates three responsibilities:

- **herdr** owns physical worker lifecycle and placement.
- **Pi Herdsman** owns assignment, clarification, result, and control
  coordination.
- **Pi** owns each session and turn state.

The model-facing tools are `worker`, `chief`, `staff`, and `ask_owner`.
`worker` manages owned assignments, `chief` sends messages or asks to the chief,
`staff` lets the chief supervise leads, and `ask_owner` lets a worker ask its
exact owner. Leads use `chief.message` and `chief.ask`; the active chief uses
`staff.message` and `staff.reply` with exact lead session IDs. Worker labels are
not continuation handles: exact Pi session IDs are the continuation identity.
Exact herdr identifiers are validation evidence behind live worker and lead
identity.

Bundled definitions are portable defaults, not required workflow stages. Global
definitions can override them or add new roles with your preferred models,
tools, extensions, skills, and instructions.

## Requirements

- [herdr](https://github.com/herdrdev/herdr) `>=0.8.0`
- Pi `>=0.84.2 <0.86.0` (the version range tested for this release)
- herdr Pi integration version `2` or newer
- Node `>=22.19.0`

Install or refresh the herdr Pi integration:

```sh
herdr integration install pi
herdr integration status
```

The package manifest loads the bundled extension and exposes the optional
`workers` skill.

## Documentation

Choose the path that matches what you are doing:

- **Using Pi Herdsman:** [Getting started](docs/getting-started.md), then the
  [`/workers` commands](docs/reference/commands.md), [status widget](docs/reference/status-widget.md),
  and [agent definitions](docs/guides/agent-definitions.md).
- **Supervising leads:** [Supervision](docs/concepts/supervision.md), then the
  [supervision reference](docs/reference/supervision.md).
- **Building agent coordination:** [Agent coordination API](docs/agent-api.md),
  then the [`worker` API](docs/reference/worker.md),
  [Lifecycle](docs/concepts/lifecycle.md), and
  [Delegation](docs/concepts/delegation.md).
- **Developing Pi Herdsman:** [Documentation index](docs/README.md) and
  [development validation](docs/development/validation.md).

## Repository validation

```sh
prettier . --write
npm run check
git diff --check
```

See [Development validation](docs/development/validation.md) for the full gate.
