# Getting started

[Documentation index](README.md) · [Coordination API](coordination-api.md)

This is the shortest path from installation to useful asynchronous delegation.
You do not need to call structured coordination tools yourself.

## 1. Install

You need:

- Node satisfying the released package's `engines.node` requirement
- Pi at least the released package's `piHerdsman.runtime.pi` baseline
- herdr at least the released package's
  `piHerdsman.runtime.herdr.version` baseline

On Linux or macOS, install the released, tested stack:

```sh
curl -fsSL https://raw.githubusercontent.com/boadij/pi-herdsman/main/install.sh | sh
```

The released package publishes its Node, Pi, and herdr runtime requirements.
On mutable host installs, Pi and herdr baselines are minimums; the bootstrap
never downgrades a newer runtime.

For Pi, a missing or older installation is handed to Pi's official managed
installer and the result must meet the tested minimum. Pi's installer chooses
its current managed release, so the installed Pi may be newer than Herdsman's
tested baseline. Afterward, Pi remains natively updateable with `pi update`.

For herdr, a missing or older installation receives the exact checksum-verified
tested release from package metadata. Existing newer installations are left
untouched, and subsequent updates remain native through `herdr update`.

If you already manage Pi and herdr yourself:

```sh
pi install npm:pi-herdsman
herdr integration install pi
```

For an SSH-ready Docker deployment, see
[Container deployment](guides/container-deployment.md). The Docker image is a
separate, deterministic deployment that installs exact Pi and herdr releases
with checksum verification.

## 2. Start herdr and Pi

Start herdr in your project:

```sh
herdr
```

Then start Pi inside the herdr pane:

```sh
pi
```

Pi loads the package extension and optional `agents` skill. A Lead started
outside herdr cannot safely manage herdr-backed Agents.

## 3. Delegate without leaving the conversation

Ask Pi normally:

```text
Use scout to inspect this repository.
```

The Agent starts asynchronously. Once the assignment is accepted, the Lead
conversation remains available while the Agent works.

You can keep discussing the problem, delegate other genuinely independent work,
or end the turn. Do not poll for completion. Results and Agent questions return
to the exact owner when they need attention.

The exact assignment behavior is documented in
[Lifecycle](concepts/lifecycle.md).

## 4. Open the Agent menu

Run:

```text
/agents
```

The native menu provides Running, Session stats, Definitions, Settings, and Stop all.

Use `Running` to focus a verified live Agent. Use `Session stats` to inspect
Pi-native token usage and cost for the current Pi session plus transitively
owned managed-Agent sessions. In active Manager mode, it also includes the Lead
sessions in current durable project assignments and each Lead's transitively
owned Agent sessions. Use `Definitions` to inspect or override the effective
bundled, project, and global roster. Use `Settings` for Manager auto-start,
Layout, context retirement, and message limits; `Layout` controls placement for
future Lead-direct Agents.

See [Commands](reference/commands.md) for the exact human-facing behavior.

## 5. Customize when needed

Pi Herdsman is opinionated about coordination, not your development workflow.
Definitions control models, thinking, tools, skills, extensions, instructions,
and permitted delegation.

Continue with:

- [Agent definitions](guides/agent-definitions.md)
- [Customizing bundled Agents](guides/customizing-agents.md)
- [Agent-definition schema](reference/agent-definition-schema.md)
- [Configuration](reference/configuration.md)

## 6. Observe active work

The status widget shows current managed work and transient startup activity.
Presentation is not control authority: operations still revalidate exact
identity and lifecycle state.

Completed Agent generations are cleaned up after result delivery. Their Pi
sessions remain available for explicit continuation through the model-facing
API.

See [Status widget](reference/status-widget.md) and
[Agents and identity](concepts/agents.md).

## 7. Scale to project orchestration

When one Lead and its Agent tree are no longer the right coordination boundary,
an eligible Lead in the primary workspace can enter Manager mode:

```text
/manager
```

Manager coordinates durable branch-based work across Leads. It does not own
their Agents or implement through an Agent tree of its own. No prior chat turn
or existing linked worktree is required in an ordinary Git primary workspace.

Continue with [Project orchestration](guides/project-orchestration.md). For the
role and authority model, read [Coordination](concepts/coordination.md).

## Next steps

- Keep delegating naturally through the Lead conversation.
- Use [Project orchestration](guides/project-orchestration.md) for independent branch-based work.
- Use [Coordination API](coordination-api.md) when you need exact model-facing interfaces.
- Use [Recovery](guides/recovery.md) only when normal coordination cannot converge safely.
