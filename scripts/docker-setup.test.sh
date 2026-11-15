#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat > "$tmp/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == info ]]; then exit 0; fi
[[ "$1" == compose ]] || exit 9
shift
case "$*" in
  version | 'config --quiet') exit 0 ;;
  'config --services')
    echo herdsman
    if grep -q 'compose.tailscale.yaml' .env; then echo tailscale; fi
    ;;
  'exec -T tailscale tailscale status --json')
    if [[ -f "$SIM_ROOT/logged-in" ]]; then
      echo '{"BackendState": "Running"}'
    else
      exit 1
    fi
    ;;
  'up -d')
    printf 'auth=%s\n' "${TS_AUTHKEY:-}" >> "$SIM_ROOT/up.log"
    if [[ -n "${TS_AUTHKEY:-}" ]]; then touch "$SIM_ROOT/logged-in"; fi
    ;;
  'exec -T herdsman pgrep -x sshd') exit 0 ;;
  *) echo "Unexpected Docker command: $*" >&2; exit 9 ;;
esac
MOCK
chmod +x "$tmp/bin/docker"

make_project() {
  mkdir -p "$tmp/$1/scripts"
  cp "$root/scripts/docker-setup.sh" "$tmp/$1/scripts/docker-setup.sh"
}

export PATH="$tmp/bin:$PATH" SSH_AUTHORIZED_KEYS='ssh-ed25519 test-public-key'
make_project first
printf 'EXISTING=preserve\n' > "$tmp/first/.env"
printf '2\nbootstrap-secret\n' | SIM_ROOT="$tmp/first" bash "$tmp/first/scripts/docker-setup.sh" > "$tmp/first/out"
[[ "$(grep -c '^COMPOSE_FILE=' "$tmp/first/.env")" -eq 1 ]]
grep -qx 'EXISTING=preserve' "$tmp/first/.env"
grep -qx 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml' "$tmp/first/.env"
! grep -q 'bootstrap-secret' "$tmp/first/.env" "$tmp/first/out"
grep -qx 'auth=bootstrap-secret' "$tmp/first/up.log"
grep -qx 'auth=' "$tmp/first/up.log"
# Rerunning reuses the saved Compose selection and authenticated sidecar.
SIM_ROOT="$tmp/first" bash "$tmp/first/scripts/docker-setup.sh" </dev/null > "$tmp/first/rerun"
[[ "$(grep -c '^COMPOSE_FILE=' "$tmp/first/.env")" -eq 1 ]]

make_project bind
printf '3\nnew-bootstrap-secret\n' | SIM_ROOT="$tmp/bind" bash "$tmp/bind/scripts/docker-setup.sh" > "$tmp/bind/out"
test -d "$tmp/bind/data/herdsman-home"
grep -qx "PUID=$(id -u)" "$tmp/bind/.env"
grep -qx "PGID=$(id -g)" "$tmp/bind/.env"
grep -qx 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml' "$tmp/bind/.env"
! grep -q 'new-bootstrap-secret' "$tmp/bind/.env" "$tmp/bind/out"
make_project standard
printf '\n' | SIM_ROOT="$tmp/standard" bash "$tmp/standard/scripts/docker-setup.sh" > "$tmp/standard/out"
grep -qx 'COMPOSE_FILE=compose.yaml' "$tmp/standard/.env"
grep -q 'ssh -p 2222 herdsman@<docker-host>' "$tmp/standard/out"
[[ "$(wc -l < "$tmp/standard/up.log")" -eq 1 ]]
echo 'Docker setup smoke test passed.'
