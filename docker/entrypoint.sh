#!/bin/sh
set -eu

home=/home/herdsman
host_keys=/var/lib/herdsman/ssh
authorized_keys="$home/.ssh/authorized_keys"

current_uid="$(id -u herdsman)"
current_gid="$(id -g herdsman)"
puid="${PUID:-$current_uid}"
pgid="${PGID:-$current_gid}"

validate_id() {
  name="$1"
  value="$2"

  case "$value" in
    ''|0*|*[!0-9]*)
      echo "$name must be a positive decimal integer" >&2
      exit 1
      ;;
  esac
}

validate_id PUID "$puid"
validate_id PGID "$pgid"

if [ "$pgid" != "$current_gid" ]; then
  if group="$(getent group "$pgid")"; then
    echo "PGID $pgid is already used by group ${group%%:*}" >&2
    exit 1
  fi

  groupmod -g "$pgid" herdsman
fi

if [ "$puid" != "$current_uid" ]; then
  if user="$(getent passwd "$puid")"; then
    echo "PUID $puid is already used by user ${user%%:*}" >&2
    exit 1
  fi

  # ponytail: remap account metadata only; mounted home ownership stays host-managed.
  usermod -d /nonexistent herdsman
  usermod -u "$puid" herdsman
  usermod -d "$home" herdsman
fi

home_uid="$(stat -c %u "$home")"
home_mode="$(stat -c %a "$home")"

# Match OpenSSH StrictModes for the home before starting sshd.
if { [ "$home_uid" -ne 0 ] && [ "$home_uid" -ne "$puid" ]; } ||
  [ $((0$home_mode & 022)) -ne 0 ]; then
  echo "$home must be owned by root or UID $puid and not writable by group or others for SSH public-key authentication (found UID $home_uid, mode $home_mode)" >&2
  exit 1
fi

if ! runuser -u herdsman -- test -w "$home"; then
  echo "$home must be writable by herdsman (UID $(id -u herdsman), GID $(id -g herdsman))" >&2
  exit 1
fi

install -d -m 0700 "$host_keys"

if [ ! -s "$host_keys/ssh_host_ed25519_key" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$host_keys/ssh_host_ed25519_key"
fi

runuser -u herdsman -- install -d -m 0700 "$home/.ssh"

if ! runuser -u herdsman -- test -s "$authorized_keys"; then
  if [ -z "${SSH_AUTHORIZED_KEYS:-}" ]; then
    echo "SSH_AUTHORIZED_KEYS is required on first start" >&2
    exit 1
  fi

  printf '%s\n' "$SSH_AUTHORIZED_KEYS" |
    runuser -u herdsman -- sh -c 'umask 077; cat > "$1"' sh "$authorized_keys"
fi

runuser -u herdsman -- chmod 0600 "$authorized_keys"

runuser -u herdsman -- \
  env HOME="$home" USER=herdsman LOGNAME=herdsman \
  /usr/local/bin/pi install /opt/pi-herdsman

runuser -u herdsman -- \
  env HOME="$home" USER=herdsman LOGNAME=herdsman \
  /usr/local/bin/herdr integration install pi

/usr/sbin/sshd -t -f /etc/ssh/sshd_config

exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
