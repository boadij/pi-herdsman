#!/usr/bin/env bash
set -Eeuo pipefail

die() { printf 'docker-setup: %s\n' "$*" >&2; exit 1; }
tmp_files=()
cleanup() {
  if [[ "${ts_bootstrap_active:-0}" == 1 ]]; then
    unset TS_AUTHKEY ts_authkey bootstrap_ts_authkey
    if ! docker compose up -d --force-recreate tailscale; then
      printf 'docker-setup: WARNING: failed to restore key-free Tailscale configuration.\\n' >&2
    else
      ts_bootstrap_active=0
    fi
  fi
  (("${#tmp_files[@]}" == 0)) || rm -f -- "${tmp_files[@]}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

script_path="${BASH_SOURCE[0]:-}"
if [[ -n "${PI_HERDSMAN_DIR:-}" ]]; then
  project_dir=$PI_HERDSMAN_DIR
elif [[ -f "$script_path" && -f "$(dirname -- "$script_path")/../compose.yaml" ]]; then
  project_dir="$(cd -- "$(dirname -- "$script_path")/.." && pwd)"
else
  project_dir="$HOME/pi-herdsman"
fi
mkdir -p -- "$project_dir" || die "cannot create deployment directory: $project_dir"
cd -- "$project_dir"

command -v docker >/dev/null || die "Docker CLI is required; install Docker Desktop or Docker Engine first."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."
docker info >/dev/null 2>&1 || die "Docker engine is unavailable; start Docker and retry."

env_file=.env
# Do not execute .env. Reject persistent Tailscale bootstrap secrets before setup changes.
if [[ -f "$env_file" ]] && grep -Eq '^[[:space:]]*(export[[:space:]]+)?TS_AUTHKEY[[:space:]]*=[[:space:]]*[^[:space:]#]' "$env_file"; then
  die "remove TS_AUTHKEY from .env; supply it temporarily when prompted."
fi
bootstrap_ts_authkey="${TS_AUTHKEY:-}"
unset TS_AUTHKEY
parse_compose_value() {
  local value=$1 quote= char previous= i
  value="$(printf '%s' "$value" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  for ((i=0; i<${#value}; i++)); do
    char=${value:i:1}
    if [[ -n "$quote" ]]; then
      [[ "$char" == "$quote" ]] && quote=
    elif [[ "$char" == '"' || "$char" == "'" ]]; then
      [[ $i -eq 0 ]] && quote=$char
    elif [[ "$char" == '#' && "$previous" =~ [[:space:]] ]]; then
      value=${value:0:i}
      break
    fi
    previous=$char
  done
  value="$(printf '%s' "$value" | sed 's/[[:space:]]*$//')"
  if [[ ${#value} -ge 2 && ( ( ${value:0:1} == '"' && ${value: -1} == '"' ) || ( ${value:0:1} == "'" && ${value: -1} == "'" ) ) ]]; then
    value=${value:1:${#value}-2}
  fi
  printf '%s' "$value"
}
compose_setting=""
if [[ -n "${COMPOSE_FILE:-}" ]]; then
  compose_setting=$COMPOSE_FILE
elif [[ -f "$env_file" ]]; then
  compose_setting="$(parse_compose_value "$(awk -F= '/^[[:space:]]*(export[[:space:]]+)?COMPOSE_FILE[[:space:]]*=/ {sub(/^[^=]*=/, ""); gsub(/^[[:space:]]+|[[:space:]]+$/, ""); print; exit}' "$env_file")")"
fi

if [[ -n "$compose_setting" ]]; then
  selection=$compose_setting
else
  [[ -t 0 ]] && tty=/dev/stdin || tty=/dev/tty
  [[ -r "$tty" ]] || die "interactive terminal required to choose deployment mode."
  printf 'Deployment: [1] Standard Docker (default) [2] Tailscale [3] Tailscale + host bind mount: ' >"$tty"
  IFS= read -r choice <"$tty" || die "could not read deployment choice."
  case "$choice" in
    ""|1) selection=compose.yaml ;;
    2) selection=compose.yaml:compose.tailscale.yaml ;;
    3) selection=compose.yaml:compose.tailscale.yaml:compose.bind-mount.yaml ;;
    *) die "choose 1, 2, or 3." ;;
  esac
fi

# Reuse Compose's native separator, while recognizing only official files for download.
separator=${COMPOSE_PATH_SEPARATOR:-:}
[[ "$separator" == ":" || "$separator" == ";" ]] || separator=:
IFS="$separator" read -r -a selected_files <<<"$selection"
(("${#selected_files[@]}" > 0)) || die "COMPOSE_FILE is empty."
tmp_files=()
download_if_missing() {
  local name=$1 tmp
  [[ -e "$name" ]] && return 0
  case "$name" in compose.yaml|compose.tailscale.yaml|compose.bind-mount.yaml) ;; *) return 0 ;; esac
  tmp="$(mktemp "./.${name}.tmp.XXXXXX")" || die "cannot create temporary download."
  tmp_files+=("$tmp")
  if ! curl -fsSL --retry 3 "https://raw.githubusercontent.com/boadij/pi-herdsman/main/$name" -o "$tmp" || [[ ! -s "$tmp" ]]; then
    rm -f -- "$tmp"; die "failed to download $name."
  fi
  if ln "$tmp" "$name" 2>/dev/null; then
    rm -f -- "$tmp"
  elif [[ -e "$name" ]]; then
    rm -f -- "$tmp"
  else
    die "failed to publish downloaded $name without replacing an existing file."
  fi
  tmp_files=()
}
for file in "${selected_files[@]}"; do
  [[ -n "$file" ]] || die "COMPOSE_FILE contains an empty entry."
  download_if_missing "$file"
  [[ -f "$file" ]] || die "required Compose file does not exist: $file"
