#!/usr/bin/env bash
set -euo pipefail

image=pi-herdsman:smoke
name="pi-herdsman-smoke-$$"
home="${name}-home"
ssh_state="${name}-ssh"
custom_volume="${name}-identity-home"
tmp="$(mktemp -d)"
port=

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$home" "$ssh_state" >/dev/null 2>&1 || true
  if [ -n "${custom_volume:-}" ]; then
    docker volume rm "$custom_volume" >/dev/null 2>&1 || true
  fi
  if [ -d "$tmp/custom-home" ] && docker image inspect "$image" >/dev/null 2>&1; then
    docker run --rm \
      --entrypoint /bin/sh \
      -v "$tmp:/cleanup" \
      "$image" \
      -c 'rm -rf /cleanup/custom-home' >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N '' -f "$tmp/id"

docker build --platform linux/amd64 -t "$image" .

default_ids="$(
  docker run --rm --entrypoint /bin/sh "$image" \
    -c 'printf "%s:%s" "$(id -u herdsman)" "$(id -g herdsman)"'
)"

if docker run --rm \
  -e PUID=0 \
  "$image" >"$tmp/invalid-id.log" 2>&1; then
  echo "PUID=0 unexpectedly succeeded" >&2
  exit 1
fi
grep -q 'PUID must be a positive decimal integer' "$tmp/invalid-id.log"

expected_pi="$(node -p 'require("./package-lock.json").packages["node_modules/@earendil-works/pi-coding-agent"].version')"

start() {
  docker run -d \
    --name "$name" \
    -p 127.0.0.1::22 \
    -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
    -v "$home:/home/herdsman" \
    -v "$ssh_state:/var/lib/herdsman/ssh" \
    "$image" >/dev/null

  port="$(docker port "$name" 22/tcp | sed 's/.*://')"
  for _ in $(seq 1 60); do
    if ssh -F /dev/null -i "$tmp/id" -p "$port" \
      -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null herdsman@127.0.0.1 true 2>/dev/null; then
      return
    fi
    sleep 1
  done
  docker logs "$name"
  echo "SSH did not become ready" >&2
  return 1
}

remote() {
  ssh -F /dev/null -i "$tmp/id" -p "$port" \
    -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null herdsman@127.0.0.1 "$@"
}

verify_runtime() {
  remote "test \"\$(pi --version)\" = '$expected_pi'; \
    test \"\$(readlink -f \"\$(command -v pi)\")\" = /opt/pi/pi; \
    ! npm list -g --depth=0 2>/dev/null | grep -q '@earendil-works/pi-coding-agent'; \
    command -v node >/dev/null; node --version | grep -q '^v26\\.'; \
    command -v herdr >/dev/null; herdr --version >/dev/null; \
    command -v mise >/dev/null; mise --version >/dev/null; \
    command -v rg >/dev/null; command -v fd >/dev/null; \
    command -v jq >/dev/null; command -v gh >/dev/null; \
    command -v python3 >/dev/null; command -v git >/dev/null; \
    test -r /AGENTS.md; \
    grep -q '^# Pi Herdsman container environment$' /AGENTS.md; \
    grep -q '/opt/pi-herdsman' ~/.pi/agent/settings.json; \
    test -f ~/.pi/agent/extensions/herdr-agent-state.ts; \
    pi --offline --help >/tmp/pi-help 2>&1; \
    ! grep -q 'Failed to load extension' /tmp/pi-help"
}

docker run -d \
  --name "$name" \
  -v "$home:/home/herdsman" \
  -v "$ssh_state:/var/lib/herdsman/ssh" \
  "$image" >/dev/null
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Status}}' "$name")" = exited ] && break
  sleep 1
done
test "$(docker inspect -f '{{.State.ExitCode}}' "$name")" -ne 0
docker logs "$name" 2>&1 | grep -q 'SSH_AUTHORIZED_KEYS is required on first start'
docker rm "$name" >/dev/null

if [ "$(uname -s)" = Darwin ]; then
  # Docker Desktop translates host bind-mount IDs; use a Linux volume for numeric ownership checks.
  docker volume create "$custom_volume" >/dev/null
  custom_home="$custom_volume"
else
  custom_home="$tmp/custom-home"
  mkdir "$custom_home"
fi
docker run --rm \
  --entrypoint /bin/sh \
  -v "$custom_home:/mnt" \
  "$image" \
  -c "chown 12345:23456 /mnt
      chmod 0775 /mnt
      : > /mnt/preserved-owner
      chown $default_ids /mnt/preserved-owner"

if docker run --rm \
  -e PUID=12345 \
  -e PGID=23456 \
  -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
  -v "$custom_home:/home/herdsman" \
  "$image" >"$tmp/unsafe-home.log" 2>&1; then
  echo "group-writable home unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq \
  '/home/herdsman must be owned by root or UID 12345 and not writable by group or others for SSH public-key authentication (found UID 12345, mode 775)' \
  "$tmp/unsafe-home.log"

docker run --rm \
  --entrypoint chmod \
  -v "$custom_home:/mnt" \
  "$image" \
  go-w /mnt

docker run -d \
  --name "$name" \
  -p 127.0.0.1::22 \
  -e PUID=12345 \
  -e PGID=23456 \
  -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
  -v "$custom_home:/home/herdsman" \
  "$image" >/dev/null
