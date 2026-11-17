#!/usr/bin/env bash
set -Eeuo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/home" "$work/project"
export HOME="$work/home" LOG="$work/log" PROJECT="$work/project"
export PATH="$work/bin:$PATH"
cat >"$work/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$LOG"
case "$*" in
  'compose version'|info|'compose config --quiet') [[ ${INVALID:-0} != 1 || "$*" != 'compose config --quiet' ]] ;;
  'compose config --services') printf 'herdsman\n'; [[ ${TAILSCALE:-0} != 1 ]] || printf 'tailscale\n' ;;
  'compose ps --all --quiet herdsman') printf '%s\n' "${HERDSMAN_IDS-${IDS:-}}" ;;
  'compose ps --all --quiet tailscale') printf '%s\n' "${SIDECAR_IDS:-}" ;;
  'compose start tailscale'|'compose up -d --no-recreate tailscale') : ;;
  'compose up -d'|'compose up -d --no-recreate') : ;;
  'compose up -d --force-recreate tailscale')
    printf 'credential=%s\n' "${TS_AUTHKEY:+present}" >>"$LOG"
    if [[ -n ${TS_AUTHKEY:-} ]]; then
      [[ ${BOOTSTRAP_FAIL:-0} != 1 ]] || exit 1
      : >"$TS_STATE"
    else
      [[ ${RESTORE_FAIL:-0} != 1 ]] || exit 1
    fi ;;
  'compose stop tailscale'|'stop sidecar') [[ ${STOP_FAIL:-0} != 1 ]] ;;
  'compose up -d --force-recreate herdsman') : ;;
  'compose exec --interactive=false -T tailscale tailscale status --json')
    if [[ -e ${TS_STATE:-/nonexistent} || ${TS_READY:-0} == 1 ]]; then echo '{"BackendState":"Running"}'; else exit 1; fi ;;
  compose\ run*)
    auth_script=${@: -1}
    auth_script=${auth_script//\/home\/herdsman/$AUTH_HOME}
    sh -c "$auth_script" ;;

  'compose ps --all --quiet') printf '%s\n' "${IDS:-}" ;;
  'compose ps --quiet herdsman') printf '%s\n' "${RUNNING:-}" ;;
  inspect\ --format*)
    if [[ "$3" == *Config.Env* ]]; then
      [[ ${INSPECT_FAIL:-0} != 1 ]] || exit 1
      if [[ ${CREDENTIAL_PRESENT:-0} == 1 || ( ${RESTORE_RETAINS:-0} == 1 && -e ${TS_STATE:-/nonexistent} ) ]]; then printf present; fi
    else printf '%s\n' "${LABEL:-$PROJECT}"; fi ;;
  'compose port herdsman 22') echo '0.0.0.0:2222' ;;
  'compose config --environment') : ;;
  compose\ exec*)
    if [[ ${MOCK_AUTH:-0} == 1 && "$*" == *authorized_keys* ]]; then
      auth_script=${@: -1}
      auth_script=${auth_script//\/home\/herdsman/$AUTH_HOME}
      sh -c "$auth_script"
    fi ;;

  *) echo "unexpected docker call: $*" >&2; exit 1 ;;
