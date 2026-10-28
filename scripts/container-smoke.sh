#!/usr/bin/env bash
set -euo pipefail

image=pi-herdsman:smoke
replacement_image="${image}-replacement"
name="pi-herdsman-smoke-$$"
home="${name}-home"
ssh_state="${name}-ssh"
custom_volume="${name}-identity-home"
offline_home="${name}-offline-home"
offline_ssh="${name}-offline-ssh"
migration_home="${name}-migration-home"
migration_ssh="${name}-migration-ssh"
damaged_home="${name}-damaged-home"
damaged_ssh="${name}-damaged-ssh"
interrupted_home="${name}-interrupted-home"
interrupted_ssh="${name}-interrupted-ssh"
tmp="$(mktemp -d)"
interrupt_fixture="$tmp/interrupt-fixture"
port=

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker image rm -f "$replacement_image" >/dev/null 2>&1 || true
  docker volume rm \
    "$home" "$ssh_state" "$offline_home" "$offline_ssh" \
    "$migration_home" "$migration_ssh" "$damaged_home" "$damaged_ssh" \
    "$interrupted_home" "$interrupted_ssh" \
    >/dev/null 2>&1 || true
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
mkdir -m 0755 "$interrupt_fixture"
cat > "$interrupt_fixture/interrupt-npm" <<'SH'
#!/bin/sh
while [ "$1" != --prefix ]; do shift; done
shift
cp -R /opt/pi-herdsman-npm-seed/. "$1/"
if [ "${SEED_TEST_MODE:-}" = interrupt ]; then
  kill -KILL "$PPID"
  exit 1
fi
exit 42
SH
chmod 0644 "$interrupt_fixture/interrupt-npm"

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

expected_pi="$(node -p 'require("./package.json").piHerdsman.runtime.pi')"
expected_herdr="$(node -p 'require("./package.json").piHerdsman.runtime.herdr.version')"

start_offline() {
  volume="$1"
  ssh_volume="$2"
  container_image="${3:-$image}"
  docker run -d \
    --network none \
    --name "$name" \
    -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
    -e PI_CODING_AGENT_DIR="${4:-}" \
    -v "$volume:/home/herdsman" \
    -v "$ssh_volume:/var/lib/herdsman/ssh" \
    "$container_image" >/dev/null

  for _ in $(seq 1 60); do
    state="$(docker inspect -f '{{.State.Status}}' "$name")"
    if [ "$state" = exited ]; then
      docker logs "$name"
      echo "offline container startup failed" >&2
      return 1
    fi
    if [ "$state" = running ] && docker exec "$name" pgrep -x sshd >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  docker logs "$name"
  echo "offline container did not finish startup" >&2
  return 1
}

