# Container deployment

[Documentation index](../README.md)

Run Pi Herdsman as a portable SSH-accessible coding-agent environment with Pi, Herdr, developer tools, and persistent state.

## Quick start

The repository includes a ready-to-use [compose.yaml](../../compose.yaml)
with a prebuilt image, SSH access, and persistent Docker-managed volumes.
You need Docker Compose v2.

For guided setup on Linux or macOS, run the native Bash installer:

```sh
curl -fsSL https://raw.githubusercontent.com/boadij/pi-herdsman/main/scripts/docker-setup.sh | bash
```

On Windows with Docker Desktop, run the native PowerShell installer:

```powershell
irm https://raw.githubusercontent.com/boadij/pi-herdsman/main/scripts/docker-setup.ps1 | iex
```

The installer uses the current directory, unless `PI_HERDSMAN_DIR` selects
another directory. It uses Compose's native configuration resolution,
including `compose.override.yaml` discovery or an explicit `COMPOSE_FILE`
selection. Both installers recognize the standard Compose filenames when
deciding whether to offer a new deployment. For a new deployment, setup
downloads the required official files and guides you through initial startup.
For existing configuration, it preserves the files and settings. Running
containers are not automatically recreated during ordinary repeat setup;
stopped containers can be started without recreation. If configuration exists
but no containers do, setup requests confirmation before initial startup. It stops if a Compose project has
containers associated with another directory. Setup does not migrate or repair
custom mounts or apply changed configuration to existing containers. If only a
Tailscale sidecar exists, Bash setup asks before completing the deployment;
authentication may recreate the sidecar.

Guided setup can offer to authorize an existing host public key with your
explicit consent, and accepts additional public keys from trusted machines.
It does not generate a private key on the Docker host. Existing authorization
is preserved; a fresh deployment needs at least one authorized key. For
initial startup, public keys can be supplied in `SSH_AUTHORIZED_KEYS`. Windows
setup uses that fallback only when no key was selected and the home is empty;
select a key interactively for an initialized home. To add keys to an existing
running deployment, use the interactive prompts. If setup runs on a remote
Docker host, authorize your workstation's public key to connect from the
workstation. Setup checks selected public keys' OpenSSH wire structure and uses
the container's `ssh-keygen` to check and compare keys before updating
authorization. The guided Windows flow currently offers
standard Docker with named volumes only. For Tailscale, existing installations
reuse their persistent identity. Bash setup checks registration on repeat runs
and stops with recovery guidance if status is unavailable or not running; network
repair requires explicit Docker or Tailscale operations. Bash setup rejects a key
in `.env` and uses a
temporary key for initial authentication, then restores a key-free sidecar and
Herdsman network namespace. If key-free restoration or verification fails,
setup attempts to stop the sidecar. A stopped container may still contain the
credential; recreate it without `TS_AUTHKEY` and restore the Herdsman network
namespace manually. If stopping fails, stop it immediately. On repeat runs,
Bash setup also attempts to stop a sidecar if a retained credential is found or
its credential state cannot be inspected. Windows setup does not bootstrap
Tailscale.

When Bash setup needs sudo, it preserves selected Compose settings and exported
interpolation variables identified by Compose. This requires Compose support
for `config --variables` and a sudo policy allowing the requested environment
names. Docker engine selection variables are not preserved under sudo; configure
them for the sudo environment or use direct Docker access. All subsequent
installer Docker operations use the selected engine.

For direct Compose control, use the Compose file included in a checkout or
download it into a new directory:

```sh
mkdir -p pi-herdsman && cd pi-herdsman
curl -fsSLO https://raw.githubusercontent.com/boadij/pi-herdsman/main/compose.yaml
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" docker compose up -d
```