esac
MOCK
cat >"$work/bin/curl" <<'MOCK'
#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do if [[ $1 == -o ]]; then shift; printf 'services: {}\n' >"$1"; exit; fi; shift; done
exit 1
MOCK
cat >"$work/bin/sleep" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
chmod +x "$work/bin/docker" "$work/bin/curl" "$work/bin/sleep"
printf 'services: {}\n' >"$PROJECT/compose.yaml"
printf '# preserved override\n' >"$PROJECT/compose.override.yaml"
printf '# preserved env\n' >"$PROJECT/.env"
cd "$PROJECT"
cp compose.yaml "$work/base"; cp compose.override.yaml "$work/override"; cp .env "$work/env"
# A deleted current directory must not be recreated from the inherited PWD.
stale="$work/deleted-cwd"
mkdir "$stale"
(
  cd "$stale"
  rmdir "$stale"
  if bash "$root/scripts/docker-setup.sh" </dev/null >"$work/deleted-cwd.out" 2>&1; then
    echo 'deleted current directory accepted' >&2
    exit 1
  fi
)
grep -Fq 'current directory is inaccessible' "$work/deleted-cwd.out"
[[ ! -e "$stale" && ! -e "$LOG" ]]
export IDS=container RUNNING=container
bash "$root/scripts/docker-setup.sh" </dev/null >"$work/output"
grep -q 'Herdsman is ready' "$work/output"
! grep -Eq '^compose (up|start|run)' "$LOG"
cmp compose.yaml "$work/base"; cmp compose.override.yaml "$work/override"; cmp .env "$work/env"
: >"$LOG"
if LABEL="$work/other" bash "$root/scripts/docker-setup.sh" </dev/null >"$work/output" 2>&1; then echo 'collision accepted' >&2; exit 1; fi
grep -q 'refusing takeover' "$work/output"
! grep -Eq '^compose (up|start|run)' "$LOG"
: >"$LOG"
if INVALID=1 bash "$root/scripts/docker-setup.sh" </dev/null >"$work/output" 2>&1; then echo 'invalid config accepted' >&2; exit 1; fi
grep -q 'invalid or missing' "$work/output"
: >"$LOG"
if IDS= RUNNING= bash "$root/scripts/docker-setup.sh" </dev/null >"$work/output" 2>&1; then echo 'unconfirmed startup accepted' >&2; exit 1; fi
grep -q 'confirmation required' "$work/output"
! grep -Eq '^compose (up|start|run)' "$LOG"
# Exercise the actual authorization script against a disposable home.
ssh-keygen -q -t ed25519 -N '' -f "$work/test-key"
export SSH_AUTHORIZED_KEYS="$(<"$work/test-key.pub")" MOCK_AUTH=1 AUTH_HOME="$work/auth-home"
mkdir "$AUTH_HOME"
bash "$root/scripts/docker-setup.sh" </dev/null >"$work/output"
bash "$root/scripts/docker-setup.sh" </dev/null >"$work/output"
[[ $(wc -l <"$AUTH_HOME/.ssh/authorized_keys") == 1 ]]
ssh-keygen -q -t ed25519 -N '' -f "$work/second-key"
SSH_AUTHORIZED_KEYS="$(<"$work/second-key.pub")" bash "$root/scripts/docker-setup.sh" </dev/null >"$work/output"
[[ $(wc -l <"$AUTH_HOME/.ssh/authorized_keys") == 2 ]]
[[ $(stat -c '%a' "$AUTH_HOME/.ssh") == 700 ]]
[[ $(stat -c '%a' "$AUTH_HOME/.ssh/authorized_keys") == 600 ]]
rm "$AUTH_HOME/.ssh/authorized_keys"
ln -s "$work/target" "$AUTH_HOME/.ssh/authorized_keys"
if bash "$root/scripts/docker-setup.sh" </dev/null >"$work/output" 2>&1; then echo 'symlink accepted' >&2; exit 1; fi
[[ ! -e "$work/target" ]]
# A pseudo-terminal supplies real interactive answers; never generate a host key.
run_tty() {
  local answers=$1 output=$2
  printf '%b' "$answers" | script -q -e -c "bash '$root/scripts/docker-setup.sh'" /dev/null >"$output" 2>&1
}
mkdir -p "$HOME/.ssh"
cp "$work/test-key.pub" "$HOME/.ssh/id_ed25519.pub"
unset SSH_AUTHORIZED_KEYS MOCK_AUTH
export IDS= RUNNING= AUTH_HOME="$work/fresh-home"
mkdir "$AUTH_HOME" "$work/fresh"
cd "$work/fresh"
: >"$LOG"
# Declining the only offered host key leaves a fresh home unauthorized.
if run_tty '1\nn\n\n' "$work/decline"; then echo 'fresh setup without authorization succeeded' >&2; exit 1; fi
grep -q 'no authorized keys exist' "$work/decline"
! grep -q '^compose up -d$' "$LOG"
[[ ! -e "$HOME/.ssh/id_ed25519" ]]
# Retry an existing configuration only after confirming startup and consenting.
run_tty 'y\n\ny\n' "$work/accept"
[[ $(wc -l <"$AUTH_HOME/.ssh/authorized_keys") == 1 ]]
grep -q '^compose up -d$' "$LOG"

