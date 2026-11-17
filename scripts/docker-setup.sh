#!/usr/bin/env bash
set -Eeuo pipefail

die() { printf 'docker-setup: %s\n' "$*" >&2; exit 1; }
tmp_files=()
compose_extra_names=()
sidecar_credential() {
  # Expose only a marker, never the environment or the credential itself.
  docker_cmd inspect --format '{{range .Config.Env}}{{if eq (index (split . "=") 0) "TS_AUTHKEY"}}{{if ne . "TS_AUTHKEY="}}present{{end}}{{end}}{{end}}' "$1"
}
sidecar_key_free() {
  local ids credential
  ids=$(docker_cmd compose ps --all --quiet tailscale) || return 1
  [[ -n "$ids" && "$ids" != *$'\n'* ]] || return 1
  credential=$(sidecar_credential "$ids") || return 1
  [[ -z "$credential" ]]
}
cleanup() {
  if [[ "${ts_bootstrap_active:-0}" == 1 ]]; then
    unset TS_AUTHKEY ts_authkey bootstrap_ts_authkey
    if ! docker_cmd compose up -d --force-recreate tailscale || ! sidecar_key_free; then
      printf 'docker-setup: ERROR: failed to restore key-free Tailscale configuration; stopping the sidecar.\n' >&2
      if docker_cmd compose stop tailscale; then
        printf 'docker-setup: Tailscale is stopped; its container may still contain a bootstrap credential. Recreate it without TS_AUTHKEY and restore the Herdsman network namespace manually.\n' >&2
      else
        printf 'docker-setup: CRITICAL: could not stop Tailscale; its running container may contain a bootstrap credential. Stop it immediately and recreate it without TS_AUTHKEY; restore the Herdsman network namespace manually.\n' >&2
      fi
    else
      ts_bootstrap_active=0
      docker_cmd compose up -d --force-recreate herdsman || printf 'docker-setup: WARNING: failed to recreate Herdsman in the restored Tailscale network namespace.\n' >&2
    fi
  fi
  (("${#tmp_files[@]}" == 0)) || rm -f -- "${tmp_files[@]}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if [[ -n "${PI_HERDSMAN_DIR:-}" ]]; then
  project_dir=$PI_HERDSMAN_DIR
else
  project_dir=$(pwd -P) || die "current directory is inaccessible; cd into an existing directory and rerun setup."
fi
mkdir -p -- "$project_dir" || die "cannot create deployment directory: $project_dir"
cd -- "$project_dir" || die "cannot enter deployment directory: $project_dir"
project_dir="$(pwd -P)"

command -v docker >/dev/null || die "Docker CLI is required; install Docker Desktop or Docker Engine first."
use_sudo=0
docker_cmd() {
  if (( ! use_sudo )); then
    docker "$@"
    return $?
  fi
  local name names=
  for name in COMPOSE_FILE COMPOSE_PATH_SEPARATOR COMPOSE_PROJECT_NAME PUID PGID HERDSMAN_SSH_PORT TAILSCALE_HOSTNAME; do
    if [[ ${!name+x} ]]; then names+=${names:+,}$name; fi
  done
  if [[ "${1:-}" == compose ]]; then
    for name in SSH_AUTHORIZED_KEYS TS_AUTHKEY "${compose_extra_names[@]}"; do
      if [[ ${!name+x} && ",$names," != *",$name,"* ]]; then names+=${names:+,}$name; fi
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

fresh_install=0
native_file=
for candidate in compose.yaml compose.yml docker-compose.yaml docker-compose.yml; do
  if [[ -f "$candidate" ]]; then native_file=$candidate; break; fi
done
if [[ -n "$compose_setting" ]]; then
  selection=$compose_setting
elif [[ -n "$native_file" ]]; then
  # Let Compose discover the base file and any native override itself.
  selection=$native_file
else
  for candidate in compose.override.yaml compose.override.yml docker-compose.override.yaml docker-compose.override.yml; do
    [[ ! -e "$candidate" ]] || die "incomplete Compose configuration: $candidate exists without a base file."
  done
  fresh_install=1
  [[ -t 0 ]] && tty=/dev/stdin || tty=/dev/tty
  [[ -r "$tty" ]] || die "interactive terminal required to choose deployment mode."
  printf 'Deployment: [1] Standard Docker (default) [2] Tailscale [3] Tailscale + host bind mount: ' >"$tty"
  IFS= read -r choice <"$tty" || die "could not read deployment choice."
  case "$choice" in
    ""|1) selected_files=(compose.yaml) ;;
    2) selected_files=(compose.yaml compose.tailscale.yaml) ;;
    3) selected_files=(compose.yaml compose.tailscale.yaml compose.bind-mount.yaml) ;;
    *) die "choose 1, 2, or 3." ;;
  esac