Choose [Tailscale](#use-tailscale) or a [host bind mount](#use-a-host-bind-mount)
before first start if needed. Optional deployments record their Compose file
selection in a local `.env`, so subsequent commands use the same networking
and storage configuration.

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

## Web access

Fresh Pi environments in the Docker distribution include the optional
`pi-web-access` extension. Initialization only seeds it for a fresh Pi home:
existing Docker volumes keep their package state, and restarts do not restore a
package you remove.

Pi remains the package manager. Remove the ordinary Pi installation with:

```sh
pi remove npm:pi-web-access
```

The bundled researcher explicitly requests `npm:pi-web-access` even after
`pi remove`. To opt out of that request, use a
[researcher definition overlay](agent-definitions.md#researcher) that removes
`npm:pi-web-access` from `extensions`. If the effective definition enables
ordinary extension discovery, also remove the ordinary installation as shown
above so Pi does not discover it through that path.

Install or restore the ordinary Pi package, or update it when desired:

```sh
pi install npm:pi-web-access
pi update npm:pi-web-access
```

Start a new Pi session or run `/reload` in an existing session to adopt changed
extension resources. Search providers may receive external requests. The
extension executes third-party code in the Pi process with that process's
permissions; its tool allowlist is not an operating-system sandbox.

## Add it to Herdr

```sh
herdr machine add ssh://herdsman@your-host:2222 --label my-herd
```

With an existing `~/.ssh/config` host:

```sh
herdr machine add my-herd --label my-herd
```

The remote machine then appears alongside Local in Herdr.

For authorized SSH onboarding or reciprocal Herdsman peer setup, use the
bundled [machine-pairing skill](../../skills/machine-pairing/SKILL.md).

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

The Tailscale overlay accepts tailnet DNS settings by default
(`TS_ACCEPT_DNS=true`). With MagicDNS enabled in the tailnet, processes
inside Herdsman can resolve other tailnet machines by hostname. This also
makes DNS behavior follow the tailnet configuration instead of Docker's
defaults, which may affect Docker service-name resolution.

From the Docker host, verify both tailnet and public DNS (replace
`other-host` with another machine on your tailnet):

```sh
docker compose exec herdsman getent hosts other-host
docker compose exec herdsman getent hosts github.com
```

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

On first start, the container also generates a passphrase-free Ed25519 SSH
**client** key if no client key pair exists. The private key stays in the
persistent `/home/herdsman/.ssh` directory and is never regenerated on
restarts. To authorize outbound SSH access on another machine, obtain the
public key from the Docker host:

```sh
docker compose exec herdsman cat /home/herdsman/.ssh/id_ed25519.pub
```

Add that key to the destination's `authorized_keys`. Never copy the private
key. The container recovers a missing public key from an existing unencrypted
private key, but does not overwrite incomplete or unusable identities. Protect
the persistent home volume because the client private key has no passphrase.

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

### Use a local development package

Keep the checkout in persistent storage accessible inside the container, such
as under `/home/herdsman`. From the container, switch explicitly from the
published package to the checkout:

```sh
pi remove npm:pi-herdsman
cd ~/path/to/pi-herdsman
npm run build
pi install .
pi list
```

Remove any other conflicting Herdsman package declarations: the SSH peer
launcher requires one selected user-global npm or local package and rejects
distinct selections. It does not resolve project-local, temporary, or Git
package selections. A missing local directory cannot always be identified as
a Herdsman selection at container startup; the peer launcher will not execute
a missing or invalid package. If both local and npm Herdsman sources are selected,
the container keeps SSH available for recovery without changing Pi settings.
Pi and the peer launcher may remain unusable until you remove the conflicting
selection. Other installation validation failures still block container startup.

`pi install .` selects the checkout in place rather than copying it into Pi's
npm package directory. The image-owned `pi-herdsman-peer` command resolves the
bridge from the selected user-global Herdsman package on every invocation. In a
local checkout, `npm run build` refreshes both the extension and the bridge
without replacing the image. Run `/reload` in each existing Pi session (or
restart it) before resuming coordination. Exact runtime-build compatibility
checks still apply. The local package author is responsible for the checkout
and its installed dependencies.

When the launcher itself changes, recreate the container with an updated image,
preserving the deployment's existing Compose files and persistent volumes.

To switch back, remove the local selection using its path as shown by
`pi list`, then install the published package:

```sh
pi remove ~/path/to/pi-herdsman
pi install npm:pi-herdsman
pi list
```

Reload affected Pi sessions after switching.

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

For the fresh Linux Tailscale plus bind-mount option, the Bash installer creates
`data/herdsman-home` with `1000:1000` ownership, regardless of the user running
setup. It changes ownership only when it created the directory, and requires an
existing home to have `1000:1000` ownership and compatible permissions. It never
recursively re-owns existing data or infers custom IDs. Configure custom `PUID`
and `PGID` explicitly when needed. Windows setup does not initialize bind homes;
prepare any custom bind home safely before starting an existing configuration.

For a manually configured Linux or NAS bind mount, prepare the directory for
the positive UID/GID the container will use:

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

For direct Compose deployments, `SSH_AUTHORIZED_KEYS` initializes authorization
on first start; it does not add keys to an existing nonempty `authorized_keys`.
Guided setup can add explicitly supplied public keys while preserving existing
authorization.

Pi sessions automatically receive the container environment context from `/AGENTS.md`.

See the [Herdr machine documentation](https://herdr.dev/docs/connecting-machines/) for machine and SSH configuration.
