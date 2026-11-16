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
if [[ "$1 $2" == "compose version" || "$1" == info ]]; then exit 0; fi
if [[ "$1 $2" == "compose run" ]]; then [[ "${PERSISTENT_KEYS:-0}" == 1 ]]; exit; fi
if [[ "$1 $2 $3" == "compose exec -T" ]]; then exit 0; fi
if [[ "$1 $2" == "compose" ]]; then exit 0; fi
exit 0
MOCK
cat >"$work/bin/curl" <<'MOCK'
#!/usr/bin/env bash
while (($#)); do
  if [[ "$1" == -o ]]; then shift; cp "$OFFICIAL_COMPOSE" "$1"; exit; fi
  shift
done
exit 2
MOCK
chmod +x "$work/bin/docker" "$work/bin/curl"
export PATH="$work/bin:$PATH" SSH_KEYGEN_MARKER="$work/ssh-keygen-invoked"
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
echo 'Bash Docker setup mocked checks passed.'