port="$(docker port "$name" 22/tcp | sed 's/.*://')"
for _ in $(seq 1 30); do
  if remote true >/dev/null 2>&1; then
    break
  fi

  if [ "$(docker inspect -f '{{.State.Status}}' "$name")" = exited ]; then
    docker logs "$name"
    echo "custom UID/GID container exited during startup" >&2
    exit 1
  fi

  sleep 1
done
remote true
test "$(docker exec "$name" id -u herdsman)" = 12345
test "$(docker exec "$name" id -g herdsman)" = 23456
docker exec "$name" \
  runuser -u herdsman -- \
  touch /home/herdsman/custom-owner
test "$(docker run --rm --entrypoint stat -v "$custom_home:/mnt:ro" "$image" -c '%u:%g' /mnt/custom-owner)" = '12345:23456'
test "$(docker run --rm --entrypoint stat -v "$custom_home:/mnt:ro" "$image" -c '%u:%g' /mnt/preserved-owner)" = "$default_ids"
docker rm -f "$name" >/dev/null

start
verify_runtime

printf '%s\n' \
  '#!/bin/sh' \
  'printf "%s:%s:%s\n" "$(id -un)" "$HOME" "$PWD" >> /tmp/herdr-autostart' |
  remote 'mkdir -p ~/.local/bin; cat > ~/.local/bin/herdr; chmod +x ~/.local/bin/herdr'

docker exec "$name" rm -f /tmp/herdr-autostart
printf 'exit\n' |
  ssh -tt -F /dev/null -i "$tmp/id" -p "$port" \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    herdsman@127.0.0.1 >/dev/null 2>&1
docker exec "$name" grep -qx 'herdsman:/home/herdsman:/home/herdsman' /tmp/herdr-autostart

docker exec "$name" rm -f /tmp/herdr-autostart
docker exec --user herdsman \
  "$name" script -qec 'bash -ic exit' /dev/null >/dev/null
docker exec "$name" grep -qx 'herdsman:/home/herdsman:/home/herdsman' /tmp/herdr-autostart

docker exec "$name" rm -f /tmp/herdr-autostart
docker exec --user herdsman -e HERDR_ENV=1 \
  "$name" script -qec 'bash -ic exit' /dev/null >/dev/null
docker exec "$name" test ! -e /tmp/herdr-autostart

remote 'rm -f ~/.local/bin/herdr'
docker exec "$name" rm -f /tmp/herdr-autostart
verify_runtime

if ssh -F /dev/null -i "$tmp/id" -p "$port" \
  -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  root@127.0.0.1 true >/dev/null 2>&1; then
  echo "root SSH unexpectedly succeeded" >&2
  exit 1
fi
if ssh -F /dev/null -p "$port" -o BatchMode=yes \
  -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  herdsman@127.0.0.1 true >/dev/null 2>&1; then
  echo "password SSH unexpectedly succeeded" >&2
  exit 1
fi

host_fingerprint="$(docker exec "$name" ssh-keygen -lf /var/lib/herdsman/ssh/ssh_host_ed25519_key.pub)"
remote 'mkdir -p ~/persist-package && printf "%s\n" "{\"name\":\"persist-package\",\"version\":\"1.0.0\"}" > ~/persist-package/package.json && pi install ~/persist-package && mkdir -p ~/.local/bin && printf "%s\n" "#!/bin/sh" "printf persisted" > ~/.local/bin/persist-tool && chmod +x ~/.local/bin/persist-tool'

docker rm -f "$name" >/dev/null
start
verify_runtime
remote 'grep -q persist-package ~/.pi/agent/settings.json && test "$(persist-tool)" = persisted'
test "$host_fingerprint" = "$(docker exec "$name" ssh-keygen -lf /var/lib/herdsman/ssh/ssh_host_ed25519_key.pub)"

docker exec "$name" sh -c 'printf root-owned-sentinel > /home/herdsman/root-owned-target; chmod 0644 /home/herdsman/root-owned-target'
test "$(docker exec "$name" stat -c %u /home/herdsman/root-owned-target)" = 0
target_before="$(docker exec "$name" stat -c '%u:%a' /home/herdsman/root-owned-target):$(docker exec "$name" cat /home/herdsman/root-owned-target)"
remote 'ln -sf /home/herdsman/root-owned-target ~/.ssh/authorized_keys'
docker rm -f "$name" >/dev/null
docker run -d \
  --name "$name" \
  -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
  -v "$home:/home/herdsman" \
  -v "$ssh_state:/var/lib/herdsman/ssh" \
  "$image" >/dev/null
sleep 2
test "$(docker inspect -f '{{.State.Status}}' "$name")" = exited
test "$(docker inspect -f '{{.State.ExitCode}}' "$name")" -ne 0
target_after="$(docker run --rm --entrypoint /bin/sh -v "$home:/home/herdsman" "$image" -c 'stat -c "%u:%a" /home/herdsman/root-owned-target; cat /home/herdsman/root-owned-target' | tr '\n' ':')"
target_after="${target_after%:}"
test "$target_after" = "$target_before"
test "$(docker run --rm --entrypoint /bin/sh -v "$home:/home/herdsman" "$image" -c 'stat -c %a /home/herdsman/root-owned-target')" = 644
docker rm -f "$name" >/dev/null 2>&1 || true
docker run --rm \
  --user herdsman \
  --entrypoint /bin/sh \
  -v "$home:/home/herdsman" \
  "$image" \
  -c 'rm -f /home/herdsman/.ssh/authorized_keys /home/herdsman/root-owned-target'
start
verify_runtime

echo "Container smoke test passed (Pi $expected_pi)."