# Fresh bind-home initialization always requests image IDs, never root IDs.
cat >"$work/bin/chown" <<'MOCK'
#!/usr/bin/env bash
printf 'chown %s\n' "$*" >>"$LOG"
MOCK
cat >"$work/bin/stat" <<'MOCK'
#!/usr/bin/env bash
if [[ "${@: -1}" == */data/herdsman-home ]]; then
  case "$2" in '%u'|'%g') echo 1000 ;; '%a') echo 700 ;; esac
else /usr/bin/stat "$@"; fi
MOCK
chmod +x "$work/bin/chown" "$work/bin/stat"
mkdir "$work/bind" "$work/bind-home"
cd "$work/bind"
export AUTH_HOME="$work/bind-home" TAILSCALE=1 TS_READY=1
: >"$LOG"
run_tty '3\ny\n\n' "$work/bind-output"
grep -q '^chown 1000:1000 -- ' "$LOG"
! grep -q '^chown .*0:0' "$LOG"
# A previously existing home, including its contents, is never re-owned.
mkdir -p "$work/bind-existing/data/herdsman-home" "$work/bind-existing-home"
printf 'keep' >"$work/bind-existing/data/herdsman-home/keep"
cd "$work/bind-existing"; export AUTH_HOME="$work/bind-existing-home"
: >"$LOG"
run_tty '3\ny\n\n' "$work/bind-existing-output"
! grep -q '^chown ' "$LOG"
[[ $(<data/herdsman-home/keep) == keep ]]