done

if [[ -z "$compose_setting" ]]; then
  umask 077
  if [[ -f "$env_file" ]]; then
    printf '\nCOMPOSE_FILE=%s\n' "$selection" >>"$env_file"
  else
    printf 'COMPOSE_FILE=%s\n' "$selection" >"$env_file"
  fi
fi

ssh_key="${SSH_AUTHORIZED_KEYS:-}"
if [[ -z "$ssh_key" ]]; then
  for candidate in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do
    if [[ -r "$candidate" ]]; then ssh_key="$(<"$candidate")"; break; fi
  done
fi
docker compose config --quiet || die "Docker Compose configuration is invalid."
if [[ -z "$ssh_key" ]] && ! docker compose run --rm --no-deps --entrypoint sh herdsman -c 'test -s /home/herdsman/.ssh/authorized_keys' >/dev/null 2>&1; then
  if ! ( : </dev/tty ) 2>/dev/null; then
    die "an SSH public key is required for a fresh deployment; set SSH_AUTHORIZED_KEYS or run interactively."
  fi
  printf 'SSH public-key file [~/.ssh/id_ed25519.pub]: ' >/dev/tty
  IFS= read -r key_path </dev/tty || die "could not read SSH key path."
  key_path="${key_path:-$HOME/.ssh/id_ed25519.pub}"
  [[ -r "$key_path" ]] || die "SSH public-key file not found: $key_path"
  ssh_key="$(<"$key_path")"
fi
validate_ssh_public_key() {
  local key=$1 type encoded tmp byte_count offset index component component_length component_start
  local -a bytes=()
  [[ "$key" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256|ecdsa-sha2-nistp384|ecdsa-sha2-nistp521|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com)[[:space:]]+([A-Za-z0-9+/]+={0,2})([[:space:]].*)?$ ]] || return 1
  type=${BASH_REMATCH[1]}
  encoded=${BASH_REMATCH[2]}
  tmp="$(mktemp)" || return 1
  if printf '%s' "$encoded" | base64 -d >"$tmp" 2>/dev/null; then
    :
  elif printf '%s' "$encoded" | base64 -D >"$tmp" 2>/dev/null; then
    :
  else
    rm -f -- "$tmp"
    return 1
  fi
  bytes=( $(od -A n -t u1 -v "$tmp") )
  rm -f -- "$tmp"
  byte_count=${#bytes[@]}
  offset=0

  read_component() {
    (( byte_count - offset >= 4 )) || return 1
    component_length=$(( (bytes[offset] << 24) | (bytes[offset+1] << 16) | (bytes[offset+2] << 8) | bytes[offset+3] ))
    offset=$((offset + 4))
    (( component_length > 0 && component_length <= byte_count - offset )) || return 1
    component_start=$offset
    offset=$((offset + component_length))
    return 0
  }

  read_component || return 1
  local type_bytes=
  for ((index=component_start; index<offset; index++)); do
    byte=${bytes[index]}
    (( byte >= 32 && byte <= 126 )) || return 1
    type_bytes+=$(printf '%b' "\\$(printf '%03o' "$byte")")
  done
  [[ "$type_bytes" == "$type" ]] || return 1

  case "$type" in
    ssh-ed25519|sk-ssh-ed25519@openssh.com)
      read_component || return 1
      (( component_length == 32 )) || return 1
      if [[ "$type" == sk-* ]]; then
        read_component || return 1
      fi
      ;;
    ssh-rsa)
      for _ in 1 2; do
        read_component || return 1
        # SSH mpints are signed two's-complement integers. Require a canonical,
        # positive, nonzero encoding: sign padding only when the next byte's
        # high bit is set, and never an unpadded high-bit-set (negative) value.
        (( bytes[component_start] < 128 )) || return 1
        if (( bytes[component_start] == 0 )); then
          (( component_length >= 2 && bytes[component_start+1] >= 128 )) || return 1
        fi
      done
      ;;
    ecdsa-sha2-*|sk-ecdsa-sha2-nistp256@openssh.com)
      local curve
      read_component || return 1
      curve=
      for ((index=component_start; index<offset; index++)); do
        curve+=$(printf '%b' "\\$(printf '%03o' "${bytes[index]}")")
      done
      local expected_curve=${type#sk-}
      expected_curve=${expected_curve#ecdsa-sha2-}
      expected_curve=${expected_curve%@openssh.com}
      [[ "$curve" == "$expected_curve" ]] || return 1
      read_component || return 1
      case "$type" in
        *nistp256*) (( component_length == 65 && bytes[component_start] == 4 )) || return 1 ;;
        *nistp384) (( component_length == 97 && bytes[component_start] == 4 )) || return 1 ;;
        *nistp521) (( component_length == 133 && bytes[component_start] == 4 )) || return 1 ;;
      esac
      if [[ "$type" == sk-* ]]; then read_component || return 1; (( component_length > 0 )) || return 1; fi
      ;;
  esac
  if [[ "$type" == sk-* ]]; then
    (( component_length > 0 )) || return 1
  fi
  (( offset == byte_count ))
}

