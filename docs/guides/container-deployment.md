# Container deployment

[Documentation index](../README.md)

Run Pi Herdsman as a portable SSH-accessible coding-agent environment with Pi, Herdr, developer tools, and persistent state.

## Quick start

The repository includes a ready-to-use [compose.yaml](../../compose.yaml)
with a prebuilt image, SSH access, and persistent Docker-managed volumes.
You need Docker Compose and an SSH public key (for example,
`~/.ssh/id_ed25519.pub`).

If you cloned the repository, use its root directory. Otherwise, download
the Compose file into a new directory:

```sh
mkdir -p pi-herdsman && cd pi-herdsman
curl -fsSLO https://raw.githubusercontent.com/boadij/pi-herdsman/main/compose.yaml
```

Choose [Tailscale](#use-tailscale) or a [host bind mount](#use-a-host-bind-mount)
before first start if needed, to avoid changing networking or migrating data
later. The default named volumes require no permission setup. Optional deployments
record their Compose file selection in a local `.env`, so subsequent commands
use the same networking and storage configuration.

Start:

```sh
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" docker compose up -d
```

Connect from the Docker host:

```sh
ssh -p 2222 herdsman@localhost
```

For a remote connection, replace `localhost` with the Docker host's name or
address. The default configuration publishes SSH port 2222 on the host's
network interfaces; restrict network access accordingly. SSH requires a
public key and does not permit password login.

Herdr opens automatically. Select a workspace and run:

```sh
pi
```

Use `/login` if Pi needs model-provider authentication.

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

If you downloaded only the base Compose file, also download the
[Tailscale overlay](../../compose.tailscale.yaml) into the same directory:

```sh
curl -fsSLO https://raw.githubusercontent.com/boadij/pi-herdsman/main/compose.tailscale.yaml
```

In the same directory, set the selected Compose files and tailnet hostname in
`.env` (create it if needed):

```dotenv
COMPOSE_FILE=compose.yaml:compose.tailscale.yaml
TAILSCALE_HOSTNAME=pi-herdsman
```

`COMPOSE_FILE` is a native Docker Compose setting: plain `docker compose`
commands now include the Tailscale overlay automatically. If you also want a
[bind-mounted home](#use-a-host-bind-mount), use this **single** `COMPOSE_FILE`
value instead:

```dotenv
COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml
```

Keep any other `.env` settings when editing it. The `:` separator applies on
Linux and macOS; use `;` on Windows. Shell-level `COMPOSE_FILE` and explicit
`-f` arguments can override this selection. Setting `COMPOSE_FILE` also
disables automatic `compose.override.yaml` discovery: if an existing stack
uses that file, either keep the default discovery behavior or include it
explicitly in the selected file list.

Tailscale needs `/dev/net/tun` and the networking capabilities declared in
the overlay. Nested containers (for example, Proxmox LXC) may require host-side
TUN passthrough first. Configure that on the host; Herdsman does not do it.
Create a non-ephemeral auth key in your Tailscale admin console. In a
**Bash** shell, enter the key without echoing it or including it in command
history (other shells need their own hidden-input equivalent):

```bash
printf 'Tailscale auth key: '
IFS= read -rs TS_AUTHKEY
printf '\n'
export TS_AUTHKEY
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" docker compose up -d
```

Verify Tailscale has authenticated:

```sh
docker compose exec tailscale tailscale status
```

After successful registration, stop passing the bootstrap key and apply the
key-free configuration:

```sh
unset TS_AUTHKEY
docker compose up -d
```

The sidecar persists `/var/lib/tailscale` and uses `TS_AUTH_ONCE=true` to
reuse its identity on subsequent starts. If you saved `TS_AUTHKEY` in `.env`
instead, remove it after registration and apply the configuration again. Do
not share `docker compose config` output while a key is configured: it can
expose container environment values. The key-free recreate does not erase
copies of credentials previously stored outside the active container.

Connect (with Tailscale and MagicDNS working on the client):

```sh
ssh herdsman@pi-herdsman
```

For a different hostname, set `TAILSCALE_HOSTNAME` in `.env`, and connect
to that name. Add the machine to Herdr with:

```sh
herdr machine add ssh://herdsman@pi-herdsman --label my-herd
```

Tailscale provides networking only. SSH remains normal OpenSSH.

## Update

To update the Pi runtime inside the container, finish active coordination
first, then run:

```sh
pi update
```

Pi downloads the complete official release into an immutable directory under
`~/.local/share/pi-herdsman/pi/releases/` and atomically selects it. New Pi
processes use that release; already-running processes continue using their
original files. The selection survives container restart and recreation and
takes precedence over the Pi bundled in a newer image. Pulling an image does
not replace this persistent selection, so review it separately for Pi security
updates. Forced reinstallations create additional retained release directories;
the container does not prune them.

Pi's `pi update --all` follows upstream behavior: installed packages are
updated before the Pi runtime, so the operation is not transactional. For
operationally significant updates, stop coordination and run the Pi update and
package updates as separate operations.

To recover to the image-bundled Pi after stopping work, remove only the
selection symlink:

```sh
rm ~/.local/share/pi-herdsman/pi/current
pi --version
```

Do not delete the release directories or the persistent home. The bundled
runtime remains available at `/opt/pi`.

To update Herdsman or other installed Pi packages, finish active coordination
first, then run:

```sh
pi update npm:pi-herdsman
```

Run `/reload` in each affected Pi session to adopt the update; running sessions
do not adopt it automatically. No container restart is needed. If builds
overlap, incompatible coordination fails closed rather than proceeding.

To update the image-owned Pi and Herdr runtimes, finish active work first,
then run from the same Compose project directory:

```sh
docker compose config --quiet
docker compose pull
docker compose up -d
```

For optional deployments, the project's `.env` keeps `COMPOSE_FILE` fixed
across these commands. Keep that file and the selected overlays alongside
`compose.yaml`. Existing deployments that used explicit `-f` options should
first record their full selection in `.env`, or continue using **the same**
`-f` list for every operation. Otherwise, a base-only recreation can change
published ports and mounted home data. A Compose-management UI must likewise
use the chosen file list; do not assume it discovers custom overlays.
Container recreation terminates running processes.

Persistent state, including the npm-managed Herdsman version, survives container
replacement. A Herdsman update may require a newer image for a compatible Pi and
Herdr runtime.

## Use a host bind mount

The default Docker-managed volume needs no manual permission setup. Configure
a bind mount before first start if you want to avoid later state migration.
The [optional bind-mount overlay](../../compose.bind-mount.yaml) replaces only
Herdsman's home mount; SSH host identity remains in a named volume.

If you downloaded only the base Compose file, get the overlay:

```sh
curl -fsSLO https://raw.githubusercontent.com/boadij/pi-herdsman/main/compose.bind-mount.yaml
```

For a Linux or NAS bind mount, prepare the directory for the UID/GID the
container will use:

```sh
PUID=1035
PGID=65537

mkdir -p ./data/herdsman-home
sudo chown "$PUID:$PGID" ./data/herdsman-home
sudo chmod go-w ./data/herdsman-home
```

Use the same IDs and persistent file selection in the project-local `.env`:

```dotenv
PUID=1035
PGID=65537
COMPOSE_FILE=compose.yaml:compose.bind-mount.yaml
```

For Tailscale **and** a bind-mounted home, select all three files instead:

```dotenv
COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml
```

Keep only one `COMPOSE_FILE` setting. Then start with the normal command:

```sh
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" docker compose up -d
```

OpenSSH requires the home directory to be owned by root or the login user and
not writable by group or others. The container validates this at startup but
does not change ownership or permissions of host bind mounts. Changing from
an existing named volume to a bind mount is a separate data migration, not an
automatic conversion.

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

Running processes do not survive a container restart. Named volumes survive
`docker compose down`, but `docker compose down -v` deletes them; do not use
`-v` when retaining state.

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
