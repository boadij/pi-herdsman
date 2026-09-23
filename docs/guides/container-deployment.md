# Container deployment

[Documentation index](../README.md)

The Pi Herdsman container is a portable, self-hosted execution environment for
coding agents. It packages Pi, herdr, Pi Herdsman, developer tooling, and
OpenSSH while keeping mutable user state under `/home/herdsman`.

Use it locally or as a remote coding-agent machine. OpenSSH is the access
boundary; connect with your own SSH key and use Pi and herdr normally.

Pi sessions automatically receive image-owned environment context from
`/AGENTS.md`, including persistence boundaries, available tool categories, and
how to install additional tools. User and project context files continue to
layer normally through Pi's native context-file discovery.

## Direct SSH

Start the service with a public key authorized for the `herdsman` account:

```sh
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" docker compose up -d
```

Connect to the host's configured SSH port (2222 by default):

```sh
ssh -p 2222 herdsman@host
```

Start or attach to a Herdr session with:

```sh
herdr
```

SSH password authentication and root login are disabled. On first start,
`SSH_AUTHORIZED_KEYS` is required to initialize the account's authorized keys.
The keys are saved in the persistent home volume; changing the environment
variable later does not replace an existing authorized-keys file. SSH agent
forwarding remains available, so `ssh -A` can be used when a session needs
access to private Git repositories without copying private keys into the
container.

## Herdr Machines

After normal SSH access works, save the container as a herdr machine from the
computer running your local herdr client:

```sh
herdr machine add ssh://herdsman@host:2222 --label my-herd
```

For a host already configured in `~/.ssh/config`:

```sh
herdr machine add my-herd --label my-herd
```

Each machine keeps its own herdr server, sessions, and running processes.
Connected machine workspaces and agents appear alongside Local in the same
herdr window, and disconnecting the client does not stop the remote work.

See the [herdr machine documentation](https://herdr.dev/docs/connecting-machines/)
for machine management and SSH configuration.

## Updates

Pull the current image and recreate the service:

```sh
docker compose pull
docker compose up -d
```

The container replaces immutable software while the named volumes preserve
`/home/herdsman` and the SSH host identity.

## Persistent state

The default Compose setup persists two volumes:

- `/home/herdsman` contains Pi authentication, configuration, sessions and
  extensions; Herdr configuration, sessions and worktrees; mise-installed
  tools; npm globals; Git, GitHub and user SSH state; and repositories.
- `/var/lib/herdsman/ssh` contains the SSH server host key, preserving server
  identity when the container is replaced.

The image uses its built-in `herdsman` UID and GID by default. For Linux or NAS
bind mounts owned by a different host account, set `PUID` and `PGID` to the
directory owner's numeric IDs:

```sh
PUID="$(id -u docker-user)" \
PGID="$(id -g docker-user)" \
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
docker compose up -d
```

You can also set `PUID` and `PGID` in the Compose `.env` file:

```dotenv
PUID=1035
PGID=65537
```

The container remaps the `herdsman` account but does not change ownership of
the mounted home. Prepare the host directory so the configured IDs can write
it. Existing volumes are not migrated automatically; startup fails if
`/home/herdsman` is not writable by the resulting account. Repositories can
live under the persistent home, for example `~/projects`. Host checkouts can
be mounted explicitly when needed.

## Additional tools

Install tools into the persistent home with mise:

```sh
mise use -g uv@latest
uv run ...
```

Mise shims and user-installed tools are available in SSH sessions, including
non-interactive commands.

## Tailscale

Tailscale is an optional Compose sidecar. It shares the service network
namespace; it does not run in the Herdsman container. Start both services with:

```sh
TS_AUTHKEY=... \
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
docker compose \
  -f compose.yaml \
  -f compose.tailscale.yaml \
  up -d
```

Connect over the Tailscale hostname using normal OpenSSH:

```sh
ssh herdsman@pi-herdsman
```

Set `TAILSCALE_HOSTNAME` if a different hostname is desired. The overlay uses
Tailscale networking, not Tailscale SSH.

## Interactive sessions

Interactive SSH logins automatically open Herdr. This also applies when SSH is
reached through the optional Tailscale sidecar.

Exit Herdr to return to the normal shell.

For interactive Docker access as the normal container user, run:

```sh
docker exec -it --user herdsman <container> bash
```

or with Compose:

```sh
docker compose exec --user herdsman herdsman bash
```

Bare `docker exec` uses the container's root user and is intended for
administrative debugging; it does not automatically open Herdr.

Non-interactive SSH commands are unaffected.

## Container restart behavior

Herdr detach and reattach keep processes alive while the container itself
remains alive. Replacing or restarting the Docker container kills its
processes. Herdr can restore layout and supported Pi conversations, but
arbitrary processes do not survive a container restart.
