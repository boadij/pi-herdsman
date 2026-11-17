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
echo invoked >>"$SSH_KEYGEN_MARKER"
case "${KEYGEN_MODE:-fail}:$1" in
  generate:-q) printf private >"${@: -1}"; printf '%s\n' "$TEST_KEY" >"${@: -1}.pub" ;;
  generation-race:-q) printf private >"${@: -1}"; printf '%s\n' "$TEST_KEY" >"${@: -1}.pub"; printf rival >"$HOME/.ssh/id_ed25519" ;;
  directory-race:-q|symlink-race:-q)
    printf private >"${@: -1}"; printf '%s\n' "$TEST_KEY" >"${@: -1}.pub"
    if [[ "$KEYGEN_MODE" == directory-race ]]; then mkdir "$HOME/.ssh/$RACE_TARGET"; else ln -s "$RACE_DIR" "$HOME/.ssh/$RACE_TARGET"; fi ;;
  directory-race:-y|symlink-race:-y)
    if [[ "$KEYGEN_MODE" == directory-race ]]; then mkdir "$HOME/.ssh/id_ed25519.pub"; else ln -s "$RACE_DIR" "$HOME/.ssh/id_ed25519.pub"; fi
    printf '%s\n' "$TEST_KEY" ;;
  recover:-y) printf '%s\n' "$TEST_KEY" ;;
  race:-y) printf rival >"$HOME/.ssh/id_ed25519.pub"; printf '%s\n' "$TEST_KEY" ;;
  *) exit 127 ;;
esac
MOCK
cat >"$work/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf 'docker %s\n' "$*" >>"$DOCKER_LOG"
if [[ "${DOCKER_DIRECT_FAIL:-0}" == 1 && "${MOCK_SUDO:-0}" != 1 && "$1" == info ]]; then exit 1; fi
if [[ "$1 $2" == "compose version" || "$1" == info ]]; then exit 0; fi
if [[ -n "${CAPTURE_SSH_LOG:-}" && "$1" == compose ]]; then
  printf '%s %s\n' "$2" "${SSH_AUTHORIZED_KEYS:+present}" >>"$CAPTURE_SSH_LOG"
fi
if [[ "${MOCK_SSH_MOUNT_DEPENDENT:-0}" == 1 && "$1" == compose && "$2" != version ]]; then
  [[ -n "${SSH_AUTHORIZED_KEYS:-}" ]] || { echo 'interpolated home changed' >&2; exit 1; }
fi
if [[ "${CAPTURE_OVERRIDES:-0}" == 1 && "$1" == compose ]]; then
  snapshot="$1 $2 ${3:-} ${4:-} ${5:-}"
  for name in COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROJECT_NAME PUID PGID HERDSMAN_SSH_PORT TAILSCALE_HOSTNAME; do
    if [[ ${!name+x} ]]; then value=${!name}; else value=$(sed -n "s/^$name=//p" .env | tail -n1); fi
    snapshot+="|$name=$value"
  done
  printf '%s\n' "$snapshot" >>"$OVERRIDE_LOG"
fi
if [[ "$1 $2 $3" == "compose config --variables" ]]; then
  if [[ "${MOCK_ARBITRARY:-0}" == 1 && "${MOCK_HIDE_VARIABLE:-0}" != 1 ]]; then printf 'HERDSMAN_HOME=\n'; fi
  exit 0
fi
if [[ "$1 $2" == "compose config" && "${3:-}" == --format ]]; then
  [[ "${MOCK_CONFIG_FAIL:-0}" != 1 ]] || { echo "missing Compose file" >&2; exit 1; }
  if [[ -n "${MOCK_MODEL:-}" ]]; then printf '%s\n' "$MOCK_MODEL"; exit; fi
  selection=${COMPOSE_FILE:-$(sed -n 's/^COMPOSE_FILE=//p' .env 2>/dev/null | tail -n1)}
  uid=${PUID-$(sed -n 's/^PUID=//p' .env 2>/dev/null | tail -n1)}
  gid=${PGID-$(sed -n 's/^PGID=//p' .env 2>/dev/null | tail -n1)}
  type=volume; source=home
  if [[ "$selection" == *compose.bind-mount.yaml* ]]; then type=bind; source="$PWD/data/herdsman-home"; fi
  if [[ "${MOCK_ARBITRARY:-0}" == 1 ]]; then type=bind; source=${HERDSMAN_HOME:-"$PWD/fallback-home"}; fi
  if [[ "${MOCK_SSH_MOUNT_DEPENDENT:-0}" == 1 ]]; then source=ssh-interpolated-home; fi
  if [[ "${MOCK_BOOTSTRAP_CONFIG_DRIFT:-0}" == 1 && -n "${TS_AUTHKEY:-}" ]]; then source=credential-dependent-home; fi
  network=
  [[ "$selection" != *compose.tailscale.yaml* ]] || network=service:tailscale
  jq -n --arg uid "$uid" --arg gid "$gid" --arg keys "${SSH_AUTHORIZED_KEYS:-}" --arg type "$type" --arg source "$source" --arg network "$network" '{name:"test-project",services:{herdsman:{image:"example/herdsman",network_mode:$network,environment:{PUID:$uid,PGID:$gid,SSH_AUTHORIZED_KEYS:$keys},volumes:[{type:$type,source:$source,target:"/home/herdsman"}]}},volumes:{home:{name:"test-project_home"}}}'
  exit
fi
if [[ "$1" == ps ]]; then printf '%s' "${MOCK_CONTAINER_IDS:-}"; exit; fi
if [[ "$1 $2" == "compose ps" ]]; then
  if [[ "${@: -1}" == herdsman ]]; then printf '%s' "${MOCK_RUNNING_HERDSMAN:-}"; else printf '%s' "${MOCK_SIDECAR_ID:-}"; fi
  exit
