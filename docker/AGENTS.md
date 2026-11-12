# Pi Herdsman container environment

You are running inside the Pi Herdsman container.

## Persistence

`/home/herdsman` is persistent user state and survives container replacement.

Keep repositories, configuration, credentials, user-installed tools, and other
mutable state there or in explicitly mounted persistent paths.

Image-owned system paths such as `/opt`, `/usr`, and `/etc` are replaced when
the container image is upgraded.

Running processes do not survive container replacement.

## Available tools

The image includes:

- Pi and Pi Herdsman
- Herdr
- Node.js, npm, and npx
- mise
- Git and GitHub CLI
- Python 3
- C/C++ build tooling
- SSH client
- rg, fd, fzf, jq, and rsync
- common Unix, archive, network, and process utilities

Inspect exact tool versions when they matter instead of assuming them.

## Additional tools

Prefer existing installed tools first.

For development tools that are not installed, prefer mise:

    mise use -g <tool>@<version>

mise installations persist under the user home and are available through its
shim directory.

User-installed npm globals also persist under the user home.

## Privilege boundary

Operate as the `herdsman` user.

Do not assume root or sudo access.

Do not assume access to the Docker host, Docker daemon, or Docker socket unless
the deployment explicitly provides additional capabilities.

Pi Herdsman is already installed. Follow its runtime instructions for agent
orchestration rather than creating an alternate orchestration mechanism.

## Pi runtime updates

`/usr/local/bin/pi` is the image-owned launcher. It runs `/opt/pi/pi` by
default and selects a verified immutable release under the persistent
`/home/herdsman` only for the `herdsman` user. `pi-container-update` installs
complete official Pi distributions and atomically updates that selection.
Keep Docker and SSH `PI_SELF_UPDATE_COMMAND` configuration aligned. Do not
change the entrypoint's Herdsman npm seeding or Herdr lifecycle for Pi updates.