# Failed SSH authorization can leave only a sidecar; retry it with consent.
mkdir "$work/partial" "$work/partial-home"; cd "$work/partial"
export AUTH_HOME="$work/partial-home" TS_STATE="$work/ts-state" TS_AUTHKEY='example-secret'
unset TS_READY
: >"$LOG"
if run_tty '2\nn\n\n' "$work/partial-fail"; then echo 'unauthorized Tailscale setup succeeded' >&2; exit 1; fi
grep -q '^compose up -d --no-recreate tailscale$' "$LOG"
export IDS=sidecar SIDECAR_IDS=sidecar HERDSMAN_IDS= RUNNING= LABEL="$PWD"
# Empty HERDSMAN_IDS must not fall back to IDS in the mock.
: >"$LOG"
run_tty 'y\n\ny\n' "$work/partial-retry"
grep -q '^compose up -d --no-recreate$' "$LOG"
[[ $(grep -c '^credential=present$' "$LOG") == 1 ]]
[[ $(grep -c '^credential=$' "$LOG") == 1 ]]
! grep -q 'example-secret' .env "$LOG" "$work/partial-retry"
# A bootstrap failure restores a key-free sidecar even on the error path.
rm "$TS_STATE"
: >"$LOG"
if BOOTSTRAP_FAIL=1 run_tty 'y\n\ny\n' "$work/bootstrap-fail"; then echo 'failed bootstrap accepted' >&2; exit 1; fi
[[ $(grep -c '^credential=present$' "$LOG") == 1 ]]
[[ $(grep -c '^credential=$' "$LOG") == 1 ]]
! grep -q 'example-secret' .env "$LOG" "$work/bootstrap-fail"
# If both key-free restoration attempts fail, stop the sidecar, not merely warn.
rm -f "$TS_STATE"; : >"$LOG"
if RESTORE_FAIL=1 run_tty 'y\n\ny\n' "$work/restore-fail"; then echo 'failed restoration accepted' >&2; exit 1; fi
[[ $(grep -c '^credential=$' "$LOG") == 2 ]]
grep -q '^compose stop tailscale$' "$LOG"
grep -q 'Tailscale is stopped' "$work/restore-fail"
! grep -q 'example-secret' "$LOG" "$work/restore-fail"
# If stopping fails too, surface urgent manual remediation without the key.
rm -f "$TS_STATE"; : >"$LOG"
if RESTORE_FAIL=1 STOP_FAIL=1 run_tty 'y\n\ny\n' "$work/stop-fail"; then echo 'failed stop accepted' >&2; exit 1; fi
grep -q 'CRITICAL: could not stop Tailscale' "$work/stop-fail"
! grep -q 'example-secret' "$LOG" "$work/stop-fail"
# Even a successful Compose command is not proof that the restored container is key-free.
rm -f "$TS_STATE"; : >"$LOG"
if RESTORE_RETAINS=1 run_tty 'y\n\ny\n' "$work/restore-retains"; then echo 'credential retained after restoration' >&2; exit 1; fi
grep -q '^compose stop tailscale$' "$LOG"
! grep -q 'example-secret' "$LOG" "$work/restore-retains"
# Both containers may exist after interrupted bootstrap; stop the unsafe sidecar.
export HERDSMAN_IDS=herdsman IDS=$'sidecar\nherdsman' RUNNING=herdsman MOCK_AUTH=1
: >"$LOG"
if CREDENTIAL_PRESENT=1 bash "$root/scripts/docker-setup.sh" </dev/null >"$work/interrupted" 2>&1; then echo 'credential-bearing sidecar accepted' >&2; exit 1; fi
grep -q 'contained a bootstrap credential and was stopped' "$work/interrupted"
grep -q '^stop sidecar$' "$LOG"
! grep -Eq '^compose (up|start|run|exec)' "$LOG"
! grep -q 'example-secret' "$work/interrupted" "$LOG"
: >"$LOG"
if CREDENTIAL_PRESENT=1 STOP_FAIL=1 bash "$root/scripts/docker-setup.sh" </dev/null >"$work/interrupted-stop-fail" 2>&1; then echo 'unsafe sidecar stop failure accepted' >&2; exit 1; fi
grep -q 'CRITICAL: Tailscale container' "$work/interrupted-stop-fail"
: >"$LOG"
if INSPECT_FAIL=1 bash "$root/scripts/docker-setup.sh" </dev/null >"$work/inspect-fail" 2>&1; then echo 'failed credential inspection accepted' >&2; exit 1; fi
grep -q 'could not inspect Tailscale bootstrap credential state' "$work/inspect-fail"
grep -q '^stop sidecar$' "$LOG"
! grep -Eq '^compose (up|start|run|exec)' "$LOG"
# A failed registration with both containers present must not report readiness
# or attempt automatic repair on a repeat invocation.
export HERDSMAN_IDS=herdsman IDS=$'sidecar\nherdsman' RUNNING=herdsman MOCK_AUTH=1
rm -f "$TS_STATE"; : >"$LOG"
if bash "$root/scripts/docker-setup.sh" </dev/null >"$work/unregistered" 2>&1; then echo 'unregistered Tailscale deployment accepted' >&2; exit 1; fi
grep -q 'existing Tailscale deployment is not registered or its status is unavailable' "$work/unregistered"
grep -q '^compose exec --interactive=false -T tailscale tailscale status --json$' "$LOG"
! grep -Eq '^compose (up|start|run)' "$LOG"
! grep -q 'Herdsman is ready' "$work/unregistered"
# A registered repeat retains its sidecar and succeeds without recreation.
export TS_READY=1
: >"$LOG"
bash "$root/scripts/docker-setup.sh" </dev/null >"$work/repeat"
grep -q 'Herdsman is ready' "$work/repeat"
! grep -Eq '^compose (up|start|run)' "$LOG"
printf 'docker setup focused tests passed\n'
