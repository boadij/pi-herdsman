# Container deployment

[Documentation index](../README.md)

The Pi Herdsman container provides an SSH-ready Pi, Herdr, and Pi Herdsman
environment. OpenSSH is the user interface; connect with your own SSH key and
use Pi and Herdr normally.

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

The home directory must be writable by UID 1000, which is the `herdsman`
account in the image. Repositories can live under the persistent home, for
example `~/projects`. Host checkouts can be mounted explicitly when needed.

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

## Container restart behavior

Herdr detach and reattach keep processes alive while the container itself
remains alive. Replacing or restarting the Docker container kills its
processes. Herdr can restore layout and supported Pi conversations, but
arbitrary processes do not survive a container restart.
