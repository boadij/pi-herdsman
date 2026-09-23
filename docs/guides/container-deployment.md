# Container deployment

Run Pi Herdsman as a portable SSH-accessible coding-agent environment with Pi, Herdr, developer tools, and persistent state.

## Quick start

Start:

```sh
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" docker compose up -d
```

Connect:

```sh
ssh -p 2222 herdsman@your-host
```

Herdr opens automatically. Select a workspace and run:

```sh
pi
```

That's it.

## Add it to Herdr

```sh
herdr machine add ssh://herdsman@your-host:2222 --label my-herd
```

With an existing `~/.ssh/config` host:

```sh
herdr machine add my-herd --label my-herd
```

The remote machine then appears alongside Local in Herdr.

## Use Tailscale

Start with the Tailscale sidecar:

```sh
TS_AUTHKEY=tskey-auth-... \
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
docker compose \
  -f compose.yaml \
  -f compose.tailscale.yaml \
  up -d
```

Connect:

```sh
ssh herdsman@pi-herdsman
```

Add it to Herdr:

```sh
herdr machine add ssh://herdsman@pi-herdsman --label my-herd
```

Use another hostname:

```sh
TAILSCALE_HOSTNAME=my-herd \
TS_AUTHKEY=tskey-auth-... \
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
docker compose \
  -f compose.yaml \
  -f compose.tailscale.yaml \
  up -d
```

Tailscale provides networking only. SSH remains normal OpenSSH.

## Update

```sh
docker compose pull
docker compose up -d
```

Persistent state survives container replacement.

## Use a host bind mount

For Linux or NAS directories owned by another UID/GID:

```sh
PUID="$(id -u docker-user)" \
PGID="$(id -g docker-user)" \
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
docker compose up -d
```

Or in `.env`:

```dotenv
PUID=1035
PGID=65537
```

The mounted directory must already be writable by those IDs. Herdsman does not change host file ownership.

## Forward your SSH agent

For private Git repositories:

```sh
ssh -A -p 2222 herdsman@your-host
```

## Install another tool

```sh
mise use -g uv@latest
```

Tools installed with mise persist in the home volume.

## What persists?

| Path | Contents |
| --- | --- |
| `/home/herdsman` | Pi and Herdr state, repositories, config, credentials, SSH state, installed tools |
| `/var/lib/herdsman/ssh` | SSH server identity |

Running processes do not survive a container restart.

## Defaults

| Setting | Default |
| --- | --- |
| SSH port | `2222` |
| User | `herdsman` |
| Tailscale hostname | `pi-herdsman` |
| Password login | disabled |
| Root SSH login | disabled |

`SSH_AUTHORIZED_KEYS` is required only on first start. Existing authorized keys are not overwritten.

Pi sessions automatically receive the container environment context from `/AGENTS.md`.

See the [Herdr machine documentation](https://herdr.dev/docs/connecting-machines/) for machine and SSH configuration.
