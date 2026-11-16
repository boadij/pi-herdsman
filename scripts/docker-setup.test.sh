#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/home" "$work/project"
export HOME="$work/home" PI_HERDSMAN_DIR="$work/project"
test_key="ssh-ed25519 $({ printf '\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20'; printf '\x01%.0s' {1..32}; } | base64 | tr -d '\n') synthetic-test-key"
export SSH_AUTHORIZED_KEYS="$test_key"
export OFFICIAL_COMPOSE="$root/compose.yaml"
cat >"$work/bin/ssh-keygen" <<'MOCK'
#!/usr/bin/env bash
echo invoked >"$SSH_KEYGEN_MARKER"
exit 127
MOCK
cat >"$work/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$DOCKER_LOG"
if [[ "${DOCKER_DIRECT_FAIL:-0}" == 1 && "${MOCK_SUDO:-0}" != 1 && "$1" == info ]]; then exit 1; fi
if [[ "$1 $2" == "compose version" || "$1" == info ]]; then exit 0; fi
if [[ "$1 $2" == "compose run" ]]; then
  if [[ "$*" == *'id -u herdsman'* ]]; then printf '%s %s\n' "${MOCK_DEFAULT_UID:-1000}" "${MOCK_DEFAULT_GID:-1000}"; exit 0; fi
  [[ "${PERSISTENT_KEYS:-0}" == 1 ]]; exit
fi
if [[ "$1 $2 $3" == "compose up -d" ]]; then
  [[ -n "${SSH_AUTHORIZED_KEYS:-}" ]] && printf 'startup-key-present\n' >>"$DOCKER_LOG"
fi
if [[ "$1 $2" == "compose config" && "$3" == --environment ]]; then
  if [[ -n "${TAILSCALE_HOSTNAME:-}" ]]; then printf 'TAILSCALE_HOSTNAME=%s\n' "$TAILSCALE_HOSTNAME"
  elif [[ -f .env ]]; then sed -n 's/^TAILSCALE_HOSTNAME=//p' .env; fi
  exit 0
fi
if [[ "$1 $2 $3" == "compose exec -T" && "$4" == tailscale ]]; then
  if [[ "${TAILSCALE_ORDER_TEST:-0}" == 1 ]]; then
    count=$(cat "$TAILSCALE_COUNT" 2>/dev/null || echo 0); count=$((count+1)); printf '%s' "$count" >"$TAILSCALE_COUNT"
    if (( count <= 10 )); then printf '{"BackendState":"NeedsLogin"}\n'; else printf '{"BackendState":"Running"}\n'; fi
  else
    printf '{"BackendState":"%s"}\n' "${TAILSCALE_STATUS:-Running}"
  fi
  exit 0
fi
if [[ "$1 $2 $3" == "compose exec -T" ]]; then exit 0; fi
if [[ "$1 $2 $3 $4 $5" == "compose up -d --force-recreate tailscale" ]]; then
  printf 'tailscale-recreate %s\n' "${TS_AUTHKEY:+bootstrap}" >>"$DOCKER_LOG"
  [[ -z "${TS_AUTHKEY:-}" ]] || printf 'bootstrap-key-delivered-via-env\n' >>"$DOCKER_LOG"
  exit 0
fi
if [[ "$1 $2 $3 $4 $5" == "compose up -d --force-recreate herdsman" ]]; then
  printf 'herdsman-recreate\n' >>"$DOCKER_LOG"
  exit 0
fi
if [[ "$1 $2" == "compose port" ]]; then
  port="$(sed -n 's/^HERDSMAN_SSH_PORT=//p' .env | tail -n1)"
  printf '0.0.0.0:%s\n' "${port:-${SSH_PORT:-2222}}"
  exit 0
