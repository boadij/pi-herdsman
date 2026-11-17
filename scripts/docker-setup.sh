#!/usr/bin/env bash
set -Eeuo pipefail

die() { printf 'docker-setup: %s\n' "$*" >&2; exit 1; }
tmp_files=()
tmp_key_dir=
cleanup() {
  if [[ "${ts_bootstrap_active:-0}" == 1 ]]; then
    unset TS_AUTHKEY ts_authkey bootstrap_ts_authkey
    if ! docker_cmd compose up -d --force-recreate tailscale; then
      printf 'docker-setup: WARNING: failed to restore key-free Tailscale configuration.\\n' >&2
    else
      ts_bootstrap_active=0
      docker_cmd compose up -d --force-recreate herdsman || printf 'docker-setup: WARNING: failed to recreate Herdsman in the restored Tailscale network namespace.\\n' >&2
    fi
  fi
  (("${#tmp_files[@]}" == 0)) || rm -f -- "${tmp_files[@]}"
  if [[ -n "$tmp_key_dir" ]]; then rm -f -- "$tmp_key_dir/id_ed25519" "$tmp_key_dir/id_ed25519.pub"; rmdir -- "$tmp_key_dir"; fi
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
use_sudo=0
docker_cmd() {
  if (( ! use_sudo )); then
    docker "$@"
    return
  fi
  local name names=
  for name in COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROJECT_NAME PUID PGID HERDSMAN_SSH_PORT TAILSCALE_HOSTNAME; do
    if [[ ${!name+x} ]]; then names+=${names:+,}$name; fi
  done
  if [[ "${1:-} ${2:-}" == "compose up" ]]; then
    for name in SSH_AUTHORIZED_KEYS TS_AUTHKEY; do
      if [[ ${!name+x} ]]; then names+=${names:+,}$name; fi
    done
  fi
  local -a sudo_args=()
  [[ -z "$names" ]] || sudo_args+=("--preserve-env=$names")
  sudo "${sudo_args[@]}" docker "$@"
}
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required."
if ! docker info >/dev/null 2>&1; then
  command -v sudo >/dev/null || die "Docker engine is unavailable and sudo is not installed."
  use_sudo=1
  docker_cmd compose version >/dev/null && docker_cmd info >/dev/null || die "Docker engine is unavailable or sudo denied preserving required environment names; grant direct Docker access or allow the requested sudo --preserve-env names."
fi

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

if [[ "$selection" == *compose.bind-mount.yaml* && "$(uname -s)" != Linux ]]; then
  die "the host bind-mount option is supported only on Linux."
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

if [[ "$selection" == *compose.bind-mount.yaml* ]]; then
  home_dir=data/herdsman-home
  home_was_present=0
  [[ -d "$home_dir" ]] && home_was_present=1
  mkdir -p -- "$home_dir" || die "cannot prepare bind-mounted home: $home_dir"
  bind_uid=$(stat -c '%u' "$home_dir")
  bind_gid=$(stat -c '%g' "$home_dir")

  dotenv_id() {
    local name=$1
    parse_compose_value "$(awk -F= -v name="$name" '$0 ~ "^[[:space:]]*(export[[:space:]]+)?" name "[[:space:]]*=" {sub(/^[^=]*=/, ""); print; exit}' "$env_file")"
  }
  has_dotenv_id() { grep -Eq "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$env_file"; }
  configured_uid=${PUID-$(dotenv_id PUID)}
  configured_gid=${PGID-$(dotenv_id PGID)}
  if [[ -z "$configured_uid" ]] && ! has_dotenv_id PUID && [[ -z "${PUID+x}" ]] && (( ! home_was_present )); then
    configured_uid=$(id -u)
    printf 'PUID=%s\n' "$configured_uid" >>"$env_file"
  fi
  if [[ -z "$configured_gid" ]] && ! has_dotenv_id PGID && [[ -z "${PGID+x}" ]] && (( ! home_was_present )); then
    configured_gid=$(id -g)
    printf 'PGID=%s\n' "$configured_gid" >>"$env_file"
  fi
  if [[ -z "$configured_uid" || -z "$configured_gid" ]]; then
    container_ids=$(docker_cmd compose run --rm --no-deps --entrypoint sh herdsman -c 'printf "%s %s" "$(id -u herdsman)" "$(id -g herdsman)"') || die "could not determine the Compose default Herdsman UID/GID."
    read -r default_uid default_gid <<<"$container_ids"
    configured_uid=${configured_uid:-$default_uid}
    configured_gid=${configured_gid:-$default_gid}
  fi
  [[ "$configured_uid" == "$bind_uid" ]] || die "bind-mounted home $home_dir is owned by UID $bind_uid, but effective PUID is $configured_uid; preserve the data and set PUID to $bind_uid or use a directory owned by $configured_uid."
  [[ "$configured_gid" == "$bind_gid" ]] || die "bind-mounted home $home_dir is owned by GID $bind_gid, but effective PGID is $configured_gid; preserve the data and set PGID to $bind_gid or use a directory owned by $configured_gid."
fi

ssh_key="${SSH_AUTHORIZED_KEYS:-}"
if [[ -z "$ssh_key" ]]; then
  for candidate in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do
    if [[ -r "$candidate" ]]; then ssh_key="$(<"$candidate")"; break; fi
  done
fi
docker_cmd compose config --quiet || die "Docker Compose configuration is invalid."
if [[ -z "$ssh_key" ]] && ! docker_cmd compose run --rm --no-deps --entrypoint sh herdsman -c 'test -s /home/herdsman/.ssh/authorized_keys' >/dev/null 2>&1; then
  key_path="$HOME/.ssh/id_ed25519"
  public_path="$key_path.pub"
  command -v ssh-keygen >/dev/null || die "ssh-keygen is required to generate or recover an SSH identity."
  mkdir -p -m 0700 -- "$HOME/.ssh" || die "cannot create SSH directory."
  if [[ -e "$key_path" || -L "$key_path" ]]; then
    [[ ! -e "$public_path" && ! -L "$public_path" ]] || die "SSH identity is incomplete; refusing to overwrite existing files."
    tmp_key_dir=$(mktemp -d "$HOME/.ssh/.identity.XXXXXX") || die "cannot prepare SSH public-key recovery."
    tmp_pub="$tmp_key_dir/id_ed25519.pub"
    ssh-keygen -y -P '' -f "$key_path" </dev/null >"$tmp_pub" && [[ -s "$tmp_pub" ]] || die "cannot recover SSH public key; existing private key was preserved."
    ln -- "$tmp_pub" "$HOME/.ssh" || die "cannot publish recovered SSH public key without overwriting an existing file."
    rm -f -- "$tmp_pub"
    printf 'Recovered SSH public key: %s\n' "$public_path"
  elif [[ -e "$public_path" || -L "$public_path" ]]; then
    die "SSH identity is incomplete; refusing to overwrite existing files."
  else
    # Source basenames match the intended destination names. Linking into the
    # SSH directory fails if that exact name exists, including a directory.
    tmp_key_dir=$(mktemp -d "$HOME/.ssh/.identity.XXXXXX") || die "cannot prepare SSH identity generation."
    (umask 077; ssh-keygen -q -t ed25519 -N '' -f "$tmp_key_dir/id_ed25519" </dev/null) || die "cannot generate SSH identity."
    [[ -s "$tmp_key_dir/id_ed25519" && -s "$tmp_key_dir/id_ed25519.pub" ]] || die "cannot generate SSH identity."
    ln -- "$tmp_key_dir/id_ed25519" "$HOME/.ssh" || die "cannot publish SSH private key without overwriting an existing file."
    ln -- "$tmp_key_dir/id_ed25519.pub" "$HOME/.ssh" || die "cannot publish SSH public key without overwriting an existing file; generated private key was preserved."
    printf 'Generated SSH login identity: %s\n' "$key_path"
  fi
  [[ -s "$public_path" ]] || die "SSH public key is missing or empty."
  ssh_key="$(<"$public_path")"
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
docker_cmd compose up -d || die "Docker Compose could not start the deployment; sudo may deny preserving requested environment names."

if [[ "$selection" == *compose.tailscale.yaml* ]]; then
  authenticated=0
  for _ in {1..10}; do
    if docker_cmd compose exec -T tailscale tailscale status --json 2>/dev/null | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then authenticated=1; break; fi
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
    export TS_AUTHKEY="$ts_authkey"
    docker_cmd compose up -d --force-recreate tailscale || bootstrap_status=$?
    unset TS_AUTHKEY
    if [[ "${bootstrap_status:-0}" != 0 ]]; then
      unset ts_authkey bootstrap_ts_authkey
      docker_cmd compose up -d --force-recreate tailscale || printf 'docker-setup: WARNING: failed to restore key-free Tailscale configuration.\n' >&2
      die "Tailscale bootstrap failed."
    fi
    unset ts_authkey bootstrap_ts_authkey
    authenticated=0
    for _ in {1..30}; do
      if docker_cmd compose exec -T tailscale tailscale status --json 2>/dev/null | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then authenticated=1; break; fi
      sleep 2
    done
    cleanup_status=0
    docker_cmd compose up -d --force-recreate tailscale || cleanup_status=$?
    if (( cleanup_status == 0 )); then
      ts_bootstrap_active=0
      docker_cmd compose up -d --force-recreate herdsman || cleanup_status=$?
    fi
    (( authenticated )) || die "Tailscale authentication did not complete."
    (( cleanup_status == 0 )) || die "Tailscale authenticated, but key-free configuration restoration failed."
  fi
fi

ready=0
for _ in {1..30}; do
  if docker_cmd compose exec -T herdsman sh -c 'test -d /run/sshd && grep -q ":0016 " /proc/net/tcp /proc/net/tcp6' >/dev/null 2>&1; then ready=1; break; fi
  sleep 2
done
(( ready )) || die "Herdsman did not become ready; inspect with: docker compose logs herdsman"
printf 'Herdsman is ready in %s\n' "$project_dir"
compose_env="$( docker_cmd compose config --environment 2>/dev/null || true )"
compose_value() {
  local name=$1 default=$2 value
  value="$(printf '%s\n' "$compose_env" | sed -n "s/^$name=//p" | head -n 1)"
  printf '%s' "${value:-$default}"
}
if [[ "$selection" == *compose.tailscale.yaml* ]]; then
  dotenv_hostname=""
  if [[ -f "$env_file" ]]; then
    dotenv_hostname="$(parse_compose_value "$(awk -F= '/^[[:space:]]*(export[[:space:]]+)?TAILSCALE_HOSTNAME[[:space:]]*=/ {sub(/^[^=]*=/, ""); print; exit}' "$env_file")")"
  fi
  hostname=${TAILSCALE_HOSTNAME:-$(compose_value TAILSCALE_HOSTNAME "$dotenv_hostname")}
  printf 'Connect with: ssh herdsman@%s\n' "${hostname:-pi-herdsman}"
else
  published_port=$(docker_cmd compose port herdsman 22 | awk -F: 'NF {port=$NF} END {gsub(/[^0-9]/, "", port); print port}')
  [[ "$published_port" =~ ^[0-9]+$ ]] || die "could not determine the published Herdsman SSH port."
  printf 'Connect with: ssh -p %s herdsman@localhost\n' "$published_port"
fi
printf 'Container SSH host key: docker compose exec herdsman cat /var/lib/herdsman/ssh/ssh_host_ed25519_key.pub\n'
