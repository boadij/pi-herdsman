#!/usr/bin/env bash
set -euo pipefail

image=pi-herdsman:smoke
name="pi-herdsman-smoke-$$"
home="${name}-home"
ssh_state="${name}-ssh"
tmp="$(mktemp -d)"
port=

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$home" "$ssh_state" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N '' -f "$tmp/id"

docker build --platform linux/amd64 -t "$image" .

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

start
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

echo "Container smoke test passed (Pi $expected_pi)."
