#!/usr/bin/env bash
set -Eeuo pipefail

die() { printf 'docker-setup: %s\n' "$*" >&2; exit 1; }
tmp_files=()
compose_extra_names=()
cleanup() {
  if [[ "${sidecar_reattach_pending:-0}" == 1 ]]; then
    if [[ "${sidecar_reattach_started:-0}" == 1 ]]; then
      printf 'docker-setup: WARNING: Herdsman reattachment was interrupted or failed; inspect its namespace and sidecar %s.\n' "${sidecar_array[0]}" >&2
    elif [[ $(docker_cmd inspect --format '{{.State.Running}}' "${sidecar_array[0]}" 2>/dev/null) == true ]]; then
      docker_cmd compose up -d --no-deps --force-recreate herdsman || printf 'docker-setup: WARNING: failed to reattach Herdsman to sidecar %s.\n' "${sidecar_array[0]}" >&2
    else
      printf 'docker-setup: WARNING: inspect sidecar %s and the Herdsman network namespace before retrying.\n' "${sidecar_array[0]}" >&2
    fi
  fi
  if [[ "${ts_bootstrap_active:-0}" == 1 ]]; then
    unset TS_AUTHKEY ts_authkey bootstrap_ts_authkey
    if ! docker_cmd compose up -d --force-recreate tailscale; then
      printf 'docker-setup: WARNING: failed to restore key-free Tailscale configuration.\n' >&2
    else
      ts_bootstrap_active=0
      docker_cmd compose up -d --force-recreate herdsman || printf 'docker-setup: WARNING: failed to recreate Herdsman in the restored Tailscale network namespace.\n' >&2
    fi
  fi
  (("${#tmp_files[@]}" == 0)) || rm -f -- "${tmp_files[@]}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

project_dir="${PI_HERDSMAN_DIR:-$PWD}"
mkdir -p -- "$project_dir" || die "cannot create deployment directory: $project_dir"
cd -- "$project_dir" || die "cannot enter deployment directory: $project_dir"
project_dir="$(pwd -P)"

command -v jq >/dev/null || die "jq is required to inspect the resolved Docker Compose configuration."
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
    printf '\nCOMPOSE_FILE=%s\n' "$selection" >>"$env_file"
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
resolve_compose_model() {
  local elevated direct
  elevated=$(docker_cmd compose config --format json) || return 1
  if (( use_sudo )); then
    direct=$(docker compose config --format json) || return 1
    [[ $(jq -cS . <<<"$direct") == "$(jq -cS . <<<"$elevated")" ]] || {
      printf 'docker-setup: sudo changes the resolved Compose configuration; grant direct Docker access or allow the required interpolation environment.\n' >&2
      return 1
    }
  fi
  printf '%s' "$elevated"
}

# Inspect the effective model before starting or recreating any container.
compose_model=$(resolve_compose_model) || die "could not resolve Docker Compose configuration safely."
project_name=$(jq -er '.name | select(type == "string" and length > 0)' <<<"$compose_model") || die "Compose did not resolve a project name."
home_mount=$(jq -ce '[.services.herdsman.volumes[]? | select(.target == "/home/herdsman")] | if length == 1 then .[0] else error("expected exactly one Herdsman home mount") end' <<<"$compose_model") || die "expected a Herdsman service with exactly one /home/herdsman mount."
mount_type=$(jq -r '.type // ""' <<<"$home_mount")
mount_source=$(jq -r '.source // ""' <<<"$home_mount")
[[ "$mount_type" == bind || "$mount_type" == volume ]] && [[ -n "$mount_source" ]] || die "unsupported or missing Herdsman home mount source."
if [[ "$mount_type" == volume ]]; then
  mount_source=$(jq -r --arg source "$mount_source" '.volumes[$source].name // $source' <<<"$compose_model")
fi
configured_uid=$(jq -r '.services.herdsman.environment.PUID // ""' <<<"$compose_model")
configured_gid=$(jq -r '.services.herdsman.environment.PGID // ""' <<<"$compose_model")
for id_name in configured_uid configured_gid; do
  id_value=${!id_name}
  [[ -z "$id_value" || "$id_value" =~ ^[1-9][0-9]*$ ]] || die "${id_name#configured_} must be a positive decimal integer; use a non-zero PUID and PGID."
done

container_ids=$(docker_cmd ps -aq --filter "label=com.docker.compose.project=$project_name") || die "could not inspect existing Compose project containers."
if [[ -n "$container_ids" ]]; then
  # IDs are produced by Docker, not configuration input.
  read -r -a container_id_array <<<"${container_ids//$'\n'/ }"
  containers=$(docker_cmd inspect "${container_id_array[@]}") || die "could not inspect existing Compose project containers."
  jq -e 'type == "array" and length > 0' <<<"$containers" >/dev/null || die "invalid container inspection result."
  while IFS= read -r container; do
    working_dir=$(jq -r '.Config.Labels["com.docker.compose.project.working_dir"] // ""' <<<"$container")
    [[ -n "$working_dir" ]] || die "project $project_name has a container with no working-directory label; refusing takeover of $project_dir."
    if [[ -d "$working_dir" ]]; then
      working_dir=$(cd -- "$working_dir" && pwd -P) || die "cannot resolve existing project directory."
    fi
    [[ "$working_dir" == "$project_dir" ]] || die "Compose project $project_name belongs to $working_dir, not $project_dir; refusing takeover."
    service=$(jq -r '.Config.Labels["com.docker.compose.service"] // ""' <<<"$container")
    if [[ "$service" == herdsman ]]; then
      existing_home=$(jq -ce '[.Mounts[]? | select(.Destination == "/home/herdsman")] | if length == 1 then .[0] else error("expected one home mount") end' <<<"$container") || die "existing Herdsman container has an ambiguous home mount."
      existing_type=$(jq -r '.Type // ""' <<<"$existing_home")
      existing_source=$(jq -r 'if .Type == "volume" then .Name else .Source end // ""' <<<"$existing_home")
      [[ "$existing_type" == "$mount_type" && "$existing_source" == "$mount_source" ]] || die "existing Herdsman home mount $existing_type:$existing_source differs from configured $mount_type:$mount_source; refusing migration."
    fi
  done < <(jq -c '.[]' <<<"$containers")
fi

effective_uid=${configured_uid:-1000}
effective_gid=${configured_gid:-1000}
derived_uid= derived_gid=
if [[ "$mount_type" == bind ]]; then
  [[ "$(uname -s)" == Linux ]] || die "bind-mounted home preflight is supported only on Linux."
  home_dir=$mount_source
  [[ "$home_dir" == /* ]] || die "Compose did not resolve an absolute bind-mounted home path."
  if [[ ! -e "$home_dir" && ! -L "$home_dir" ]]; then
    mkdir -p -- "$(dirname -- "$home_dir")" || die "cannot prepare parent of $home_dir."
    mkdir -- "$home_dir" || die "cannot create bind-mounted home: $home_dir."
    chown "$effective_uid:$effective_gid" -- "$home_dir" || die "cannot set ownership of newly created $home_dir to $effective_uid:$effective_gid; arrange that ownership and rerun."
  fi
  [[ -d "$home_dir" && ! -L "$home_dir" ]] || die "bind-mounted home $home_dir is not a directory or is a symlink."
  bind_uid=$(stat -c '%u' "$home_dir") || die "cannot inspect $home_dir."
  bind_gid=$(stat -c '%g' "$home_dir") || die "cannot inspect $home_dir."
  bind_mode=$(stat -c '%a' "$home_dir") || die "cannot inspect $home_dir."
  # An existing nonstandard home can supply missing IDs, but only if Compose
  # actually propagates the proposed values into the service environment.
  if [[ -z "$configured_uid" && "$bind_uid" =~ ^[1-9][0-9]*$ && "$bind_uid" != 1000 ]]; then
    derived_uid=$bind_uid
    effective_uid=$bind_uid
    export PUID=$bind_uid
  fi
  if [[ -n "$derived_uid" && -z "$configured_gid" && "$bind_gid" =~ ^[1-9][0-9]*$ ]]; then
    derived_gid=$bind_gid
    effective_gid=$bind_gid
    export PGID=$bind_gid
  fi
  [[ "$bind_uid" == "$effective_uid" ]] || die "bind-mounted home $home_dir is owned by UID $bind_uid, but effective PUID is $effective_uid; preserve the data and configure a compatible non-zero PUID."
  (( (8#$bind_mode & 022) == 0 && (8#$bind_mode & 0300) == 0300 )) || die "bind-mounted home $home_dir must be writable and searchable by its owner and not group/other writable."
  if [[ -n "$derived_uid$derived_gid" ]]; then
    derived_model=$(resolve_compose_model) || die "could not resolve derived home IDs."
    [[ $(jq -c '{name, home: [.services.herdsman.volumes[]? | select(.target == "/home/herdsman")], volumes}' <<<"$compose_model") == "$(jq -c '{name, home: [.services.herdsman.volumes[]? | select(.target == "/home/herdsman")], volumes}' <<<"$derived_model")" ]] || die "derived IDs changed the Compose project or home mount; configure the IDs explicitly."
    [[ -z "$derived_uid" || $(jq -r '.services.herdsman.environment.PUID // ""' <<<"$derived_model") == "$derived_uid" ]] || die "Compose does not apply the derived PUID; configure it explicitly."
    [[ -z "$derived_gid" || $(jq -r '.services.herdsman.environment.PGID // ""' <<<"$derived_model") == "$derived_gid" ]] || die "Compose does not apply the derived PGID; configure it explicitly."
    compose_model=$derived_model
  fi
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
resolved_keys=$(jq -r '.services.herdsman.environment.SSH_AUTHORIZED_KEYS // ""' <<<"$compose_model")
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

# The entrypoint refuses IDs already assigned to other image accounts.
account_script='
set -eu
uid=$1 gid=$2
current_uid=$(id -u herdsman)
current_gid=$(id -g herdsman)
if [ "$uid" != "$current_uid" ]; then
  if getent passwd "$uid" >/dev/null; then exit 1; else status=$?; [ "$status" -eq 2 ] || exit 1; fi
fi
if [ "$gid" != "$current_gid" ]; then
  if getent group "$gid" >/dev/null; then exit 1; else status=$?; [ "$status" -eq 2 ] || exit 1; fi
fi
while IFS= read -r key; do
  [ -n "$key" ] || continue
  fingerprint=$(printf "%s\\n" "$key" | ssh-keygen -lf - | awk "NR == 1 {print \$2}")
  [ -n "$fingerprint" ] || exit 1
done
'
account_image=$(jq -er '.services.herdsman.image | select(type == "string" and length > 0)' <<<"$compose_model") || die "cannot check image accounts without a resolved Herdsman image."
account_platform=$(jq -r '.services.herdsman.platform // ""' <<<"$compose_model")
platform_args=()
[[ -z "$account_platform" ]] || platform_args=(--platform "$account_platform")
printf '%s\n' "${normalized_keys[@]}" | docker_cmd run --rm -i --network none --user 0:0 "${platform_args[@]}" --entrypoint sh "$account_image" -c "$account_script" sh "$effective_uid" "$effective_gid" || die "image account or public-key preflight failed; verify the effective PUID, PGID, and selected keys."

tailscale_enabled=0
sidecar_restarted=0
if jq -e '.services.herdsman.network_mode == "service:tailscale"' <<<"$compose_model" >/dev/null; then
  tailscale_enabled=1
  sidecar_ids=$(docker_cmd compose ps --all -q tailscale) || die "could not inspect Tailscale sidecar."
  if [[ -n "$sidecar_ids" ]]; then
    read -r -a sidecar_array <<<"${sidecar_ids//$'\n'/ }"
    (( ${#sidecar_array[@]} == 1 )) || die "multiple Tailscale sidecars found; refusing to change their network namespace."
    sidecar_running=$(docker_cmd inspect --format '{{.State.Running}}' "${sidecar_array[0]}") || die "could not inspect Tailscale sidecar state."
    if [[ "$sidecar_running" == false ]]; then
      running_herdsman=$(docker_cmd compose ps -q herdsman) || die "could not inspect the running Herdsman container."
      if [[ -n "$running_herdsman" ]]; then sidecar_reattach_pending=1; fi
      docker_cmd start "${sidecar_array[0]}" >/dev/null || die "could not start existing Tailscale sidecar ${sidecar_array[0]}; inspect its state and Herdsman network namespace."
      sidecar_restarted=1
      if [[ -n "$running_herdsman" ]]; then
        sidecar_reattach_started=1
        docker_cmd compose up -d --no-deps --force-recreate herdsman || die "Tailscale sidecar restarted but Herdsman could not be reattached; inspect sidecar ${sidecar_array[0]} and the Herdsman network namespace."
        sidecar_reattach_pending=0
        sidecar_restarted=0
      fi
    elif [[ "$sidecar_running" != true ]]; then
      die "unexpected Tailscale sidecar state; refusing to change its namespace."
    fi
  else
    docker_cmd compose up -d --no-recreate tailscale || die "could not start the Tailscale network namespace."
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
# ssh-keygen can reject material that passes the host structural check.
# Validate the complete batch before touching the persistent home.
printf "%s\\n" "$keys" | while IFS= read -r key; do
  [ -n "$key" ] || continue
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
printf '%s\n' "${normalized_keys[@]}" | docker_cmd compose run --rm --no-deps -T --user "$effective_uid:$effective_gid" --entrypoint sh herdsman -c "$authorization_script" || die "could not safely update authorized_keys, or no authorized keys exist."
printf 'SSH authorization checked in the persistent home.\n'
# Persist inferred IDs only after image, key, and persistent-home validation.
if [[ -n "$derived_uid$derived_gid" ]]; then
  umask 077
  [[ -z "$derived_uid" ]] || printf '\nPUID=%s\n' "$derived_uid" >>"$env_file"
  [[ -z "$derived_gid" ]] || printf '\nPGID=%s\n' "$derived_gid" >>"$env_file"
fi
if (( tailscale_enabled )); then
  # The namespace owner was deliberately reused above. Do not let an ordinary
  # deployment update recreate it implicitly before Herdsman is reattached.
  if (( sidecar_restarted )); then
    docker_cmd compose up -d --no-deps --force-recreate herdsman || die "Tailscale sidecar restarted but Herdsman could not be reattached; inspect their network namespaces."
  else
    docker_cmd compose up -d --no-deps herdsman || die "Docker Compose could not start Herdsman."
  fi
else
  docker_cmd compose up -d || die "Docker Compose could not start the deployment; sudo may deny preserving requested environment names."
fi

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
    bootstrap_model=$(resolve_compose_model 2>/dev/null) || {
      unset TS_AUTHKEY ts_authkey bootstrap_ts_authkey
      die "could not safely resolve the temporary Tailscale bootstrap configuration."
    }
    if [[ $(jq -cS 'del(.services.tailscale.environment.TS_AUTHKEY)' <<<"$compose_model") != "$(jq -cS 'del(.services.tailscale.environment.TS_AUTHKEY)' <<<"$bootstrap_model")" ]]; then
      unset TS_AUTHKEY ts_authkey bootstrap_ts_authkey bootstrap_model
      die "TS_AUTHKEY changes Compose configuration outside the Tailscale bootstrap setting; refusing recreation."
    fi
    unset bootstrap_model
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
if (( tailscale_enabled )); then
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
