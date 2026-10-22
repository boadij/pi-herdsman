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

**Already have Pi and Herdr?**

```sh
pi install npm:pi-herdsman
herdr integration install pi
```

The bootstraps install missing components and preserve compatible newer
versions. If installation fails, follow the reported recovery instructions.
For manual installation, see [Pi's Quickstart](https://pi.dev/docs/latest/quickstart)
and [Herdr's installation guide](https://herdr.dev/docs/install/).

## Start Pi in Herdr

In your project directory, start Herdr, then Pi in its pane:

```sh
herdr
pi
```

## Delegate your first task

If Pi needs model authentication, use `/login` and select a provider. Then ask
Pi to use the bundled `scout` Agent for a read-only reconnaissance task:

```text
Use scout to identify this repository's main entry points.
Explain how the application starts. Don't change any files.
```

Delegation starts after Herdsman accepts the task. The Agent works
asynchronously, and its result returns to the exact Pi session that delegated
it. You can continue working while it runs.

## Manage work with `/herdsman`

Use `/herdsman` to discover controls for your work. For command details, see
[Commands](reference/commands.md).
