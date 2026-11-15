#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if ! command -v docker >/dev/null; then
  echo 'Docker is required.' >&2
  exit 1
fi

if docker info >/dev/null 2>&1; then
  compose() { docker compose "$@"; }
else
  command -v sudo >/dev/null || { echo 'Cannot access Docker; configure permissions or install sudo.' >&2; exit 1; }
  sudo -v
  compose() { sudo --preserve-env=COMPOSE_FILE,SSH_AUTHORIZED_KEYS,TS_AUTHKEY docker compose "$@"; }
fi

compose version >/dev/null

if [[ -z "${COMPOSE_FILE:-}" ]] && ! { [[ -f .env ]] && grep -Eq '^[[:space:]]*COMPOSE_FILE[[:space:]]*=' .env; }; then
  printf 'Deployment: [1] Docker (default), [2] Tailscale, [3] Tailscale + bind mount: '
  read -r choice
  case "${choice:-1}" in
    1) files=compose.yaml ;;
    2) files=compose.yaml:compose.tailscale.yaml ;;
    3) files=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml ;;
    *) echo 'Invalid deployment selection.' >&2; exit 1 ;;
  esac
  umask 077
  printf '\nCOMPOSE_FILE=%s\n' "$files" >> .env
fi

# Compose handles selection and interpolation; never evaluate .env as shell code.
compose config --quiet
services="$(compose config --services)"
files="${COMPOSE_FILE:-$(sed -n 's/^[[:space:]]*COMPOSE_FILE[[:space:]]*=[[:space:]]*//p' .env | tail -n 1)}"

if [[ "$files" == *compose.bind-mount.yaml* ]]; then
  if [[ "$(id -u)" = 0 ]]; then
    echo 'Run setup as a regular user for a user-owned bind mount.' >&2
    exit 1
  fi
  mkdir -p data/herdsman-home
  if ! grep -q '^PUID=' .env; then printf 'PUID=%s\n' "$(id -u)" >> .env; fi
  if ! grep -q '^PGID=' .env; then printf 'PGID=%s\n' "$(id -g)" >> .env; fi
fi

if [[ -z "${SSH_AUTHORIZED_KEYS:-}" ]] && ! { [[ -f .env ]] && grep -q '^SSH_AUTHORIZED_KEYS=' .env; }; then
  for key in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do
    if [[ -s "$key" ]]; then
      SSH_AUTHORIZED_KEYS="$(cat "$key")"
      export SSH_AUTHORIZED_KEYS
      break
    fi
  done
  if [[ -z "${SSH_AUTHORIZED_KEYS:-}" ]]; then
    read -r -p 'Path to an SSH public key (blank if already authorized): ' key
    if [[ -n "$key" ]]; then
      [[ -s "$key" ]] || { echo 'SSH public key not found.' >&2; exit 1; }
      SSH_AUTHORIZED_KEYS="$(cat "$key")"
      export SSH_AUTHORIZED_KEYS
    fi
  fi
fi

if grep -qx tailscale <<< "$services"; then
  if [[ -z "${TS_AUTHKEY:-}" ]] && ! { [[ -f .env ]] && grep -q '^TS_AUTHKEY=' .env; } &&
     ! compose exec -T tailscale tailscale status --json 2>/dev/null | grep -E '"BackendState"[[:space:]]*:[[:space:]]*"Running"' >/dev/null; then
    read -r -s -p 'Tailscale auth key (blank if already registered): ' TS_AUTHKEY
    printf '\n'
    export TS_AUTHKEY
  fi
fi

compose config --quiet
compose up -d

if grep -qx tailscale <<< "$services"; then
  # Wait for persisted authentication before clearing the bootstrap credential.
  connected=false
  for _ in {1..30}; do
    if compose exec -T tailscale tailscale status --json 2>/dev/null |
       grep -E '"BackendState"[[:space:]]*:[[:space:]]*"Running"' >/dev/null; then
      connected=true
      break
    fi
    sleep 2
  done
  if [[ "$connected" != true ]]; then
    echo 'Tailscale is not connected. Supply a valid auth key and rerun setup.' >&2
    exit 1
  fi
  if [[ -n "${TS_AUTHKEY:-}" ]]; then
    unset TS_AUTHKEY
    compose up -d
  fi
fi

ready=false
for _ in {1..30}; do
  if compose exec -T herdsman pgrep -x sshd >/dev/null 2>&1; then ready=true; break; fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  echo 'Herdsman did not become SSH-ready. Check: docker compose logs herdsman' >&2
  exit 1
fi

if grep -qx tailscale <<< "$services"; then
  hostname="${TAILSCALE_HOSTNAME:-$(sed -n 's/^TAILSCALE_HOSTNAME=//p' .env | tail -n 1)}"
  printf 'Herdsman ready. Connect: ssh herdsman@%s\n' "${hostname:-pi-herdsman}"
else
  port="${HERDSMAN_SSH_PORT:-$(sed -n 's/^HERDSMAN_SSH_PORT=//p' .env | tail -n 1)}"
  printf 'Herdsman ready. Connect: ssh -p %s herdsman@<docker-host>\n' "${port:-2222}"
fi
printf 'Peer public key: docker compose exec herdsman cat /home/herdsman/.ssh/id_ed25519.pub\n'
