# Getting started

[Documentation index](README.md) · [Coordination API](coordination-api.md)

## Install

**Linux/macOS:** Requires Node.js 22.19+ and npm.

```sh
curl -fsSL https://raw.githubusercontent.com/boadij/pi-herdsman/main/install.sh | sh
```

**Windows:** Run in PowerShell.

```powershell
irm https://raw.githubusercontent.com/boadij/pi-herdsman/main/install.ps1 | iex
```

**Docker Compose:** For a prebuilt SSH-accessible environment instead of a
native installation, follow [Container deployment](guides/container-deployment.md).

**Already have Pi and Herdr?**

```sh
pi install npm:pi-herdsman
herdr integration install pi
```

The native bootstraps install missing components and preserve compatible newer
versions. When `pi-web-access` is not already installed, they ask
`Install pi-web-access? [y/N]`; pressing Enter skips it. Existing installations
are preserved. For automation, set `PI_HERDSMAN_WEB_ACCESS=install` to install
it without prompting or `PI_HERDSMAN_WEB_ACCESS=skip` to skip. Without an
available interactive terminal, it is skipped. If installation fails, follow
the reported recovery instructions.

The Docker distribution includes web access in fresh Pi environments; existing
Docker homes retain their current package state. See
[Container deployment](guides/container-deployment.md#web-access) for package
management and security details. For manual installation, see
[Pi's Quickstart](https://pi.dev/docs/latest/quickstart) and
[Herdr's installation guide](https://herdr.dev/docs/install/).

## Start Pi in Herdr

For a native installation, start Herdr in your project directory, then Pi
in its pane:

```sh
herdr
pi
```

With Docker, [connect to the container](guides/container-deployment.md#quick-start)
and run `pi` in the Herdr pane instead.

## Delegate your first task

If Pi needs model authentication, use `/login` and select a provider. Then ask
Pi to use the bundled `scout` Agent for a read-only reconnaissance task:

```text
Use scout to identify this repository's main entry points.
Explain how the application starts.
```

Delegation starts after Herdsman accepts the task. The Agent works
asynchronously, and its result returns to the exact Pi session that delegated
it. You can continue working while it runs.

## Manage work with `/herdsman`

Use `/herdsman` to discover controls for your work. For command details, see
[Commands](reference/commands.md).