fi
if [[ "$1 $2" == "compose" ]]; then exit 0; fi
exit 0
MOCK
cat >"$work/bin/sudo" <<'MOCK'
#!/usr/bin/env bash
printf 'sudo %s\n' "$*" >>"$DOCKER_LOG"
if [[ "$1" == --preserve-env=* ]]; then
  [[ "${SUDO_PRESERVE_DENIED:-0}" != 1 ]] || { echo 'sudo: sorry, you are not allowed to preserve requested environment' >&2; exit 1; }
  preserve_names=${1#--preserve-env=}
  case ",$preserve_names," in
    *,SSH_AUTHORIZED_KEYS,*) [[ -n "${SSH_AUTHORIZED_KEYS:-}" ]] || exit 3; printf 'preserved-key-present\n' >>"$DOCKER_LOG" ;;
  esac
  case ",$preserve_names," in
    *,TS_AUTHKEY,*) [[ -n "${TS_AUTHKEY:-}" ]] || exit 4; printf 'preserved-authkey-present\n' >>"$DOCKER_LOG" ;;
  esac
  shift
else
  unset SSH_AUTHORIZED_KEYS TS_AUTHKEY
fi
[[ "$1" == docker ]] || exit 2
shift
MOCK_SUDO=1; export MOCK_SUDO
exec docker "$@"
MOCK
cat >"$work/bin/sleep" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
cat >"$work/bin/curl" <<'MOCK'
#!/usr/bin/env bash
name=
while (($#)); do
  if [[ "$1" == https://* ]]; then name=${1##*/}; fi
  if [[ "$1" == -o ]]; then shift; cp "$COMPOSE_ROOT/$name" "$1"; exit; fi
  shift
done
exit 2
MOCK
chmod +x "$work/bin/docker" "$work/bin/sudo" "$work/bin/sleep" "$work/bin/curl"
export PATH="$work/bin:$PATH" SSH_KEYGEN_MARKER="$work/ssh-keygen-invoked" COMPOSE_ROOT="$root" DOCKER_LOG="$work/docker.log"
printf 'CUSTOM=value\n' >"$work/project/.env"
printf '\n' | script -qec "bash \"$root/scripts/docker-setup.sh\"" /dev/null
grep -Fx 'CUSTOM=value' "$work/project/.env"
grep -Fx 'COMPOSE_FILE=compose.yaml' "$work/project/.env"
cmp "$root/compose.yaml" "$work/project/compose.yaml"
test -z "$(find "$work/project" -name '*.tmp.*' -print -quit)"
# A repeat setup reuses authorized_keys from its persistent home volume.
unset SSH_AUTHORIZED_KEYS
export PERSISTENT_KEYS=1
bash "$root/scripts/docker-setup.sh" >"$work/repeat.out"
grep -q 'Herdsman is ready' "$work/repeat.out"
test ! -e "$SSH_KEYGEN_MARKER"
export SSH_AUTHORIZED_KEYS="$test_key"
unset PERSISTENT_KEYS
# Malformed base64 that matches the old superficial check must fail before startup.
export SSH_AUTHORIZED_KEYS='ssh-ed25519 AQID malformed'
if bash "$root/scripts/docker-setup.sh" >"$work/malformed-key.out" 2>&1; then
  echo 'Expected malformed SSH key rejection.' >&2; exit 1
fi
grep -q 'structurally valid OpenSSH public key' "$work/malformed-key.out"
if grep -q 'Herdsman is ready' "$work/malformed-key.out"; then
  echo 'Malformed SSH key reached startup.' >&2; exit 1
fi
export SSH_AUTHORIZED_KEYS="$test_key"
# This is structurally encoded, but its all-zero P-256 coordinates are not a
# cryptographically valid point. The setup check intentionally makes no claim
# that this key can authenticate; it only covers the wire-structure boundary.
ecdsa_zero_point="ecdsa-sha2-nistp256 $({ printf '\x00\x00\x00\x13ecdsa-sha2-nistp256\x00\x00\x00\x08nistp256\x00\x00\x00\x41\x04'; printf '\x00%.0s' {1..64}; } | base64 | tr -d '\n') structurally-invalid-point"
export SSH_AUTHORIZED_KEYS="$ecdsa_zero_point"
bash "$root/scripts/docker-setup.sh" >"$work/ecdsa-boundary.out"
grep -q 'Herdsman is ready' "$work/ecdsa-boundary.out"
export SSH_AUTHORIZED_KEYS="$test_key"
# RSA exponent and modulus must be canonical, positive SSH mpints.
rsa_key() {
  local exponent=$1 modulus=$2 value byte length tmp encoded
  local -a fields=("$exponent" "$modulus")
  tmp="$(mktemp)"
  printf '%b' '\x00\x00\x00\x07ssh-rsa' >"$tmp"
  for value in "${fields[@]}"; do
    local -a octets=()
    IFS=, read -r -a octets <<<"$value"
    length=${#octets[@]}
    printf '%b' "\x00\x00\x00\x$(printf '%02x' "$length")" >>"$tmp"
    for byte in "${octets[@]}"; do
      printf '%b' "\x$byte" >>"$tmp"
    done
  done
  encoded="$(base64 <"$tmp" | tr -d '\n')"
  rm -f "$tmp"
  printf 'ssh-rsa %s malformed-rsa' "$encoded"
}
for invalid_rsa in \
  "$(rsa_key '80' '01')" \
  "$(rsa_key '00,7f' '01')" \
  "$(rsa_key '00,80' '80')" \
  "$(rsa_key '01' '00')"; do
  export SSH_AUTHORIZED_KEYS="$invalid_rsa"
  if bash "$root/scripts/docker-setup.sh" >"$work/malformed-rsa.out" 2>&1; then
    echo 'Expected malformed RSA mpint rejection.' >&2; exit 1
  fi
  grep -q 'structurally valid OpenSSH public key' "$work/malformed-rsa.out"
done
# A high-bit-set positive mpint is valid only with one necessary sign-padding byte.
export SSH_AUTHORIZED_KEYS="$(rsa_key '00,80' '7f')"
bash "$root/scripts/docker-setup.sh" >"$work/canonical-rsa.out"
grep -q 'Herdsman is ready' "$work/canonical-rsa.out"
export SSH_AUTHORIZED_KEYS="$test_key"
# A supported Compose dotenv export assignment must not retain the bootstrap secret.
printf 'export TS_AUTHKEY=secret-value\nCOMPOSE_FILE=compose.yaml\n' >"$work/project/.env"
if bash "$root/scripts/docker-setup.sh" >"$work/authkey.out" 2>&1; then
  echo 'Expected exported TS_AUTHKEY rejection.' >&2; exit 1
fi
grep -q 'remove TS_AUTHKEY from .env' "$work/authkey.out"
cmp <(printf 'export TS_AUTHKEY=secret-value\nCOMPOSE_FILE=compose.yaml\n') "$work/project/.env"
# Export-prefixed and quoted Compose dotenv selections are reused byte-for-byte.
printf 'export COMPOSE_FILE=compose.yaml\nCUSTOM=kept\n' >"$work/project/.env"
bash "$root/scripts/docker-setup.sh" >"$work/export-compose.out"
cmp <(printf 'export COMPOSE_FILE=compose.yaml\nCUSTOM=kept\n') "$work/project/.env"
printf 'existing custom compose\n' >"$work/project/custom.yaml"
for quote in '"' "'"; do
  printf 'COMPOSE_FILE=%scompose.yaml:custom.yaml%s # keep this comment\nCUSTOM=kept\n' "$quote" "$quote" >"$work/project/.env"
  cp "$work/project/.env" "$work/quoted-compose.env"
  bash "$root/scripts/docker-setup.sh" >"$work/quoted-compose.out"
  grep -q 'Herdsman is ready' "$work/quoted-compose.out"
  cmp "$work/quoted-compose.env" "$work/project/.env"
done
printf 'TS_AUTHKEY=secret-value\nCUSTOM=untouched\n' >"$work/project/.env"
if bash "$root/scripts/docker-setup.sh" </dev/null >"$work/authkey-no-edit.out" 2>&1; then
  echo 'Expected TS_AUTHKEY rejection before .env edit.' >&2; exit 1
fi
cmp <(printf 'TS_AUTHKEY=secret-value\nCUSTOM=untouched\n') "$work/project/.env"
printf 'COMPOSE_FILE=compose.yaml\n' >"$work/project/.env"
# A fresh deployment without a key still fails before starting the service.
unset SSH_AUTHORIZED_KEYS
export PERSISTENT_KEYS=0
if bash "$root/scripts/docker-setup.sh" </dev/null >"$work/fresh.out" 2>&1; then
  echo 'Expected fresh setup without SSH authorization to fail.' >&2; exit 1
fi
grep -q 'an SSH public key is required for a fresh deployment' "$work/fresh.out"
export SSH_AUTHORIZED_KEYS="$test_key"
unset PERSISTENT_KEYS
rm -f "$work/project/compose.yaml"
cat >"$work/bin/curl" <<'MOCK'
#!/usr/bin/env bash
while (($#)); do
  if [[ "$1" == -o ]]; then shift; printf partial >"$1"; exit 22; fi
  shift
done
exit 22
MOCK
chmod +x "$work/bin/curl"
if bash "$root/scripts/docker-setup.sh" </dev/null >"$work/out" 2>&1; then
  echo 'Expected failed download.' >&2; exit 1
fi
test ! -e "$work/project/compose.yaml"
test -z "$(find "$work/project" -name '*.tmp.*' -print -quit)"
# Simulate another process creating the destination after download begins.
cat >"$work/bin/curl" <<'MOCK'
#!/usr/bin/env bash
while (($#)); do
  if [[ "$1" == -o ]]; then
    shift
    printf 'concurrent user file\n' >"$PWD/compose.yaml"
    printf 'downloaded content\n' >"$1"
    exit
  fi
  shift
done
exit 2
MOCK
chmod +x "$work/bin/curl"
bash "$root/scripts/docker-setup.sh" >"$work/race.out"
grep -Fx 'concurrent user file' "$work/project/compose.yaml"
test -z "$(find "$work/project" -name '*.tmp.*' -print -quit)"
# An interrupted download in a path with spaces must remove its quoted temp path.
interrupt_project="$work/project path with spaces"
mkdir -p "$interrupt_project"
export PI_HERDSMAN_DIR="$interrupt_project"
printf 'COMPOSE_FILE=compose.yaml\n' >"$interrupt_project/.env"
rm -f "$interrupt_project/compose.yaml"
cat >"$work/bin/curl" <<'MOCK'
#!/usr/bin/env bash
while (($#)); do
  if [[ "$1" == -o ]]; then
    shift
    printf partial >"$1"
    kill -TERM "$PPID"
    exit
  fi
  shift
done
exit 2
MOCK
chmod +x "$work/bin/curl"
if bash "$root/scripts/docker-setup.sh" >"$work/interrupted.out" 2>&1; then
  echo 'Expected interrupted setup to fail.' >&2; exit 1
fi
test -z "$(find "$interrupt_project" -name '*.tmp.*' -print -quit)"

# Fresh option 3 prepares Linux bind storage with the invoking UID/GID and preserves existing data.
cat >"$work/bin/curl" <<'MOCK'
#!/usr/bin/env bash
name=
while (($#)); do
  if [[ "$1" == https://* ]]; then name=${1##*/}; fi
  if [[ "$1" == -o ]]; then shift; cp "$COMPOSE_ROOT/$name" "$1"; exit; fi
  shift
done
exit 2
MOCK
chmod +x "$work/bin/curl"
bind_project="$work/bind-project"
mkdir -p "$bind_project"
export PI_HERDSMAN_DIR="$bind_project"
unset COMPOSE_FILE PUID PGID
printf 'bind-data-preserved\n' >"$work/marker"
printf '3\n' | script -qec "bash \"$root/scripts/docker-setup.sh\"" /dev/null >"$work/bind.out"
test -d "$bind_project/data/herdsman-home"
grep -Fx "PUID=$(id -u)" "$bind_project/.env"
grep -Fx "PGID=$(id -g)" "$bind_project/.env"
test ! -e "$bind_project/data/herdsman-home/marker"
# Existing bind data and ownership are not replaced or chowned.
printf 'keep\n' >"$bind_project/data/herdsman-home/keep"
owner_before=$(stat -c '%u:%g' "$bind_project/data/herdsman-home")
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml\n' >"$bind_project/.env"
bash "$root/scripts/docker-setup.sh" >"$work/bind-repeat.out"
test -f "$bind_project/data/herdsman-home/keep"
test "$owner_before" = "$(stat -c '%u:%g' "$bind_project/data/herdsman-home")"
# The published port comes from Compose, not the default.
export PI_HERDSMAN_DIR="$work/project"
printf 'COMPOSE_FILE=compose.yaml\nHERDSMAN_SSH_PORT=2200\n' >"$work/project/.env"
unset SSH_PORT
bash "$root/scripts/docker-setup.sh" >"$work/custom-port.out"
grep -q 'ssh -p 2200 herdsman@localhost' "$work/custom-port.out"
# Compose dotenv hostname override is reflected without printing effective config.
ts_project="$work/tailscale-project"
mkdir -p "$ts_project"
export PI_HERDSMAN_DIR="$ts_project"
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml\nTAILSCALE_HOSTNAME=private-host.example\n' >"$ts_project/.env"
cp "$root/compose.yaml" "$ts_project/compose.yaml"
cp "$root/compose.tailscale.yaml" "$ts_project/compose.tailscale.yaml"
unset TAILSCALE_HOSTNAME
bash "$root/scripts/docker-setup.sh" >"$work/custom-hostname.out"
grep -q 'ssh herdsman@private-host.example' "$work/custom-hostname.out" || { cat "$work/custom-hostname.out"; exit 1; }
! grep -q 'services:' "$work/custom-hostname.out"
# Bootstrap restores key-free Tailscale and recreates Herdsman after the namespace owner.
order_project="$work/order-project"
mkdir -p "$order_project"
export PI_HERDSMAN_DIR="$order_project" TS_AUTHKEY='test-bootstrap-key' TAILSCALE_ORDER_TEST=1 TAILSCALE_COUNT="$work/tailscale-count"
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml\n' >"$order_project/.env"
cp "$root/compose.yaml" "$order_project/compose.yaml"
cp "$root/compose.tailscale.yaml" "$order_project/compose.tailscale.yaml"
: >"$DOCKER_LOG"; rm -f "$TAILSCALE_COUNT"
bash "$root/scripts/docker-setup.sh" >"$work/tailscale-order.out"
grep -n '^docker compose up -d --force-recreate tailscale$' "$DOCKER_LOG" | head -n1 | cut -d: -f1 >"$work/bootstrap-line"
grep -n '^docker compose up -d --force-recreate tailscale$' "$DOCKER_LOG" | tail -n1 | cut -d: -f1 >"$work/restore-line"
grep -n '^docker compose up -d --force-recreate herdsman$' "$DOCKER_LOG" | tail -n1 | cut -d: -f1 >"$work/herdsman-line"
test "$(cat "$work/bootstrap-line")" -lt "$(cat "$work/restore-line")"
test "$(cat "$work/restore-line")" -lt "$(cat "$work/herdsman-line")"
# A direct Docker permission failure selects sudo for subsequent engine operations.
sudo_project="$work/sudo-project"
mkdir -p "$sudo_project"
export PI_HERDSMAN_DIR="$sudo_project" DOCKER_DIRECT_FAIL=1
printf 'COMPOSE_FILE=compose.yaml\n' >"$sudo_project/.env"
cp "$root/compose.yaml" "$sudo_project/compose.yaml"
: >"$DOCKER_LOG"
bash "$root/scripts/docker-setup.sh" >"$work/sudo.out"
grep -q '^docker info$' "$DOCKER_LOG"
grep -q '^sudo docker info$' "$DOCKER_LOG"
grep -q '^sudo --preserve-env=SSH_AUTHORIZED_KEYS docker compose up -d$' "$DOCKER_LOG"
grep -q '^preserved-key-present$' "$DOCKER_LOG"
grep -q '^startup-key-present$' "$DOCKER_LOG"
! grep -q "$test_key" "$DOCKER_LOG" "$work/sudo.out"
grep -q 'Herdsman is ready' "$work/sudo.out"
# A denied preserve policy produces a direct diagnostic and does not log the key.
export SUDO_PRESERVE_DENIED=1
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/sudo-denied.out" 2>&1; then
  echo 'Expected sudo preserve policy rejection.' >&2; exit 1
fi
grep -q 'sudo may deny preserving SSH_AUTHORIZED_KEYS' "$work/sudo-denied.out"
! grep -q "$test_key" "$DOCKER_LOG" "$work/sudo-denied.out"
unset SUDO_PRESERVE_DENIED DOCKER_DIRECT_FAIL
# Sudo Tailscale bootstrap passes the secret through a narrowly preserved env var, never argv.
sudo_ts_project="$work/sudo-tailscale-project"
mkdir -p "$sudo_ts_project"
export PI_HERDSMAN_DIR="$sudo_ts_project" DOCKER_DIRECT_FAIL=1 TS_AUTHKEY='sudo-test-bootstrap-secret' TAILSCALE_ORDER_TEST=1 TAILSCALE_COUNT="$work/sudo-tailscale-count"
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml\n' >"$sudo_ts_project/.env"
cp "$root/compose.yaml" "$sudo_ts_project/compose.yaml"
cp "$root/compose.tailscale.yaml" "$sudo_ts_project/compose.tailscale.yaml"
: >"$DOCKER_LOG"; rm -f "$TAILSCALE_COUNT"
bash "$root/scripts/docker-setup.sh" >"$work/sudo-tailscale.out"
grep -Fx 'sudo --preserve-env=TS_AUTHKEY,SSH_AUTHORIZED_KEYS docker compose up -d --force-recreate tailscale' "$DOCKER_LOG"
grep -Fx 'preserved-authkey-present' "$DOCKER_LOG"
grep -Fx 'bootstrap-key-delivered-via-env' "$DOCKER_LOG"
! grep -q 'sudo-test-bootstrap-secret' "$DOCKER_LOG" "$work/sudo-tailscale.out"
unset DOCKER_DIRECT_FAIL TAILSCALE_ORDER_TEST TAILSCALE_COUNT TS_AUTHKEY
# Bind mount rejects effective IDs from .env and process environment before startup.
bind_mismatch="$work/bind-mismatch"
mkdir -p "$bind_mismatch/data/herdsman-home"
cp "$root/compose.yaml" "$bind_mismatch/compose.yaml"
cp "$root/compose.tailscale.yaml" "$bind_mismatch/compose.tailscale.yaml"
cp "$root/compose.bind-mount.yaml" "$bind_mismatch/compose.bind-mount.yaml"
export PI_HERDSMAN_DIR="$bind_mismatch"
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml\nPUID=999998\nPGID=%s\n' "$(id -g)" >"$bind_mismatch/.env"
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/dotenv-id-mismatch.out" 2>&1; then
  echo 'Expected .env PUID mismatch.' >&2; exit 1
fi
grep -q 'effective PUID is 999998' "$work/dotenv-id-mismatch.out"
! grep -q 'compose up -d' "$DOCKER_LOG"
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml\nPUID=999998\nPGID=%s\n' "$(id -g)" >"$bind_mismatch/.env"
export PUID="$(id -u)"
: >"$DOCKER_LOG"
bash "$root/scripts/docker-setup.sh" >"$work/env-id-override.out"
grep -q 'Herdsman is ready' "$work/env-id-override.out"
unset PUID
# Empty .env values use Compose/container defaults, which must also match storage.
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml\nPUID=\nPGID=\n' >"$bind_mismatch/.env"
export MOCK_DEFAULT_UID=999997 MOCK_DEFAULT_GID="$(id -g)"
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/default-id-mismatch.out" 2>&1; then
  echo 'Expected Compose default PUID mismatch.' >&2; exit 1
fi
grep -q 'effective PUID is 999997' "$work/default-id-mismatch.out"
! grep -q 'compose up -d' "$DOCKER_LOG"
test -d "$bind_mismatch/data/herdsman-home"
test ! -e "$bind_mismatch/data/herdsman-home/changed"
# An explicitly empty process variable overrides nonempty .env, then resolves to Compose's default.
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml\nPUID=999998\nPGID=%s\n' "$(id -g)" >"$bind_mismatch/.env"
export PUID='' MOCK_DEFAULT_UID=999997 MOCK_DEFAULT_GID="$(id -g)"
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/empty-process-id-mismatch.out" 2>&1; then
  echo 'Expected empty process PUID to resolve to Compose default, not .env.' >&2; exit 1
fi
grep -q 'effective PUID is 999997' "$work/empty-process-id-mismatch.out"
! grep -q 'compose up -d' "$DOCKER_LOG"
test -d "$bind_mismatch/data/herdsman-home"
unset PUID MOCK_DEFAULT_UID MOCK_DEFAULT_GID
test ! -e "$SSH_KEYGEN_MARKER"
echo 'Bash Docker setup mocked checks passed.'