if [[ -n "$ssh_key" ]]; then
  validate_ssh_public_key "$ssh_key" || die "SSH_AUTHORIZED_KEYS is not a structurally valid OpenSSH public key."
  export SSH_AUTHORIZED_KEYS="$ssh_key"
fi
docker compose up -d || die "Docker Compose could not start the deployment."

if [[ "$selection" == *compose.tailscale.yaml* ]]; then
  authenticated=0
  for _ in {1..10}; do
    if docker compose exec -T tailscale tailscale status --json 2>/dev/null | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then authenticated=1; break; fi
    sleep 2
  done
  if (( ! authenticated )); then
    ts_authkey=$bootstrap_ts_authkey
    if [[ -z "$ts_authkey" ]]; then
      [[ -r /dev/tty ]] || die "Tailscale registration is required; rerun interactively to provide an auth key."
      printf 'Tailscale auth key (input hidden): ' >/dev/tty
      IFS= read -rs ts_authkey </dev/tty || die "could not read Tailscale auth key."
      printf '\n' >/dev/tty
    fi
    [[ -n "$ts_authkey" ]] || die "Tailscale auth key is required."
    ts_bootstrap_active=1
    if ! TS_AUTHKEY="$ts_authkey" docker compose up -d --force-recreate tailscale; then
      unset ts_authkey bootstrap_ts_authkey
      docker compose up -d --force-recreate tailscale || printf 'docker-setup: WARNING: failed to restore key-free Tailscale configuration.\n' >&2
      die "Tailscale bootstrap failed."
    fi
    unset ts_authkey bootstrap_ts_authkey
    authenticated=0
    for _ in {1..30}; do
      if docker compose exec -T tailscale tailscale status --json 2>/dev/null | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then authenticated=1; break; fi
      sleep 2
    done
    cleanup_status=0
    docker compose up -d --force-recreate tailscale || cleanup_status=$?
    (( cleanup_status == 0 )) && ts_bootstrap_active=0
    (( authenticated )) || die "Tailscale authentication did not complete."
    (( cleanup_status == 0 )) || die "Tailscale authenticated, but key-free configuration restoration failed."
  fi
fi

ready=0
for _ in {1..30}; do
  if docker compose exec -T herdsman sh -c 'test -d /run/sshd && grep -q ":0016 " /proc/net/tcp /proc/net/tcp6' >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
(( ready )) || die "Herdsman did not become ready; inspect with: docker compose logs herdsman"
printf 'Herdsman is ready in %s\n' "$project_dir"
if [[ "$selection" == *compose.tailscale.yaml* ]]; then
  printf 'Connect with: ssh herdsman@%s\n' "${TAILSCALE_HOSTNAME:-pi-herdsman}"
else
  printf 'Connect with: ssh -p 2222 herdsman@localhost\n'
fi
printf 'Container SSH host key: docker compose exec herdsman cat /var/lib/herdsman/ssh/ssh_host_ed25519_key.pub\n'