verify_seeded_package() {
  docker exec --user herdsman -e HOME=/home/herdsman "$name" node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const agent = path.join(process.env.HOME, ".pi", "agent");
    const settings = JSON.parse(fs.readFileSync(path.join(agent, "settings.json"), "utf8"));
    const sources = settings.packages.map((entry) => typeof entry === "string" ? entry : entry?.source);
    const matches = sources.filter((source) => source === "npm:pi-herdsman");
    if (matches.length !== 1 || sources.includes("/opt/pi-herdsman")) throw new Error(`unexpected package sources: ${JSON.stringify(sources)}`);
    const npm = path.join(agent, "npm");
    const manifest = JSON.parse(fs.readFileSync(path.join(npm, "package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(npm, "package-lock.json"), "utf8"));
    const installed = JSON.parse(fs.readFileSync(path.join(npm, "node_modules/pi-herdsman/package.json"), "utf8"));
    const entry = lock.packages?.["node_modules/pi-herdsman"];
    if (manifest.dependencies["pi-herdsman"] !== "*" || entry?.version !== installed.version || !entry.resolved.startsWith("file:")) throw new Error("npm package metadata does not match the installed package");
    const tarball = path.resolve(npm, entry.resolved.slice(5));
    const integrity = `sha512-${require("node:crypto").createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
    const sha256 = require("node:crypto").createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
    if (path.dirname(tarball) !== path.join(agent, ".pi-herdsman-seeds") || path.basename(tarball) !== `${sha256}.tgz` || integrity !== entry.integrity) throw new Error("npm lock retained tarball resolution or integrity is invalid");
    if (!fs.readFileSync(path.join(npm, "node_modules/pi-herdsman/dist/index.js")).equals(fs.readFileSync("/opt/pi-herdsman/dist/index.js"))) throw new Error("installed package differs from the image seed");
    require.resolve("proper-lockfile", { paths: [path.join(npm, "node_modules/pi-herdsman")] });
    console.log(`npm:pi-herdsman@${installed.version}`);
  '
}

seed_state() {
  docker exec "$name" sha256sum \
    /home/herdsman/.pi/agent/settings.json \
    /home/herdsman/.pi/agent/npm/package.json \
    /home/herdsman/.pi/agent/npm/package-lock.json \
    /home/herdsman/.pi/agent/npm/node_modules/pi-herdsman/package.json \
    /home/herdsman/.pi/agent/npm/node_modules/pi-herdsman/dist/index.js
}

wait_after_restart() {
  for _ in $(seq 1 60); do
    state="$(docker inspect -f '{{.State.Status}}' "$name")"
    if [ "$state" = exited ]; then
      docker logs "$name"
      echo "container failed during restart" >&2
      return 1
    fi
    if [ "$state" = running ] && docker exec "$name" pgrep -x sshd >/dev/null 2>&1; then
      return
    fi
    sleep 1
  done
  docker logs "$name"
  echo "container did not finish restart" >&2
  return 1
}

# A fresh home must seed and load entirely offline, then remain unchanged on restarts/recreation.
start_offline "$offline_home" "$offline_ssh"
verify_seeded_package
initial_seed_state="$(seed_state)"
test "$(docker exec "$name" stat -c %u /home/herdsman/.pi/agent/settings.json)" = "$(docker exec "$name" id -u herdsman)"
test "$(docker exec "$name" stat -c %u /home/herdsman/.pi/agent/npm/package-lock.json)" = "$(docker exec "$name" id -u herdsman)"
docker exec --user herdsman -e HOME=/home/herdsman "$name" pi --offline --help >/dev/null
docker exec --user herdsman "$name" sh -c \
  'printf persistent-copy > /home/herdsman/.pi/agent/npm/node_modules/pi-herdsman/.smoke-preserve'
docker restart "$name" >/dev/null
wait_after_restart
verify_seeded_package
test "$(seed_state)" = "$initial_seed_state"
docker exec --user herdsman "$name" sh -c \
  'test "$(cat /home/herdsman/.pi/agent/npm/node_modules/pi-herdsman/.smoke-preserve)" = persistent-copy'
before_recreation="$(seed_state)"
docker rm -f "$name" >/dev/null
start_offline "$offline_home" "$offline_ssh"
verify_seeded_package
test "$(seed_state)" = "$before_recreation"
docker exec --user herdsman "$name" sh -c \
  'test "$(cat /home/herdsman/.pi/agent/npm/node_modules/pi-herdsman/.smoke-preserve)" = persistent-copy'
docker exec "$name" sh -c \
  'printf replacement-image-seed > /opt/pi-herdsman-npm-seed/node_modules/pi-herdsman/README.md; mkdir /tmp/replacement-package; tar -xzf /opt/pi-herdsman-seed.tgz -C /tmp/replacement-package; printf replacement >> /tmp/replacement-package/package/README.md; tar -czf /opt/pi-herdsman-seed.tgz -C /tmp/replacement-package package'
docker commit "$name" "$replacement_image" >/dev/null
docker rm -f "$name" >/dev/null
start_offline "$offline_home" "$offline_ssh" "$replacement_image"
verify_seeded_package
test "$(seed_state)" = "$before_recreation"
docker exec --user herdsman "$name" sh -c \
  'test "$(cat /opt/pi-herdsman-npm-seed/node_modules/pi-herdsman/README.md)" = replacement-image-seed && test "$(cat /home/herdsman/.pi/agent/npm/node_modules/pi-herdsman/.smoke-preserve)" = persistent-copy && ! grep -q replacement-image-seed /home/herdsman/.pi/agent/npm/node_modules/pi-herdsman/README.md'
docker rm -f "$name" >/dev/null

# Startup honors the configured Pi agent directory, including on restart.
docker volume rm "$damaged_home" "$damaged_ssh" >/dev/null 2>&1 || true
start_offline "$damaged_home" "$damaged_ssh" "$image" /home/herdsman/custom-agent
docker exec --user herdsman "$name" sh -c '
  test -f /home/herdsman/custom-agent/npm/node_modules/pi-herdsman/dist/index.js
  grep -q npm:pi-herdsman /home/herdsman/custom-agent/settings.json
  test ! -e /home/herdsman/.pi/agent/npm/node_modules/pi-herdsman
'
docker restart "$name" >/dev/null
wait_after_restart
docker exec --user herdsman "$name" sh -c 'test -f /home/herdsman/custom-agent/npm/node_modules/pi-herdsman/dist/index.js && grep -q npm:pi-herdsman /home/herdsman/custom-agent/settings.json'
docker rm -f "$name" >/dev/null
docker volume rm "$damaged_home" "$damaged_ssh" >/dev/null

# Failed and interrupted npm operations leave the original managed root untouched.
for mode in failure interrupt; do
  docker volume rm "$interrupted_home" "$interrupted_ssh" >/dev/null 2>&1 || true
  docker run --rm --network none --user herdsman -e HOME=/home/herdsman \
    --entrypoint /bin/sh -v "$interrupted_home:/home/herdsman" -v "$interrupt_fixture:/fixture:ro" "$image" -c '
      mkdir -p ~/.pi/agent ~/fake-bin
      cp /fixture/interrupt-npm ~/fake-bin/npm; chmod 0755 ~/fake-bin/npm
      printf "%s\n" "{\"packages\":[\"/opt/pi-herdsman\"]}" > ~/.pi/agent/settings.json
    '
  docker run -d --network none --name "$name" \
    -e SEED_TEST_MODE="$mode" \
    -e PATH="/home/herdsman/fake-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
    -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
    -v "$interrupted_home:/home/herdsman" -v "$interrupted_ssh:/var/lib/herdsman/ssh" "$image" >/dev/null
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Status}}' "$name")" = exited ] && break
    sleep 1
  done
  test "$(docker inspect -f '{{.State.Status}}' "$name")" = exited
  if [ "$mode" = failure ]; then docker logs "$name" 2>&1 | grep -q 'offline npm seed install failed with code 42'; fi
  docker rm "$name" >/dev/null
  # A package subsequently created while the marker is stale is never deleted.
  docker run --rm --network none --user herdsman -e HOME=/home/herdsman --entrypoint /bin/sh \
    -v "$interrupted_home:/home/herdsman" "$image" -c '
      test -s ~/.pi/agent/.pi-herdsman-seed-attempt.json
      mkdir -p ~/.pi/agent/npm/node_modules/pi-herdsman
      printf later > ~/.pi/agent/npm/node_modules/pi-herdsman/package.json
    '
  docker run -d --network none --name "$name" -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
    -v "$interrupted_home:/home/herdsman" -v "$interrupted_ssh:/var/lib/herdsman/ssh" "$image" >/dev/null
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Status}}' "$name")" = exited ] && break
    sleep 1
  done
  test "$(docker inspect -f '{{.State.Status}}' "$name")" = exited
  docker logs "$name" 2>&1 | grep -q 'unfinished npm seed'
  docker rm "$name" >/dev/null
  docker run --rm --network none --entrypoint /bin/sh -v "$interrupted_home:/home/herdsman:ro" "$image" -c '
    test "$(cat /home/herdsman/.pi/agent/npm/node_modules/pi-herdsman/package.json)" = later
    grep -q /opt/pi-herdsman /home/herdsman/.pi/agent/settings.json
  '
done

# Migrate an object-form legacy declaration while preserving settings and another npm version.
docker run --rm --network none \
  --user herdsman -e HOME=/home/herdsman \
  --entrypoint /bin/sh \
  -v "$migration_home:/home/herdsman" \
  "$image" -c '
    mkdir -p ~/.pi/agent/extensions ~/fixture-package
    printf "%s\n" "{\"name\":\"unrelated-fixture\",\"version\":\"2.3.4\",\"main\":\"index.js\",\"dependencies\":{\"proper-lockfile\":\"4.1.2\"}}" > ~/fixture-package/package.json
    printf "%s\n" "module.exports = \"preserved\";" > ~/fixture-package/index.js
    cp -R /opt/pi-herdsman-npm-cache ~/fixture-cache
    npm install --prefix ~/.pi/agent/npm --cache ~/fixture-cache --offline --no-audit --no-fund ~/fixture-package >/dev/null
    printf "%s\n" "{\"marker\":\"keep-this-setting\",\"extensions\":[\"./extensions/user.ts\"],\"packages\":[{\"source\":\"/opt/pi-herdsman\",\"extensions\":[\"./dist/index.js\"],\"skills\":[]},{\"source\":\"npm:unrelated-fixture\",\"extensions\":[],\"prompts\":[\"prompts/custom.md\"]}]}" > ~/.pi/agent/settings.json
    printf preserved-credential > ~/.pi/credential-sentinel
  '
start_offline "$migration_home" "$migration_ssh"
verify_seeded_package
docker exec --user herdsman -e HOME=/home/herdsman "$name" node -e '
  const fs=require("node:fs"); const path=require("node:path"); const home=process.env.HOME; const settings=JSON.parse(fs.readFileSync(path.join(home,".pi/agent/settings.json"),"utf8")); const packages=settings.packages;
  if(settings.marker!=="keep-this-setting" || JSON.stringify(settings.extensions)!==JSON.stringify(["./extensions/user.ts"])) throw Error("unrelated settings were not preserved");
  if(packages.length!==2 || JSON.stringify(packages[0])!==JSON.stringify({source:"npm:pi-herdsman",extensions:["./dist/index.js"],skills:[]}) || JSON.stringify(packages[1])!==JSON.stringify({source:"npm:unrelated-fixture",extensions:[],prompts:["prompts/custom.md"]})) throw Error("object-form package entries were not preserved");
  const root=path.join(home,".pi/agent/npm"); const fixture=JSON.parse(fs.readFileSync(path.join(root,"node_modules/unrelated-fixture/package.json"),"utf8")); const lock=JSON.parse(fs.readFileSync(path.join(root,"package-lock.json"),"utf8")); const link=lock.packages["node_modules/unrelated-fixture"];
  if(fixture.version!=="2.3.4" || !link.link || lock.packages[link.resolved].version!==fixture.version || lock.packages["node_modules/proper-lockfile"]?.version!=="4.1.2") throw Error("existing npm package or dependency changed");
  if(fs.readFileSync(path.join(home,".pi/credential-sentinel"),"utf8")!=="preserved-credential") throw Error("unrelated home state changed");
'
docker rm -f "$name" >/dev/null

# If both sources exist, remove only the legacy entry and keep the selected npm copy untouched.
start_offline "$offline_home" "$offline_ssh"
docker exec --user herdsman -e HOME=/home/herdsman "$name" node -e '
  const fs=require("node:fs"); const file=process.env.HOME+"/.pi/agent/settings.json"; const settings=JSON.parse(fs.readFileSync(file,"utf8")); settings.packages=[{source:"npm:pi-herdsman",extensions:["./dist/index.js"]},"/opt/pi-herdsman",{source:"npm:unrelated-fixture",extensions:[]}]; settings.userSetting="preserve"; fs.writeFileSync(file,JSON.stringify(settings,null,2)+"\n");
'
docker rm -f "$name" >/dev/null
start_offline "$offline_home" "$offline_ssh"
docker exec --user herdsman -e HOME=/home/herdsman "$name" node -e '
  const fs=require("node:fs"); const path=require("node:path"); const home=process.env.HOME; const settings=JSON.parse(fs.readFileSync(path.join(home,".pi/agent/settings.json"),"utf8"));
  if(settings.packages.length!==2 || settings.packages[0].source!=="npm:pi-herdsman" || JSON.stringify(settings.packages[0].extensions)!==JSON.stringify(["./dist/index.js"]) || settings.packages.some((entry)=>entry==="/opt/pi-herdsman") || settings.userSetting!=="preserve") throw Error("legacy migration did not retain existing npm selection/settings");
  if(fs.readFileSync(path.join(home,".pi/agent/npm/node_modules/pi-herdsman/.smoke-preserve"),"utf8")!=="persistent-copy") throw Error("existing npm package copy was overwritten");
'
docker rm -f "$name" >/dev/null

# A configured but damaged npm copy must fail closed rather than restoring the image seed.
docker run --rm --network none \
  --user herdsman -e HOME=/home/herdsman \
  --entrypoint /bin/sh \
  -v "$damaged_home:/home/herdsman" \
  "$image" -c '
    mkdir -p ~/.pi/agent/npm
    cp -R /opt/pi-herdsman-npm-seed/. ~/.pi/agent/npm/
    rm ~/.pi/agent/npm/node_modules/pi-herdsman/dist/index.js
    printf "%s\n" "{\"packages\":[\"npm:pi-herdsman\"]}" > ~/.pi/agent/settings.json
  '
docker run -d --network none --name "$name" \
  -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
  -v "$damaged_home:/home/herdsman" \
  -v "$damaged_ssh:/var/lib/herdsman/ssh" \
  "$image" > /dev/null
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Status}}' "$name")" = exited ] && break
  sleep 1
done
test "$(docker inspect -f '{{.State.Status}}' "$name")" = exited
docker logs "$name" 2>&1 | grep -q 'npm:pi-herdsman installation is invalid: missing dist/index.js'
docker rm "$name" >/dev/null
docker run --rm --network none --entrypoint /bin/sh \
  -v "$damaged_home:/home/herdsman:ro" "$image" \
  -c 'test ! -e /home/herdsman/.pi/agent/npm/node_modules/pi-herdsman/dist/index.js'

# Symlinked selected packages or required paths must not escape the managed tree.
for target in package index dist bridge manifest npm node_modules; do
  docker volume rm "$damaged_home" "$damaged_ssh" >/dev/null 2>&1 || true
  docker run --rm --network none --user herdsman -e HOME=/home/herdsman \
    --entrypoint /bin/sh -v "$damaged_home:/home/herdsman" "$image" -c '
      mkdir -p ~/.pi/agent/npm
      cp -R /opt/pi-herdsman-npm-seed/. ~/.pi/agent/npm/
      printf "%s\n" "{\"packages\":[\"npm:pi-herdsman\"]}" > ~/.pi/agent/settings.json
      root="$HOME/.pi/agent/npm"; pkg="$root/node_modules/pi-herdsman"
      case "$1" in
        package) path="$pkg" ;;
        index) path="$pkg/dist/index.js" ;;
        dist) path="$pkg/dist" ;;
        bridge) path="$pkg/dist/peer-bridge.js" ;;
        manifest) path="$pkg/package.json" ;;
        npm) path="$root" ;;
        node_modules) path="$root/node_modules" ;;
      esac
      mv "$path" "$HOME/outside"
      ln -s "$HOME/outside" "$path"
    ' sh "$target"
  docker run -d --network none --name "$name" \
    -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
    -v "$damaged_home:/home/herdsman" -v "$damaged_ssh:/var/lib/herdsman/ssh" "$image" >/dev/null
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Status}}' "$name")" = exited ] && break
    sleep 1
  done
  test "$(docker inspect -f '{{.State.Status}}' "$name")" = exited
  docker logs "$name" 2>&1 | grep -q 'npm:pi-herdsman installation is invalid:'
  docker rm "$name" >/dev/null
  docker run --rm --network none --entrypoint /bin/sh \
    -v "$damaged_home:/home/herdsman:ro" "$image" -c 'test -e /home/herdsman/outside'
done

# Even a valid selected package with migrated settings cannot prove marker ownership.
docker run --rm --network none --user herdsman -e HOME=/home/herdsman \
  --entrypoint /bin/sh -v "$offline_home:/home/herdsman" "$image" -c '
    printf "completed-looking marker\n" > ~/.pi/agent/.pi-herdsman-seed-attempt.json
  '
docker run -d --network none --name "$name" -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
  -v "$offline_home:/home/herdsman" -v "$offline_ssh:/var/lib/herdsman/ssh" "$image" >/dev/null
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Status}}' "$name")" = exited ] && break
  sleep 1
done
test "$(docker inspect -f '{{.State.Status}}' "$name")" = exited
docker logs "$name" 2>&1 | grep -q 'unfinished npm seed'
docker rm "$name" >/dev/null
docker run --rm --network none --user herdsman -e HOME=/home/herdsman \
  --entrypoint /bin/sh -v "$offline_home:/home/herdsman" "$image" -c '
    test "$(cat ~/.pi/agent/.pi-herdsman-seed-attempt.json)" = "completed-looking marker"
    test "$(cat ~/.pi/agent/npm/node_modules/pi-herdsman/.smoke-preserve)" = persistent-copy
    rm ~/.pi/agent/.pi-herdsman-seed-attempt.json
  '

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
    test \"\$(npm config get update-notifier)\" = false; \
    command -v node >/dev/null; node --version | grep -q '^v26\\.'; \
    command -v herdr >/dev/null; test \"\$(herdr --version | awk '{ print \$NF }')\" = '$expected_herdr'; \
    command -v mise >/dev/null; mise --version >/dev/null; \
    command -v rg >/dev/null; command -v fd >/dev/null; \
    command -v jq >/dev/null; command -v gh >/dev/null; \
    command -v python3 >/dev/null; command -v git >/dev/null; \
    test -r /AGENTS.md; \
    grep -q '^# Pi Herdsman container environment$' /AGENTS.md; \
    node -e 'const s=JSON.parse(require(\"fs\").readFileSync(process.env.HOME+\"/.pi/agent/settings.json\"));if(!s.packages.some(p=>p===\"npm:pi-herdsman\"||p?.source===\"npm:pi-herdsman\")||s.packages.some(p=>p===\"/opt/pi-herdsman\"||p?.source===\"/opt/pi-herdsman\"))process.exit(1)'; \
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
docker exec --user herdsman "$name" sh -c 'test "$(npm config get update-notifier)" = false'

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
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Status}}' "$name")" = exited ] && break
  sleep 1
done
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