fi
if [[ "$1" == start ]]; then [[ "${MOCK_START_FAIL:-0}" != 1 ]]; exit; fi
if [[ "$1 $2" == "inspect --format" ]]; then printf '%s\n' "${MOCK_SIDECAR_RUNNING:-true}"; exit; fi
if [[ "$1" == inspect ]]; then printf '%s\n' "${MOCK_CONTAINERS:-[]}"; exit; fi
if [[ "$1" == run ]]; then
  if [[ "${MOCK_ACCOUNT_EXEC:-0}" == 1 ]]; then
    PATH="$MOCK_ACCOUNT_PATH:/usr/bin:/bin" sh -c "${@: -4:1}" sh "${@: -2:1}" "${@: -1}"
    exit
  fi
  [[ "${MOCK_ACCOUNT_FAIL:-0}" != 1 ]]; exit
fi
if [[ "$1 $2" == "compose run" ]]; then
  input=$(cat)
  [[ -z "${KEY_CAPTURE:-}" ]] || printf '%s' "$input" >"$KEY_CAPTURE"
  if [[ -n "${TEST_AUTH_HOME:-}" ]]; then
    auth_script=${@: -1}
    auth_script=${auth_script//\/home\/herdsman/$TEST_AUTH_HOME}
    printf '%s\n' "$input" | PATH=/usr/bin:/bin sh -c "$auth_script"
    exit
  fi
  [[ -n "$input" || "${PERSISTENT_KEYS:-0}" == 1 ]]; exit
fi
if [[ "$*" == 'compose up -d --no-deps --force-recreate herdsman' && "${MOCK_REATTACH_FAIL:-0}" == 1 ]]; then exit 1; fi
if [[ "$1 $2 $3" == "compose up -d" ]]; then
  [[ -n "${SSH_AUTHORIZED_KEYS:-}" ]] && printf 'startup-key-present\n' >>"$DOCKER_LOG"
  [[ -z "${KEY_CAPTURE:-}" ]] || printf '%s' "${SSH_AUTHORIZED_KEYS:-}" >"$KEY_CAPTURE"
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
  [[ -z "${TS_AUTHKEY:-}" || "${MOCK_BOOTSTRAP_FAIL:-0}" != 1 ]] || exit 1
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
preserve_names=
if [[ "${1:-}" == --preserve-env=* ]]; then
  [[ "${SUDO_PRESERVE_DENIED:-0}" != 1 ]] || { echo 'sudo: sorry, you are not allowed to preserve requested environment' >&2; exit 1; }
  preserve_names=${1#--preserve-env=}
  shift
fi
[[ "$1" == docker ]] || exit 2
shift
args=(env -i "PATH=$PATH" "HOME=$HOME" "DOCKER_LOG=$DOCKER_LOG" "MOCK_SUDO=1")
for name in CAPTURE_OVERRIDES OVERRIDE_LOG DOCKER_DIRECT_FAIL TAILSCALE_ORDER_TEST TAILSCALE_COUNT TAILSCALE_STATUS MOCK_DEFAULT_UID MOCK_DEFAULT_GID PERSISTENT_KEYS SSH_PORT MOCK_MODEL MOCK_CONTAINER_IDS MOCK_CONTAINERS MOCK_ACCOUNT_FAIL MOCK_CONFIG_FAIL MOCK_SIDECAR_ID MOCK_SIDECAR_RUNNING MOCK_BOOTSTRAP_FAIL MOCK_BOOTSTRAP_CONFIG_DRIFT CAPTURE_SSH_LOG MOCK_SSH_MOUNT_DEPENDENT MOCK_RUNNING_HERDSMAN MOCK_START_FAIL MOCK_ARBITRARY MOCK_HIDE_VARIABLE MOCK_REATTACH_FAIL; do
  [[ ${!name+x} ]] && args+=("$name=${!name}")
done
IFS=, read -r -a names <<<"$preserve_names"
for name in "${names[@]}"; do
  [[ -z "$name" ]] && continue
  [[ ${!name+x} ]] && args+=("$name=${!name}")
done
exec "${args[@]}" docker "$@"
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
chmod +x "$work/bin/ssh-keygen" "$work/bin/docker" "$work/bin/sudo" "$work/bin/sleep" "$work/bin/curl"
export PATH="$work/bin:$PATH" SSH_KEYGEN_MARKER="$work/ssh-keygen-invoked" COMPOSE_ROOT="$root" DOCKER_LOG="$work/docker.log"
printf 'CUSTOM=value\n' >"$work/project/.env"
printf '\n' | script -qec "bash \"$root/scripts/docker-setup.sh\"" /dev/null
grep -Fx 'CUSTOM=value' "$work/project/.env"
! grep -q '^COMPOSE_FILE=' "$work/project/.env"
cmp "$root/compose.yaml" "$work/project/compose.yaml"
test -z "$(find "$work/project" -name '*.tmp.*' -print -quit)"
# Native Compose discovery retains an existing override and leaves .env untouched.
printf 'services: {}\n' >"$work/project/compose.override.yaml"
cp "$work/project/.env" "$work/native.env"
bash "$root/scripts/docker-setup.sh" >"$work/native.out"
cmp "$work/native.env" "$work/project/.env"
test -f "$work/project/compose.override.yaml"
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
# A noninteractive fresh setup with no key fails without generating an identity.
unset SSH_AUTHORIZED_KEYS
export PERSISTENT_KEYS=0
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" </dev/null >"$work/no-key.out" 2>&1; then
  echo 'Expected missing authorization rejection.' >&2; exit 1
fi
grep -q 'no authorized keys exist' "$work/no-key.out"
test ! -e "$SSH_KEYGEN_MARKER"
test ! -e "$HOME/.ssh/id_ed25519"
! grep -q 'compose up -d$' "$DOCKER_LOG"
export SSH_AUTHORIZED_KEYS="$test_key"
unset PERSISTENT_KEYS
rm -f "$work/project/compose.yaml" "$work/project/compose.override.yaml"
printf 'CUSTOM=value\n' >"$work/project/.env"
cat >"$work/bin/curl" <<'MOCK'
#!/usr/bin/env bash
while (($#)); do
  if [[ "$1" == -o ]]; then shift; printf partial >"$1"; exit 22; fi
  shift
done
exit 22
MOCK
chmod +x "$work/bin/curl"
if printf '\n\n' | script -qec "bash \"$root/scripts/docker-setup.sh\"" /dev/null >"$work/out" 2>&1; then
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
printf '\n\n' | script -qec "bash \"$root/scripts/docker-setup.sh\"" /dev/null >"$work/race.out"
grep -Fx 'concurrent user file' "$work/project/compose.yaml"
test -z "$(find "$work/project" -name '*.tmp.*' -print -quit)"
# An interrupted download in a path with spaces must remove its quoted temp path.
interrupt_project="$work/project path with spaces"
mkdir -p "$interrupt_project"
export PI_HERDSMAN_DIR="$interrupt_project"
printf 'CUSTOM=value\n' >"$interrupt_project/.env"
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
if printf '\n\n' | script -qec "bash \"$root/scripts/docker-setup.sh\"" /dev/null >"$work/interrupted.out" 2>&1; then
  echo 'Expected interrupted setup to fail.' >&2; exit 1
fi
test -z "$(find "$interrupt_project" -name '*.tmp.*' -print -quit)"

# Native Compose names are reused; an unrelated model fails without downloads.
for native in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
  native_dir="$work/native-${native//./-}"
  mkdir "$native_dir"
  cp "$root/compose.yaml" "$native_dir/$native"
  export PI_HERDSMAN_DIR="$native_dir"
  bash "$root/scripts/docker-setup.sh" >"$work/native-reuse.out"
  test ! -e "$native_dir/.env"
  [[ "$native" == compose.yaml ]] || test ! -e "$native_dir/compose.yaml"
  export MOCK_MODEL='{"name":"unrelated","services":{"other":{}}}'
  if bash "$root/scripts/docker-setup.sh" >"$work/native-unrelated.out" 2>&1; then
    echo 'Expected unrelated Compose rejection.' >&2; exit 1
  fi
  [[ "$native" == compose.yaml ]] || test ! -e "$native_dir/compose.yaml"
  unset MOCK_MODEL
done
incomplete="$work/incomplete-selection"
mkdir "$incomplete"
export PI_HERDSMAN_DIR="$incomplete"
cp "$root/compose.yaml" "$incomplete/compose.yaml"
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml\n' >"$incomplete/.env"
cp "$incomplete/.env" "$work/incomplete.env"
export MOCK_CONFIG_FAIL=1
if bash "$root/scripts/docker-setup.sh" >"$work/incomplete.out" 2>&1; then
  echo 'Expected missing explicitly selected file rejection.' >&2; exit 1
fi
unset MOCK_CONFIG_FAIL
grep -q 'could not resolve Docker Compose configuration' "$work/incomplete.out"
test ! -e "$incomplete/compose.tailscale.yaml"
cmp "$work/incomplete.env" "$incomplete/.env"
# An override without a native base is incomplete, not a fresh deployment.
rm "$incomplete/compose.yaml" "$incomplete/.env"
printf 'services: {}\n' >"$incomplete/compose.override.yaml"
if bash "$root/scripts/docker-setup.sh" >"$work/incomplete-override.out" 2>&1; then
  echo 'Expected orphaned override rejection.' >&2; exit 1
fi
test ! -e "$incomplete/compose.yaml"

# Fresh option 3 prepares bind storage with the image defaults and preserves existing data.
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
test "$(stat -c %u:%g "$bind_project/data/herdsman-home")" = 1000:1000
! grep -Eq '^P(UID|GID)=' "$bind_project/.env"
test ! -e "$bind_project/data/herdsman-home/marker"
# Existing bind data and ownership are not replaced or chowned.
printf 'keep\n' >"$bind_project/data/herdsman-home/keep"
owner_before=$(stat -c '%u:%g' "$bind_project/data/herdsman-home")
bash "$root/scripts/docker-setup.sh" >"$work/bind-repeat.out"
test -f "$bind_project/data/herdsman-home/keep"
test "$owner_before" = "$(stat -c '%u:%g' "$bind_project/data/herdsman-home")"
# Fresh overlays use the configured separator from either environment source.
for separator_source in environment dotenv; do
  separator_dir="$work/separator-$separator_source"
  mkdir "$separator_dir"
  export PI_HERDSMAN_DIR="$separator_dir"
  if [[ "$separator_source" == environment ]]; then
    export COMPOSE_PATH_SEPARATOR=';'
  else
    unset COMPOSE_PATH_SEPARATOR
    printf 'COMPOSE_PATH_SEPARATOR=;\n' >"$separator_dir/.env"
  fi
  printf '2\n\n' | script -qec "bash \"$root/scripts/docker-setup.sh\"" /dev/null >"$work/separator.out"
  grep -Fxq 'COMPOSE_FILE=compose.yaml;compose.tailscale.yaml' "$separator_dir/.env"
  test -f "$separator_dir/compose.yaml"
  test -f "$separator_dir/compose.tailscale.yaml"
  unset COMPOSE_PATH_SEPARATOR
done
# Existing interpolated file selections are passed to Compose unchanged.
interpolated_dir="$work/interpolated"
mkdir "$interpolated_dir"
cp "$root/compose.yaml" "$interpolated_dir/compose.yaml"
printf '%s\n' 'STACK=compose' 'COMPOSE_FILE=${STACK}.yaml' >"$interpolated_dir/.env"
cp "$interpolated_dir/.env" "$work/interpolated.env"
export PI_HERDSMAN_DIR="$interpolated_dir"
bash "$root/scripts/docker-setup.sh" >"$work/interpolated.out"
cmp "$work/interpolated.env" "$interpolated_dir/.env"
grep -q 'Herdsman is ready' "$work/interpolated.out"
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
sidecar_line=$(grep -n '^docker compose up -d --no-recreate tailscale$'  "$DOCKER_LOG" | head -n1 | cut -d: -f1)
auth_line=$(grep -n '^docker compose run --rm --no-deps -T --user 1000:1000 ' "$DOCKER_LOG" | head -n1 | cut -d: -f1)
up_line=$(grep -n '^docker compose up -d --no-deps herdsman$' "$DOCKER_LOG" | head -n1 | cut -d: -f1)
test "$sidecar_line" -lt "$auth_line"
test "$auth_line" -lt "$up_line"
grep -n '^docker compose up -d --force-recreate tailscale$' "$DOCKER_LOG" | head -n1 | cut -d: -f1 >"$work/bootstrap-line"
grep -n '^docker compose up -d --force-recreate tailscale$' "$DOCKER_LOG" | tail -n1 | cut -d: -f1 >"$work/restore-line"
grep -n '^docker compose up -d --force-recreate herdsman$' "$DOCKER_LOG" | tail -n1 | cut -d: -f1 >"$work/herdsman-line"
test "$(cat "$work/bootstrap-line")" -lt "$(cat "$work/restore-line")"
test "$(cat "$work/restore-line")" -lt "$(cat "$work/herdsman-line")"
account_line=$(grep -n '^docker run --rm -i --network none --user 0:0 ' "$DOCKER_LOG" | head -n1 | cut -d: -f1)
test "$account_line" -lt "$sidecar_line"
# A failed preflight never changes an existing running sidecar.
export MOCK_SIDECAR_ID=sidecar MOCK_ACCOUNT_FAIL=1
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/sidecar-account-fail.out" 2>&1; then
  echo 'Expected account preflight failure.' >&2; exit 1
fi
! grep -q '^docker compose up -d' "$DOCKER_LOG"
unset MOCK_ACCOUNT_FAIL SSH_AUTHORIZED_KEYS
export PERSISTENT_KEYS=0
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/sidecar-auth-fail.out" 2>&1; then
  echo 'Expected authorization preflight failure.' >&2; exit 1
fi
! grep -q '^docker compose up -d' "$DOCKER_LOG"
export SSH_AUTHORIZED_KEYS="$test_key" MOCK_SIDECAR_RUNNING=false
unset PERSISTENT_KEYS
: >"$DOCKER_LOG"
bash "$root/scripts/docker-setup.sh" >"$work/sidecar-stopped.out" 2>&1
grep -q '^docker start sidecar$' "$DOCKER_LOG"
grep -q '^docker compose up -d --no-deps --force-recreate herdsman$' "$DOCKER_LOG"
! grep -q '^docker compose up -d --force-recreate tailscale$' "$DOCKER_LOG"
# A running Herdsman is reattached immediately after the sidecar restarts,
# even if the subsequent authorization check fails.
unset SSH_AUTHORIZED_KEYS
export PERSISTENT_KEYS=0 MOCK_RUNNING_HERDSMAN=herdsman
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/sidecar-recovery.out" 2>&1; then
  echo 'Expected authorization failure after sidecar recovery.' >&2; exit 1
fi
start_line=$(grep -n '^docker start sidecar$' "$DOCKER_LOG" | cut -d: -f1)
reattach_line=$(grep -n '^docker compose up -d --no-deps --force-recreate herdsman$' "$DOCKER_LOG" | cut -d: -f1)
auth_line=$(grep -n '^docker compose run --rm --no-deps -T --user 1000:1000 ' "$DOCKER_LOG" | head -n1 | cut -d: -f1)
test "$start_line" -lt "$reattach_line"
test "$reattach_line" -lt "$auth_line"
# A failed reattachment is reported with identity and is not blindly retried.
export SSH_AUTHORIZED_KEYS="$test_key" MOCK_REATTACH_FAIL=1
unset PERSISTENT_KEYS
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/sidecar-reattach-fail.out" 2>&1; then
  echo 'Expected reattachment failure.' >&2; exit 1
fi
test "$(grep -c '^docker compose up -d --no-deps --force-recreate herdsman$' "$DOCKER_LOG")" -eq 1
grep -q 'inspect sidecar sidecar' "$work/sidecar-reattach-fail.out"
unset MOCK_REATTACH_FAIL
export MOCK_START_FAIL=1
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/sidecar-start-fail.out" 2>&1; then
  echo 'Expected sidecar start failure.' >&2; exit 1
fi
test "$(grep -c '^docker start sidecar$' "$DOCKER_LOG")" -eq 1
grep -q 'inspect sidecar sidecar' "$work/sidecar-start-fail.out"
! grep -q '^docker compose run --rm --no-deps -T --user 1000:1000 ' "$DOCKER_LOG"
unset MOCK_START_FAIL MOCK_RUNNING_HERDSMAN MOCK_SIDECAR_RUNNING MOCK_SIDECAR_ID
# Failed bootstrap must restore the key-free sidecar and reattach Herdsman.
export MOCK_BOOTSTRAP_FAIL=1
: >"$DOCKER_LOG"; rm -f "$TAILSCALE_COUNT"
if bash "$root/scripts/docker-setup.sh" >"$work/bootstrap-failed.out" 2>&1; then
  echo 'Expected bootstrap failure.' >&2; exit 1
fi
test "$(grep -c '^docker compose up -d --force-recreate tailscale$' "$DOCKER_LOG")" -eq 2
grep -q '^docker compose up -d --force-recreate herdsman$' "$DOCKER_LOG" || { tail -20 "$DOCKER_LOG"; tail -10 "$work/bootstrap-failed.out"; exit 1; }
! grep -q 'test-bootstrap-key' "$DOCKER_LOG" "$work/bootstrap-failed.out"
unset MOCK_BOOTSTRAP_FAIL
# Bootstrap credentials must not alter unrelated Compose configuration.
export MOCK_BOOTSTRAP_CONFIG_DRIFT=1
: >"$DOCKER_LOG"; rm -f "$TAILSCALE_COUNT"
if bash "$root/scripts/docker-setup.sh" >"$work/bootstrap-drift.out" 2>&1; then
  echo 'Expected credential-dependent configuration rejection.' >&2; exit 1
fi
grep -q 'TS_AUTHKEY changes Compose configuration' "$work/bootstrap-drift.out"
! grep -q '^docker compose up -d --force-recreate' "$DOCKER_LOG"
! grep -q 'test-bootstrap-key' "$DOCKER_LOG" "$work/bootstrap-drift.out"
unset MOCK_BOOTSTRAP_CONFIG_DRIFT
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
grep -q '^sudo --preserve-env=SSH_AUTHORIZED_KEYS docker compose run --rm --no-deps -T --user 1000:1000' "$DOCKER_LOG"
! grep -q "$test_key" "$DOCKER_LOG" "$work/sudo.out"
grep -q 'Herdsman is ready' "$work/sudo.out"
# The initial SSH interpolation environment remains identical for every
# Compose operation, including sudo-mediated authorization and startup.
export CAPTURE_SSH_LOG="$work/ssh-interpolation.log" MOCK_SSH_MOUNT_DEPENDENT=1
: >"$CAPTURE_SSH_LOG"
bash "$root/scripts/docker-setup.sh" >"$work/ssh-interpolation.out"
grep -Fxq 'config present' "$CAPTURE_SSH_LOG"
grep -Fxq 'run present' "$CAPTURE_SSH_LOG"
grep -Fxq 'up present' "$CAPTURE_SSH_LOG"
grep -Fxq 'port present' "$CAPTURE_SSH_LOG"
! grep -q ' $' "$CAPTURE_SSH_LOG"
unset CAPTURE_SSH_LOG MOCK_SSH_MOUNT_DEPENDENT
# Compose-declared arbitrary interpolation variables are passed through sudo
# by name only, and the resolved mount remains the caller-selected one.
arbitrary_home="$work/custom-home"
mkdir "$arbitrary_home"
export HERDSMAN_HOME="$arbitrary_home" MOCK_ARBITRARY=1
: >"$DOCKER_LOG"
bash "$root/scripts/docker-setup.sh" >"$work/sudo-arbitrary.out"
grep -q '^sudo --preserve-env=SSH_AUTHORIZED_KEYS,HERDSMAN_HOME docker compose config --format json$' "$DOCKER_LOG"
! grep -Fq "$arbitrary_home" "$DOCKER_LOG" "$work/sudo-arbitrary.out"
# If the variable list is incomplete, differing direct and sudo models must
# fail before any mount, authorization, or deployment operation.
export MOCK_HIDE_VARIABLE=1
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/sudo-drift.out" 2>&1; then
  echo 'Expected sudo interpolation drift refusal.' >&2; exit 1
fi
grep -q 'sudo changes the resolved Compose configuration' "$work/sudo-drift.out"
! grep -q '^docker run ' "$DOCKER_LOG"
! grep -q 'compose up -d' "$DOCKER_LOG"
test ! -e "$sudo_project/fallback-home"
unset HERDSMAN_HOME MOCK_ARBITRARY MOCK_HIDE_VARIABLE
# A denied preserve policy produces a direct diagnostic and does not log the key.
export SUDO_PRESERVE_DENIED=1 COMPOSE_PROJECT_NAME=chosen-project
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/sudo-denied.out" 2>&1; then
  echo 'Expected sudo preserve policy rejection.' >&2; exit 1
fi
grep -q 'sudo denied preserving required environment names' "$work/sudo-denied.out"
! grep -q "$test_key" "$DOCKER_LOG" "$work/sudo-denied.out"
unset SUDO_PRESERVE_DENIED DOCKER_DIRECT_FAIL COMPOSE_PROJECT_NAME
# Sudo Tailscale bootstrap passes the secret through a narrowly preserved env var, never argv.
sudo_ts_project="$work/sudo-tailscale-project"
mkdir -p "$sudo_ts_project"
export PI_HERDSMAN_DIR="$sudo_ts_project" DOCKER_DIRECT_FAIL=1 TS_AUTHKEY='sudo-test-bootstrap-secret' TAILSCALE_ORDER_TEST=1 TAILSCALE_COUNT="$work/sudo-tailscale-count"
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml\n' >"$sudo_ts_project/.env"
cp "$root/compose.yaml" "$sudo_ts_project/compose.yaml"
cp "$root/compose.tailscale.yaml" "$sudo_ts_project/compose.tailscale.yaml"
: >"$DOCKER_LOG"; rm -f "$TAILSCALE_COUNT"
bash "$root/scripts/docker-setup.sh" >"$work/sudo-tailscale.out"
grep -Fx 'sudo --preserve-env=SSH_AUTHORIZED_KEYS,TS_AUTHKEY docker compose up -d --force-recreate tailscale' "$DOCKER_LOG"
grep -Fx 'bootstrap-key-delivered-via-env' "$DOCKER_LOG"
! grep -q 'sudo-test-bootstrap-secret' "$DOCKER_LOG" "$work/sudo-tailscale.out"
unset DOCKER_DIRECT_FAIL TAILSCALE_ORDER_TEST TAILSCALE_COUNT TS_AUTHKEY
# Every sudo Compose operation sees the same explicit overrides, including empty IDs.
export DOCKER_DIRECT_FAIL=1 CAPTURE_OVERRIDES=1 OVERRIDE_LOG="$work/overrides.log"
export COMPOSE_FILE='compose.yaml;compose.tailscale.yaml' COMPOSE_PATH_SEPARATOR=';' COMPOSE_PROJECT_NAME=chosen-project
export PUID='' PGID='' HERDSMAN_SSH_PORT=4321 TAILSCALE_HOSTNAME=chosen-host
export TAILSCALE_ORDER_TEST=1 TAILSCALE_COUNT="$work/override-count" TS_AUTHKEY='override-bootstrap-secret'
printf 'COMPOSE_FILE=compose.yaml\nCOMPOSE_PATH_SEPARATOR=:\nCOMPOSE_PROJECT_NAME=wrong\nPUID=999\nPGID=998\nHERDSMAN_SSH_PORT=1234\nTAILSCALE_HOSTNAME=wrong\n' >"$sudo_ts_project/.env"
: >"$DOCKER_LOG"; : >"$OVERRIDE_LOG"; rm -f "$TAILSCALE_COUNT"
bash "$root/scripts/docker-setup.sh" >"$work/override.out" 2>&1
expected='|COMPOSE_FILE=compose.yaml;compose.tailscale.yaml|COMPOSE_PATH_SEPARATOR=;|COMPOSE_PROJECT_NAME=chosen-project|PUID=|PGID=|HERDSMAN_SSH_PORT=4321|TAILSCALE_HOSTNAME=chosen-host'
grep -F "compose config --format" "$OVERRIDE_LOG" | grep -F "$expected"
grep -F "compose up -d" "$OVERRIDE_LOG" | grep -F "$expected"
grep -F "compose exec -T tailscale" "$OVERRIDE_LOG" | grep -F "$expected"
test "$(grep -F "compose up -d --force-recreate tailscale" "$OVERRIDE_LOG" | grep -Fc "$expected")" -eq 2
grep -F 'tailscale-recreate ' "$DOCKER_LOG" | tail -n1 | grep -Fx 'tailscale-recreate '
! grep -F 'override-bootstrap-secret' "$DOCKER_LOG" "$work/override.out"
! grep -F "$test_key" "$DOCKER_LOG" "$work/override.out"
# Nonempty IDs also override conflicting .env values across the lifecycle.
export PUID=2000 PGID=2001
: >"$OVERRIDE_LOG"; rm -f "$TAILSCALE_COUNT"
bash "$root/scripts/docker-setup.sh" >"$work/override-ids.out" 2>&1
for operation in 'compose config --format' 'compose up -d' 'compose exec -T tailscale' 'compose up -d --force-recreate tailscale'; do
  grep -F "$operation" "$OVERRIDE_LOG" | grep -Fq '|PUID=2000|PGID=2001|'
done
export PUID='' PGID=''
# Standard mode exercises port lookup with the same overrides.
export COMPOSE_FILE=compose.yaml
: >"$OVERRIDE_LOG"
bash "$root/scripts/docker-setup.sh" >"$work/override-port.out" 2>&1
grep -F 'compose port herdsman 22' "$OVERRIDE_LOG" | grep -F '|COMPOSE_PROJECT_NAME=chosen-project|PUID=|PGID=|HERDSMAN_SSH_PORT=4321|TAILSCALE_HOSTNAME=chosen-host'
unset DOCKER_DIRECT_FAIL CAPTURE_OVERRIDES OVERRIDE_LOG COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROJECT_NAME PUID PGID HERDSMAN_SSH_PORT TAILSCALE_HOSTNAME TAILSCALE_ORDER_TEST TAILSCALE_COUNT TS_AUTHKEY
# Existing bind ownership and Compose both honor process IDs through sudo's environment reset.
sudo_bind="$work/sudo-bind"
mkdir -p "$sudo_bind/data/herdsman-home"
cp "$root/compose.yaml" "$root/compose.tailscale.yaml" "$root/compose.bind-mount.yaml" "$sudo_bind/"
export PI_HERDSMAN_DIR="$sudo_bind" DOCKER_DIRECT_FAIL=1 CAPTURE_OVERRIDES=1 OVERRIDE_LOG="$work/sudo-bind-overrides.log"
export PUID="$(stat -c '%u' "$sudo_bind/data/herdsman-home")" PGID="$(stat -c '%g' "$sudo_bind/data/herdsman-home")"
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml\nPUID=%s\nPGID=%s\n' "$((PUID + 1))" "$((PGID + 1))" >"$sudo_bind/.env"
: >"$DOCKER_LOG"; : >"$OVERRIDE_LOG"
bash "$root/scripts/docker-setup.sh" >"$work/sudo-bind.out" 2>&1
grep -q 'Herdsman is ready' "$work/sudo-bind.out"
grep -q '^sudo --preserve-env=PUID,PGID docker info$' "$DOCKER_LOG"
for operation in 'compose config --format' 'compose up -d'; do
  grep -F "$operation" "$OVERRIDE_LOG" | grep -Fq "|PUID=$PUID|PGID=$PGID|"
done
test "$PUID:$PGID" = "$(stat -c '%u:%g' "$sudo_bind/data/herdsman-home")"
unset DOCKER_DIRECT_FAIL CAPTURE_OVERRIDES OVERRIDE_LOG PUID PGID
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
# Empty values resolve to the image defaults, not the calling user's IDs.
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml\nPUID=\nPGID=\n' >"$bind_mismatch/.env"
bash "$root/scripts/docker-setup.sh" >"$work/default-id.out"
grep -q 'Herdsman is ready' "$work/default-id.out"
test ! -e "$SSH_KEYGEN_MARKER"
# Both an executed installer and a piped installer use the caller's directory,
# rather than the script location or a directory under HOME.
cwd_project="$work/current deployment"
mkdir -p "$cwd_project"
cp "$root/compose.yaml" "$cwd_project/compose.yaml"
printf 'COMPOSE_FILE=compose.yaml\n' >"$cwd_project/.env"
for invocation in direct piped; do
  if [[ "$invocation" == direct ]]; then
    (cd "$cwd_project"; unset PI_HERDSMAN_DIR; bash "$root/scripts/docker-setup.sh") >"$work/cwd.out"
  else
    (cd "$cwd_project"; unset PI_HERDSMAN_DIR; bash <"$root/scripts/docker-setup.sh") >"$work/cwd.out"
  fi
  grep -Fx "Herdsman is ready in $cwd_project" "$work/cwd.out"
done

# All safety decisions use the resolved model and precede Compose up.
export PI_HERDSMAN_DIR="$work/project"
for name in PUID PGID; do
  export "$name=0"
  : >"$DOCKER_LOG"
  if bash "$root/scripts/docker-setup.sh" >"$work/zero-id.out" 2>&1; then
    echo "Expected $name=0 rejection." >&2; exit 1
  fi
  grep -q 'positive decimal integer' "$work/zero-id.out"
  ! grep -q 'compose up -d' "$DOCKER_LOG"
  unset "$name"
done
export MOCK_CONTAINER_IDS=container1
export MOCK_CONTAINERS
MOCK_CONTAINERS=$(jq -n --arg dir "$work/other" '[{Config:{Labels:{"com.docker.compose.project.working_dir":$dir,"com.docker.compose.service":"herdsman"}},Mounts:[]}]')
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/collision.out" 2>&1; then
  echo 'Expected cross-directory collision rejection.' >&2; exit 1
fi
grep -Fq "$work/other" "$work/collision.out"
grep -Fq "$work/project" "$work/collision.out"
grep -Fq 'test-project' "$work/collision.out"
! grep -q 'compose up -d' "$DOCKER_LOG"
MOCK_CONTAINERS=$(jq -n --arg dir "$work/project" '[{Config:{Labels:{"com.docker.compose.project.working_dir":$dir,"com.docker.compose.service":"herdsman"}},Mounts:[{Destination:"/home/herdsman",Type:"volume",Name:"old-home"}]}]')
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/migration.out" 2>&1; then
  echo 'Expected home mount migration rejection.' >&2; exit 1
fi
grep -q 'refusing migration' "$work/migration.out"
! grep -q 'compose up -d' "$DOCKER_LOG"
MOCK_CONTAINERS=$(jq -n --arg dir "$work/project" '[{Config:{Labels:{"com.docker.compose.project.working_dir":$dir,"com.docker.compose.service":"herdsman"}},Mounts:[{Destination:"/home/herdsman",Type:"volume",Name:"test-project_home"}]}]')
bash "$root/scripts/docker-setup.sh" >"$work/same-project.out"
grep -q 'Herdsman is ready' "$work/same-project.out"
unset MOCK_CONTAINER_IDS MOCK_CONTAINERS
# An override-provided bind mount is checked even without the official overlay.
override_home="$work/override-home"
mkdir "$override_home"
chmod 0777 "$override_home"
export MOCK_MODEL
MOCK_MODEL=$(jq -n --arg source "$override_home" '{name:"test-project",services:{herdsman:{environment:{},volumes:[{type:"bind",source:$source,target:"/home/herdsman"}]}}}')
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/unsafe-home.out" 2>&1; then
  echo 'Expected unsafe home mode rejection.' >&2; exit 1
fi
grep -q 'not group/other writable' "$work/unsafe-home.out"
! grep -q 'compose up -d' "$DOCKER_LOG"
unset MOCK_MODEL
# Simulate an existing nonstandard home without requiring privileged chown.
cat >"$work/bin/stat" <<'MOCK'
#!/usr/bin/env bash
if [[ "${*: -1}" == "${MOCK_STAT_HOME:-}" ]]; then
  case "$2" in '%u'|'%g') echo 2000; exit ;; esac
fi
exec /usr/bin/stat "$@"
MOCK
chmod +x "$work/bin/stat"
export PI_HERDSMAN_DIR="$bind_project" MOCK_STAT_HOME="$bind_project/data/herdsman-home"
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml\n' >"$bind_project/.env"
bash "$root/scripts/docker-setup.sh" >"$work/derived-ids.out"
grep -Fx 'PUID=2000' "$bind_project/.env"
grep -Fx 'PGID=2000' "$bind_project/.env"
unset MOCK_STAT_HOME

# Exercise the actual account check with a deterministic image account database.
mkdir "$work/accounts"
cat >"$work/accounts/id" <<'MOCK'
#!/usr/bin/env bash
[[ "$2" == herdsman ]] || exit 1
case "$1" in -u|-g) echo 1000 ;; *) exit 1 ;; esac
MOCK
cat >"$work/accounts/getent" <<'MOCK'
#!/usr/bin/env bash
if [[ "$1:$2" == passwd:2000 || "$1:$2" == group:2001 ]]; then exit 0; fi
exit 2
MOCK
chmod +x "$work/accounts/id" "$work/accounts/getent"
export PI_HERDSMAN_DIR="$order_project" MOCK_ACCOUNT_EXEC=1 MOCK_ACCOUNT_PATH="$work/accounts"
export SSH_AUTHORIZED_KEYS="$test_key"$'\n'"$ecdsa_zero_point"
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/key-preflight-fail.out" 2>&1; then
  echo 'Expected cryptographically invalid key preflight failure.' >&2; exit 1
fi
! grep -q '^docker compose up -d' "$DOCKER_LOG"
export SSH_AUTHORIZED_KEYS="$test_key" PI_HERDSMAN_DIR="$work/project"
for pair in '2000 1000' '1000 2001'; do
  read -r PUID PGID <<<"$pair"
  export PUID PGID
  : >"$DOCKER_LOG"
  if bash "$root/scripts/docker-setup.sh" >"$work/account-conflict.out" 2>&1; then
    echo 'Expected image account conflict.' >&2; exit 1
  fi
  grep -q 'image account or public-key preflight failed' "$work/account-conflict.out"
  ! grep -q '^docker compose run --rm --no-deps -T --user 1000:1000' "$DOCKER_LOG"
  ! grep -q '^docker compose up -d$' "$DOCKER_LOG"
done
unset PUID PGID
export PI_HERDSMAN_DIR="$bind_project" MOCK_STAT_HOME="$bind_project/data/herdsman-home"
printf 'COMPOSE_FILE=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml\n' >"$bind_project/.env"
cp "$bind_project/.env" "$work/derived-before.env"
: >"$DOCKER_LOG"
if bash "$root/scripts/docker-setup.sh" >"$work/derived-account-conflict.out" 2>&1; then
  echo 'Expected derived image UID conflict.' >&2; exit 1
fi
grep -q 'image account or public-key preflight failed' "$work/derived-account-conflict.out"
! grep -q '^docker compose up -d$' "$DOCKER_LOG"
cmp "$work/derived-before.env" "$bind_project/.env"
# Failed authorization likewise does not persist inferred IDs.
unset MOCK_ACCOUNT_EXEC SSH_AUTHORIZED_KEYS
export PERSISTENT_KEYS=0
if bash "$root/scripts/docker-setup.sh" >"$work/derived-auth-fail.out" 2>&1; then
  echo 'Expected derived-ID authorization failure.' >&2; exit 1
fi
cmp "$work/derived-before.env" "$bind_project/.env"
export SSH_AUTHORIZED_KEYS="$test_key"
unset MOCK_ACCOUNT_PATH MOCK_STAT_HOME PERSISTENT_KEYS

# Exercise the actual authorization shell against an isolated persistent home.
export PI_HERDSMAN_DIR="$work/project" TEST_AUTH_HOME="$work/auth-home"
mkdir "$TEST_AUTH_HOME" "$work/key1" "$work/key2"
/usr/bin/ssh-keygen -q -t ed25519 -N '' -f "$work/key1/key"
/usr/bin/ssh-keygen -q -t ed25519 -N '' -f "$work/key2/key"
key1=$(<"$work/key1/key.pub")
key2=$(<"$work/key2/key.pub")
mkdir "$TEST_AUTH_HOME/.ssh"
printf 'restrict %s\n' "$key1" >"$TEST_AUTH_HOME/.ssh/authorized_keys"
cp "$TEST_AUTH_HOME/.ssh/authorized_keys" "$work/existing-auth"
chmod 777 "$TEST_AUTH_HOME/.ssh"
chmod 666 "$TEST_AUTH_HOME/.ssh/authorized_keys"
export SSH_AUTHORIZED_KEYS="$key1"$'\n'"$key2"
bash "$root/scripts/docker-setup.sh" >"$work/auth-append.out"
test "$(wc -l <"$TEST_AUTH_HOME/.ssh/authorized_keys")" -eq 2
test "$(stat -c %a "$TEST_AUTH_HOME/.ssh")" = 700
test "$(stat -c %a "$TEST_AUTH_HOME/.ssh/authorized_keys")" = 600
head -n 1 "$TEST_AUTH_HOME/.ssh/authorized_keys" | cmp - "$work/existing-auth"
cp "$TEST_AUTH_HOME/.ssh/authorized_keys" "$work/expected-auth"
bash "$root/scripts/docker-setup.sh" >"$work/auth-repeat.out"
cmp "$work/expected-auth" "$TEST_AUTH_HOME/.ssh/authorized_keys"
# A malformed second key is rejected before any persistent write.
export SSH_AUTHORIZED_KEYS="$key1"$'\n''ssh-ed25519 AQID malformed'
if bash "$root/scripts/docker-setup.sh" >"$work/auth-invalid.out" 2>&1; then
  echo 'Expected malformed additional key rejection.' >&2; exit 1
fi
cmp "$work/expected-auth" "$TEST_AUTH_HOME/.ssh/authorized_keys"
# Even a structurally valid but cryptographically invalid second key must
# fail inside the container before the first key is appended.
printf '%s\n' "$key1" >"$TEST_AUTH_HOME/.ssh/authorized_keys"
cp "$TEST_AUTH_HOME/.ssh/authorized_keys" "$work/before-crypto"
export SSH_AUTHORIZED_KEYS="$key2"$'\n'"$ecdsa_zero_point"
if bash "$root/scripts/docker-setup.sh" >"$work/auth-crypto-invalid.out" 2>&1; then
  echo 'Expected cryptographically invalid key rejection.' >&2; exit 1
fi
cmp "$work/before-crypto" "$TEST_AUTH_HOME/.ssh/authorized_keys"
cp "$work/expected-auth" "$TEST_AUTH_HOME/.ssh/authorized_keys"
# Keys from the resolved Compose environment are used even with no shell key.
unset SSH_AUTHORIZED_KEYS
export MOCK_MODEL
MOCK_MODEL=$(jq -n --arg key "$key2" '{name:"test-project",services:{herdsman:{image:"example/herdsman",environment:{SSH_AUTHORIZED_KEYS:$key},volumes:[{type:"volume",source:"home",target:"/home/herdsman"}]}},volumes:{home:{name:"test-project_home"}}}')
printf '%s\n' "$key1" >"$TEST_AUTH_HOME/.ssh/authorized_keys"
bash "$root/scripts/docker-setup.sh" >"$work/resolved-key.out"
test "$(wc -l <"$TEST_AUTH_HOME/.ssh/authorized_keys")" -eq 2
unset MOCK_MODEL
cp "$work/expected-auth" "$TEST_AUTH_HOME/.ssh/authorized_keys"
# A symlink authorization target is never followed.
mv "$TEST_AUTH_HOME/.ssh/authorized_keys" "$work/saved-auth"
ln -s "$work/saved-auth" "$TEST_AUTH_HOME/.ssh/authorized_keys"
export SSH_AUTHORIZED_KEYS="$key2"
if bash "$root/scripts/docker-setup.sh" >"$work/auth-symlink.out" 2>&1; then
  echo 'Expected authorization symlink rejection.' >&2; exit 1
fi
cmp "$work/expected-auth" "$work/saved-auth"
rm "$TEST_AUTH_HOME/.ssh/authorized_keys"
mv "$work/saved-auth" "$TEST_AUTH_HOME/.ssh/authorized_keys"
# Comments alone do not count as authorization.
printf '# %s\n' "$key1" >"$TEST_AUTH_HOME/.ssh/authorized_keys"
unset SSH_AUTHORIZED_KEYS
if bash "$root/scripts/docker-setup.sh" >"$work/comment-only.out" 2>&1; then
  echo 'Expected comment-only authorization rejection.' >&2; exit 1
fi
# A fresh persistent home gets private authorization-file permissions.
rm "$TEST_AUTH_HOME/.ssh/authorized_keys"
rmdir "$TEST_AUTH_HOME/.ssh"
export SSH_AUTHORIZED_KEYS="$key1"
bash "$root/scripts/docker-setup.sh" >"$work/auth-fresh.out"
test "$(stat -c %a "$TEST_AUTH_HOME/.ssh")" = 700
test "$(stat -c %a "$TEST_AUTH_HOME/.ssh/authorized_keys")" = 600
# Interactive decline does not add a discovered host key.
mkdir -p "$HOME/.ssh"
printf '%s\n' "$key2" >"$HOME/.ssh/id_ed25519.pub"
printf '%s\n' "$key1" >"$TEST_AUTH_HOME/.ssh/authorized_keys"
unset SSH_AUTHORIZED_KEYS
printf 'n\n\n' | script -qec "bash \"$root/scripts/docker-setup.sh\"" /dev/null >"$work/decline.out"
grep -q 'Authorize public key' "$work/decline.out"
test "$(wc -l <"$TEST_AUTH_HOME/.ssh/authorized_keys")" -eq 1
grep -Fxq "$key1" "$TEST_AUTH_HOME/.ssh/authorized_keys"
printf 'y\n%s\n\n' "$work/key1/key.pub" | script -qec "bash \"$root/scripts/docker-setup.sh\"" /dev/null >"$work/accept.out"
test "$(wc -l <"$TEST_AUTH_HOME/.ssh/authorized_keys")" -eq 2
test ! -e "$HOME/.ssh/id_ed25519"
unset TEST_AUTH_HOME

echo 'Bash Docker setup mocked checks passed.'
