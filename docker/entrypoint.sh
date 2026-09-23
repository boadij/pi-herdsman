#!/bin/sh
set -eu

home=/home/herdsman
host_keys=/var/lib/herdsman/ssh
authorized_keys="$home/.ssh/authorized_keys"

if ! runuser -u herdsman -- test -w "$home"; then
  echo "$home must be writable by UID 1000" >&2
  exit 1
fi

install -d -m 0700 "$host_keys"

if [ ! -s "$host_keys/ssh_host_ed25519_key" ]; then
  ssh-keygen -q -t ed25519 -N '' -f "$host_keys/ssh_host_ed25519_key"
fi

install -d -m 0700 -o herdsman -g herdsman "$home/.ssh"

if [ ! -s "$authorized_keys" ]; then
  if [ -z "${SSH_AUTHORIZED_KEYS:-}" ]; then
    echo "SSH_AUTHORIZED_KEYS is required on first start" >&2
    exit 1
  fi

  printf '%s\n' "$SSH_AUTHORIZED_KEYS" > "$authorized_keys"
fi

chown herdsman:herdsman "$authorized_keys"
chmod 0600 "$authorized_keys"

runuser -u herdsman -- \
  env HOME="$home" USER=herdsman LOGNAME=herdsman \
  /usr/local/bin/pi install /opt/pi-herdsman

runuser -u herdsman -- \
  env HOME="$home" USER=herdsman LOGNAME=herdsman \
  /usr/local/bin/herdr integration install pi

/usr/sbin/sshd -t -f /etc/ssh/sshd_config

exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
