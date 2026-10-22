# Getting started

[Documentation index](README.md) · [Coordination API](coordination-api.md)

This guide takes you from installation to your first asynchronous delegation.
You can ask Pi normally; you do not need to call coordination tools yourself.

## 1. Prerequisites and installation

Pi Herdsman requires Node.js 22.19 or newer, as specified by the released
package's [`engines.node`](../package.json) requirement. The Linux/macOS
bootstrap also requires Node.js and npm to be installed before you run it.

For installing Pi and setting up a provider, see [Pi's official
Quickstart](https://pi.dev/docs/latest/quickstart). Pi and herdr versions listed
in the package metadata are tested minimums; the Linux/macOS bootstrap preserves
newer existing installations.

### Linux and macOS

Install the released stack with the bootstrap:

```sh
curl -fsSL https://raw.githubusercontent.com/boadij/pi-herdsman/main/install.sh | sh
```

Or, if you already manage Pi and herdr yourself, install Herdsman and its
Herdr integration:

```sh
pi install npm:pi-herdsman
herdr integration install pi
```

### Windows

Install Pi and herdr using their native Windows instructions; the Herdsman shell
bootstrap supports Linux and macOS only. See [Herdr's installation
instructions](https://herdr.dev/docs/install/)
and [Pi's official Quickstart](https://pi.dev/docs/latest/quickstart), then
install Herdsman and its Herdr integration:

```sh
pi install npm:pi-herdsman
herdr integration install pi
```

For an SSH-ready Docker deployment, see
[Container deployment](guides/container-deployment.md). Docker uses separate,
deterministic runtime pins.

## 2. Start herdr and Pi

In your project directory, start herdr:

```sh
herdr
```

Then start Pi inside a herdr pane:

```sh
pi
```

Herdsman manages background Agents through herdr, so start Pi inside herdr for
delegation.

## 3. Configure Pi authentication if needed

If Pi does not yet have access to a model, run `/login` and select a provider.
Use `/model` to choose another available model when necessary. You do not need
to log in again if Pi already has a working model. Pi owns provider
authentication and credentials; do not copy credentials into Herdsman's
configuration.

## 4. Delegate a first read-only task

Ask Pi to use the bundled `scout` Agent for a read-only reconnaissance task:

```text
Use scout to identify this repository's main entry points.
Explain how the application starts. Don't change any files.
```

This is a read-only example, not an operating-system sandbox. Delegation starts
only after Herdsman accepts the assignment. Once accepted, the Agent works
asynchronously and its result returns to the exact Pi session that delegated
it.

## 5. Understand asynchronous completion

Your conversation remains available while the Agent works. Continue normal
work; you do not need to repeatedly check or poll the Agent. Its result or a
question needing your attention is delivered to the owning conversation.
Pending work is not a completed result.

See [Lifecycle](concepts/lifecycle.md) for the exact assignment and result
behavior.

## 6. Inspect and control work

Open the `/herdsman` menu to discover controls for your work. Its destinations
are:

```
Execution
Agents
Project manager
Session stats
Definitions
Settings
Advanced…
```

The status widget also presents current managed work and transient startup
activity. Presentation is not control authority; operations revalidate identity
and lifecycle state. See [Commands](reference/commands.md) for exact command
semantics and [Status widget](reference/status-widget.md) for status details.

## 7. Customize and scale when needed

Definitions configure Agent models, tools, skills, extensions, instructions,
and permitted delegation. Continue with:

- [Agent definitions](guides/agent-definitions.md)
- [Customizing bundled Agents](guides/customizing-agents.md)
- [Agent-definition schema](reference/agent-definition-schema.md)
- [Configuration](reference/configuration.md)

For independent branch-based project work, an eligible Lead can enter Manager
mode with `/manager`. Manager coordinates durable work across Leads; it is not
required for ordinary Agent delegation. See
[Project orchestration](guides/project-orchestration.md) and
[Coordination](concepts/coordination.md).

## First-use recovery

| Problem                         | Next action                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `pi` command unavailable        | Follow [Pi's installation and PATH instructions](https://pi.dev/docs/latest/quickstart).              |
| `herdr` unavailable             | Follow [Herdr's installation instructions](https://herdr.dev/docs/install/).                          |
| No usable Pi model              | Configure authentication through Pi with `/login`.                                                    |
| Herdsman inactive outside herdr | Start Pi inside herdr.                                                                                |
| Delegation rejected             | Follow the structured error and next action reported by Herdsman; see [Recovery](guides/recovery.md). |
| Agent result not yet available  | Continue normal work; pending work is not completion.                                                 |

If `/herdsman` is missing, check that the Herdsman extension is enabled in
Pi's native `pi config`, then restart Pi inside Herdr.

For the full human-facing command behavior, see [Commands](reference/commands.md).