fi

# Only construct a file list for a fresh deployment. Existing selections are
# interpreted by Compose, including dotenv interpolation and project settings.
if (( fresh_install )); then
  separator=${COMPOSE_PATH_SEPARATOR:-}
  if [[ -z "$separator" && -f "$env_file" && ! ${COMPOSE_PATH_SEPARATOR+x} ]]; then
    separator="$(parse_compose_value "$(awk -F= '/^[[:space:]]*(export[[:space:]]+)?COMPOSE_PATH_SEPARATOR[[:space:]]*=/ {sub(/^[^=]*=/, ""); print; exit}' "$env_file")")"
  fi
  separator=${separator:-:}
  [[ ${#separator} -eq 1 ]] || die "COMPOSE_PATH_SEPARATOR must be one character."
  selection=$(IFS="$separator"; printf '%s' "${selected_files[*]}")
fi
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
if (( fresh_install )); then
  for file in "${selected_files[@]}"; do
    download_if_missing "$file"
    [[ -f "$file" ]] || die "required Compose file does not exist: $file"
  done
fi

if (( fresh_install )) && [[ "$selection" != compose.yaml ]]; then
  umask 077
  if [[ -f "$env_file" ]]; then
    die "cannot select multiple Compose files without changing existing .env; configure COMPOSE_FILE explicitly and rerun."
  else
    printf 'COMPOSE_FILE=%s\n' "$selection" >"$env_file"
  fi
fi

# Ask Compose which shell variables its model interpolates. Preserve names,
# never values, through sudo; do not expose privileged command-loader controls.
if (( use_sudo )); then
  compose_variables=$(docker compose config --variables 2>/dev/null) || die "cannot determine Compose interpolation variables; grant direct Docker access or use a Compose version supporting config --variables."
  declare -A exported_names=()
  while IFS= read -r name; do exported_names["$name"]=1; done < <(compgen -e)
  while IFS= read -r line; do
    name=${line%%=*}
    [[ "$name" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ && ${exported_names[$name]+yes} ]] || continue
    case "$name" in
      PATH|IFS|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|LD_*|DYLD_*|PYTHONPATH|PYTHONHOME|NODE_OPTIONS|PERL5OPT|RUBYOPT) continue ;;
    esac
    compose_extra_names+=("$name")
  done <<<"$compose_variables"
  unset compose_variables exported_names
fi
docker_cmd compose config --quiet || die "invalid or missing Docker Compose configuration."
services=$(docker_cmd compose config --services) || die "cannot list Compose services."
grep -Fxq herdsman <<<"$services" || die "Compose configuration does not contain the herdsman service."
container_ids=$(docker_cmd compose ps --all --quiet) || die "could not inspect existing Compose project containers."
while IFS= read -r container_id; do
  [[ -n "$container_id" ]] || continue
  working_dir=$(docker_cmd inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container_id") || die "could not inspect container $container_id."
  [[ -n "$working_dir" && "$working_dir" != '<no value>' ]] || die "container $container_id has no working-directory label; refusing takeover of $project_dir."
  if [[ -d "$working_dir" ]]; then working_dir=$(cd -- "$working_dir" && pwd -P); fi
  [[ "$working_dir" == "$project_dir" ]] || die "Compose project belongs to $working_dir, not $project_dir; refusing takeover."
done <<<"$container_ids"

if (( fresh_install )) && [[ "${choice:-}" == 3 ]]; then
  [[ $(uname -s) == Linux ]] || die "fresh bind-mounted home setup is supported only on Linux."
  home_dir="$project_dir/data/herdsman-home"
  if [[ ! -e "$home_dir" && ! -L "$home_dir" ]]; then
    [[ ! -L "$project_dir/data" ]] || die "bind home parent must not be a symlink."
    mkdir -p -- "$project_dir/data" || die "cannot prepare bind home parent."
    mkdir -- "$home_dir" || die "cannot create bind home."
    chown 1000:1000 -- "$home_dir" || die "cannot set ownership of newly created $home_dir to 1000:1000."
  fi
  [[ -d "$home_dir" && ! -L "$home_dir" ]] || die "bind home $home_dir must be a real directory."
  bind_uid=$(stat -c '%u' "$home_dir"); bind_gid=$(stat -c '%g' "$home_dir"); bind_mode=$(stat -c '%a' "$home_dir")
  [[ "$bind_uid:$bind_gid" == 1000:1000 ]] || die "bind home $home_dir must be owned by 1000:1000; inspect its ownership before continuing."
  (( (8#$bind_mode & 022) == 0 && (8#$bind_mode & 0300) == 0300 )) || die "bind home $home_dir must be owner-writable and not group/other writable."
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

keys=()
add_key_lines() {
  local line
  while IFS= read -r line || [[ -n "$line" ]]; do
    line=${line%$'\r'}
    [[ -z "${line//[[:space:]]/}" ]] || keys+=("$line")
  done <<<"$1"
}
resolved_keys=${SSH_AUTHORIZED_KEYS:-}
[[ -z "$resolved_keys" ]] || add_key_lines "$resolved_keys"

if ( : </dev/tty ) 2>/dev/null; then
  for candidate in "$HOME/.ssh/id_ed25519.pub" "$HOME/.ssh/id_rsa.pub"; do
    if [[ -f "$candidate" && -r "$candidate" ]]; then
      printf 'Authorize public key %s to connect to Herdsman? [y/N] ' "$candidate" >/dev/tty
      answer=
      IFS= read -r answer </dev/tty || true
      if [[ "$answer" =~ ^([yY]|[yY][eE][sS])$ ]]; then
        add_key_lines "$(<"$candidate")"
      fi
    fi
  done
  while :; do
    printf 'Additional public key or path to .pub file (Enter to finish): ' >/dev/tty
    input_key=
    IFS= read -r input_key </dev/tty || break
    [[ -n "$input_key" ]] || break
    if [[ -f "$input_key" && -r "$input_key" ]]; then
      add_key_lines "$(<"$input_key")"
    else
      add_key_lines "$input_key"
    fi
  done
fi
normalized_keys=()
for key in "${keys[@]}"; do
  validate_ssh_public_key "$key" || die "SSH_AUTHORIZED_KEYS or selected key is not a structurally valid OpenSSH public key."
  read -r algorithm material _ <<<"$key"
  normalized_keys+=("$algorithm $material")
done

tailscale_enabled=0
partial_tailscale=0
if grep -Fxq tailscale <<<"$services"; then
  if [[ -z "$container_ids" ]]; then
    tailscale_enabled=1
  else
    herdsman_ids=$(docker_cmd compose ps --all --quiet herdsman) || die "could not inspect existing Herdsman containers."
    sidecar_ids=$(docker_cmd compose ps --all --quiet tailscale) || die "could not inspect existing Tailscale containers."
    while IFS= read -r sidecar_id; do
      [[ -n "$sidecar_id" ]] || continue
      if ! credential=$(sidecar_credential "$sidecar_id"); then
        if docker_cmd stop "$sidecar_id" >/dev/null; then
          die "could not inspect Tailscale bootstrap credential state; stopped container $sidecar_id. Inspect it and recover manually."
        else
          die "CRITICAL: could not inspect Tailscale bootstrap credential state or stop container $sidecar_id; stop it immediately and inspect it manually."
        fi
      fi
      if [[ -n "$credential" ]]; then
        if docker_cmd stop "$sidecar_id" >/dev/null; then
          die "Tailscale container $sidecar_id contained a bootstrap credential and was stopped; recreate it without TS_AUTHKEY and restore the Herdsman network namespace manually."
        else
          die "CRITICAL: Tailscale container $sidecar_id contains a bootstrap credential and could not be stopped; stop it immediately, recreate it without TS_AUTHKEY, and restore the Herdsman network namespace manually."
        fi
      fi
    done <<<"$sidecar_ids"
    # Only recover a sidecar-only project; never create over an existing deployment.
    if [[ -z "$herdsman_ids" && -n "$sidecar_ids" && "$sidecar_ids" != *$'\n'* && "$container_ids" == "$sidecar_ids" ]]; then
      partial_tailscale=1
      tailscale_enabled=1
    fi
  fi
fi

# Pass public keys only on stdin, and preserve existing restricted entries.
authorization_script='
set -eu
umask 077
home=/home/herdsman
sshdir="$home/.ssh"
auth="$sshdir/authorized_keys"
keys=$(cat)
[ -n "$keys" ] || keys=${SSH_AUTHORIZED_KEYS:-}
# ssh-keygen can reject material that passes the host structural check.
# Validate the complete batch before touching the persistent home.
printf "%s\\n" "$keys" | while IFS= read -r key; do
  [ -n "$key" ] || continue
  printf "%s\\n" "$key" | grep -Eq "^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh.com|sk-ecdsa-sha2-nistp256@openssh.com) [A-Za-z0-9+/]+={0,2}([[:space:]].*)?$" || exit 1
  fingerprint=$(printf "%s\\n" "$key" | ssh-keygen -lf - | awk "NR == 1 {print \$2}")
  [ -n "$fingerprint" ] || exit 1
done
[ -w "$home" ] || exit 1
[ ! -L "$sshdir" ] && { [ ! -e "$sshdir" ] || [ -d "$sshdir" ]; } || exit 1
[ -d "$sshdir" ] || mkdir -m 700 "$sshdir"
chmod 700 "$sshdir"
[ ! -L "$auth" ] && { [ ! -e "$auth" ] || [ -f "$auth" ]; } || exit 1
[ -e "$auth" ] || : >"$auth"
chmod 600 "$auth"
printf "%s\\n" "$keys" | while IFS= read -r key; do
  [ -n "$key" ] || continue
  fingerprint=$(printf "%s\\n" "$key" | ssh-keygen -lf - | awk "NR == 1 {print \$2}")
  [ -n "$fingerprint" ] || exit 1
  if ! ssh-keygen -lf "$auth" 2>/dev/null | awk -v f="$fingerprint" '\''$2 == f {found=1} END {exit !found}'\''; then
    [ ! -s "$auth" ] || [ "$(tail -c 1 "$auth" | wc -l)" -ne 0 ] || printf "\\n" >>"$auth"
    printf "%s\\n" "$key" >>"$auth"
  fi
done
ssh-keygen -lf "$auth" >/dev/null 2>&1
'
running_herdsman=$(docker_cmd compose ps --quiet herdsman) || die "could not inspect Herdsman state."
if (( partial_tailscale )); then
  ( : </dev/tty ) 2>/dev/null || die "only a Tailscale sidecar exists; interactive confirmation is required to complete the deployment."
  printf 'Only a Tailscale sidecar exists. Complete setup (authentication may recreate the sidecar)? [y/N] ' >/dev/tty
  IFS= read -r answer </dev/tty || answer=
  [[ "$answer" =~ ^([yY]|[yY][eE][sS])$ ]] || { printf 'Deployment left unchanged.\n'; exit 0; }
  docker_cmd compose start tailscale || die "could not start the existing Tailscale sidecar."
elif [[ -n "$container_ids" && -z "$running_herdsman" ]]; then
  if ( : </dev/tty ) 2>/dev/null; then
    printf 'Start existing containers without recreating them? [y/N] ' >/dev/tty
    IFS= read -r answer </dev/tty || answer=
    if [[ "$answer" =~ ^([yY]|[yY][eE][sS])$ ]]; then
      docker_cmd compose start || die "could not start existing containers."
      running_herdsman=$(docker_cmd compose ps --quiet herdsman) || die "could not inspect Herdsman state."
    fi
  fi
  [[ -n "$running_herdsman" ]] || { printf 'Existing containers left unchanged.\n'; exit 0; }
elif [[ -z "$container_ids" ]] && (( ! fresh_install )); then
  ( : </dev/tty ) 2>/dev/null || die "existing configuration has no containers; interactive confirmation required before initial startup."
  printf 'Existing configuration has no containers. Start a new deployment? [y/N] ' >/dev/tty
  IFS= read -r answer </dev/tty || answer=
  [[ "$answer" =~ ^([yY]|[yY][eE][sS])$ ]] || { printf 'Deployment left unchanged.\n'; exit 0; }
fi

# Existing deployments are never re-registered automatically. A running SSH
# listener alone does not mean the Tailscale device is registered.
if [[ -n "$running_herdsman" ]] && (( ! tailscale_enabled )) && grep -Fxq tailscale <<<"$services"; then
  authenticated=0
  for _ in {1..10}; do
    if docker_cmd compose exec -T tailscale tailscale status --json 2>/dev/null | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then authenticated=1; break; fi
    sleep 2
  done
  (( authenticated )) || die "existing Tailscale deployment is not registered or its status is unavailable; inspect with 'docker compose exec tailscale tailscale status' and recover explicitly with Docker/Tailscale before rerunning."
fi

if [[ -n "$running_herdsman" ]]; then
  if (( ${#normalized_keys[@]} )); then
    printf '%s\n' "${normalized_keys[@]}" | docker_cmd compose exec -T -u herdsman herdsman sh -c "$authorization_script" || die "could not safely update authorized_keys."
  fi
else
  if (( tailscale_enabled )); then
    docker_cmd compose up -d --no-recreate tailscale || die "could not start Tailscale sidecar."
  fi
  # Resolve IDs inside the one-off container, never on the host or in .env.
  switch_script='set -eu
uid=${PUID:-1000}; gid=${PGID:-1000}
case "$uid" in ""|0*|*[!0-9]*) exit 1 ;; esac
case "$gid" in ""|0*|*[!0-9]*) exit 1 ;; esac
exec setpriv --reuid "$uid" --regid "$gid" --clear-groups sh -c "$1"'
  printf '%s\n' "${normalized_keys[@]}" | docker_cmd compose run --rm --no-deps -T --user 0:0 --entrypoint sh herdsman -c "$switch_script" sh "$authorization_script" || die "could not safely update authorized_keys, or no authorized keys exist."
  if (( partial_tailscale )); then
    docker_cmd compose up -d --no-recreate || die "Docker Compose could not start the deployment without recreating existing containers."
  else
    docker_cmd compose up -d || die "Docker Compose could not start the deployment."
  fi
fi
printf 'SSH authorization checked in the persistent home.\n'

if (( tailscale_enabled )); then
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
    export TS_AUTHKEY="$ts_authkey"
    ts_bootstrap_active=1
    docker_cmd compose up -d --force-recreate tailscale || bootstrap_status=$?
    unset TS_AUTHKEY
    if [[ "${bootstrap_status:-0}" != 0 ]]; then
      unset ts_authkey bootstrap_ts_authkey
      die "Tailscale bootstrap failed; restoring the key-free sidecar and Herdsman namespace."
    fi
    unset ts_authkey bootstrap_ts_authkey
    authenticated=0
    for _ in {1..30}; do
      if docker_cmd compose exec -T tailscale tailscale status --json 2>/dev/null | grep -Eq '"BackendState"[[:space:]]*:[[:space:]]*"Running"'; then authenticated=1; break; fi
      sleep 2
    done
    cleanup_status=0
    docker_cmd compose up -d --force-recreate tailscale || cleanup_status=$?
    if (( cleanup_status == 0 )) && ! sidecar_key_free; then cleanup_status=1; fi
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
if grep -Fxq tailscale <<<"$services"; then
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
printf 'Container outgoing SSH public key: docker compose exec herdsman cat /home/herdsman/.ssh/id_ed25519.pub\n'
