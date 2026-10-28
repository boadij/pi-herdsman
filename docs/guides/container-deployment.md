# Container deployment

[Documentation index](../README.md)

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

To update Herdsman inside the container, finish active coordination first, then run:

```sh
pi update npm:pi-herdsman
```

Run `/reload` in each affected Pi session to adopt the update; running sessions
do not adopt it automatically. No container restart is needed. If builds
overlap, incompatible coordination fails closed rather than proceeding.

To update the image-owned Pi and Herdr runtimes:

```sh
docker compose pull
docker compose up -d
```

Persistent state, including the npm-managed Herdsman version, survives container
replacement. A Herdsman update may require a newer image for a compatible Pi and
Herdr runtime.

## Use a host bind mount

The default Docker-managed volume needs no manual permission setup.

For a Linux or NAS bind mount, prepare the directory for the UID/GID the
container will use:

```sh
PUID=1035
PGID=65537

mkdir -p ./data/herdsman-home
sudo chown "$PUID:$PGID" ./data/herdsman-home
sudo chmod go-w ./data/herdsman-home
```

Set the same IDs in `.env`:

```dotenv
PUID=1035
PGID=65537
```

Create `compose.bind-mount.yaml` to replace the home volume with the host
directory while keeping the SSH server identity in its named volume:

```yaml
services:
  herdsman:
    volumes:
      - ./data/herdsman-home:/home/herdsman
      - herdsman-ssh:/var/lib/herdsman/ssh
```

Start with both Compose files:

```sh
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
docker compose -f compose.yaml -f compose.bind-mount.yaml up -d
```

OpenSSH requires the home directory to be owned by root or the login user and
not writable by group or others. The container validates this at startup but
does not change ownership or permissions of host bind mounts.

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

| Path                    | Contents                                                                          |
| ----------------------- | --------------------------------------------------------------------------------- |
| `/home/herdsman`        | Pi and Herdr state, repositories, config, credentials, SSH state, installed tools |
| `/var/lib/herdsman/ssh` | SSH server identity                                                               |

Running processes do not survive a container restart.

Run only one active Herdsman runtime against a writable home volume. Linux
lock recovery verifies process identity within the current PID namespace;
independent containers sharing that volume are not supported. Existing Linux
locks without process identity are recovered only when their recorded PID is
absent; an occupied PID remains ambiguous and must be resolved after its
original process has exited.

## Defaults

| Setting            | Default       |
| ------------------ | ------------- |
| SSH port           | `2222`        |
| User               | `herdsman`    |
| Tailscale hostname | `pi-herdsman` |
| Password login     | disabled      |
| Root SSH login     | disabled      |

`SSH_AUTHORIZED_KEYS` is required only on first start. Existing authorized keys are not overwritten.

Pi sessions automatically receive the container environment context from `/AGENTS.md`.

See the [Herdr machine documentation](https://herdr.dev/docs/connecting-machines/) for machine and SSH configuration.
