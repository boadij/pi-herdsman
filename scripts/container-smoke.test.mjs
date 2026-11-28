import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("installer, verification, and cleanup share Docker configuration", () => {
  const script = readFileSync("scripts/container-smoke.sh", "utf8");
  const dockerConfig = script.match(/^# Keep Docker's configuration[\s\S]*?^fi$/m)?.[0];
  const setupEnvironment = script.match(/^  setup_environment\(\) \{[\s\S]*?^  \}/m)?.[0];
  assert.ok(dockerConfig);
  assert.ok(setupEnvironment);
  for (const config of ["relative-config", ""]) {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
      set -euo pipefail
      ${dockerConfig}
      original_config="$DOCKER_CONFIG"
      original_cert="$DOCKER_CERT_PATH"
      setup_home=/isolated/home
      project=installer-smoke-test
      ${setupEnvironment}
      setup_environment
      "\${clean_env[@]}" bash -c '
        test "$HOME" = /isolated/home
        test "$DOCKER_CONFIG" = "$1"
        test "$DOCKER_CERT_PATH" = "$2"
        test "$DOCKER_HOST" = tcp://example.invalid:2376
        test "$DOCKER_CONTEXT" = selected-context
        test "$SSH_AUTH_SOCK" = /tmp/test-agent
        test "$COMPOSE_PROJECT_NAME" = installer-smoke-test
        test -z "\${COMPOSE_FILE+x}\${PUID+x}\${SSH_AUTHORIZED_KEYS+x}\${PI_HERDSMAN_DIR+x}"
      ' bash "$original_config" "$original_cert"
      case "$1" in
        relative) test "$original_config" = "$PWD/relative-config" ;;
        default) test "$original_config" = "$HOME/.docker" ;;
      esac
      test "$original_cert" = "$PWD/relative-cert"
    `,
        "bash",
        config ? "relative" : "default",
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          HOME: "/caller-home",
          DOCKER_CONFIG: config,
          DOCKER_CERT_PATH: "relative-cert",
          DOCKER_HOST: "tcp://example.invalid:2376",
          DOCKER_CONTEXT: "selected-context",
          SSH_AUTH_SOCK: "/tmp/test-agent",
          COMPOSE_FILE: "unrelated.yaml",
          PUID: "9000",
          SSH_AUTHORIZED_KEYS: "unrelated-key",
          PI_HERDSMAN_DIR: "/unrelated",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
  }
});

test(
  "installer smoke responds through a terminal and propagates failure",
  { skip: process.platform === "win32" },
  () => {
    const script = readFileSync("scripts/container-smoke.sh", "utf8");
    const runSetup = script.match(/^  run_setup\(\) \{[\s\S]*?^  \}/m)?.[0];
    assert.ok(runSetup);
    const dir = mkdtempSync(join(tmpdir(), "installer-smoke-tty-"));
    try {
      const fixture = join(dir, "setup.sh");
      writeFileSync(
        fixture,
        'IFS= read -r selection </dev/tty\nIFS= read -r approval </dev/tty\n[ -z "$selection" ] && [ "$approval" = y ] && [ "$SSH_AUTHORIZED_KEYS" = test-key ]\n',
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
      set -euo pipefail
      clean_env=(env -i "PATH=$PATH")
      setup_home="$1"
      setup_script="$2"
      ${runSetup}
      run_setup test-key $'\\ny\\n'
      if run_setup test-key $'\\nn\\n'; then exit 1; fi
    `,
          "bash",
          dir,
          fixture,
        ],
        { encoding: "utf8", timeout: 10000 },
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("installer SSH verification disables other identities and agents", () => {
  const script = readFileSync("scripts/container-smoke.sh", "utf8");
  const check = script.match(/^  check_ssh\(\) \{[\s\S]*?^  \}/m)?.[0];
  assert.ok(check);
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
    ${check}
    compose() { echo 127.0.0.1:2222; }
    ssh() { command ssh -G "$@"; }
    check_ssh scripts/container-smoke.sh
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^identitiesonly yes$/m);
  assert.match(result.stdout, /^identityagent none$/m);
  assert.deepEqual(result.stdout.match(/^identityfile .*$/gm), [
    "identityfile scripts/container-smoke.sh",
  ]);
});

test("runtime verification fails when npm list fails", () => {
  const script = readFileSync("scripts/container-smoke.sh", "utf8");
  const verify = script.match(/^verify_runtime\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(verify);
  const result = spawnSync(
    "bash",
    [
      "-c",
      `
    ${verify}
    expected_pi=expected
    export PI_SELF_UPDATE_COMMAND='/usr/local/bin/pi-container-update {version}'
    remote() {
      sh -c 'pi() { echo expected; }; readlink() { echo /usr/local/bin/pi; }; mkdir() { [ "$2" = /test/npm-root ]; }; npm() { if [ "$1" = root ]; then echo /test/npm-root; else return 42; fi; }; '"$1"
    }
    verify_runtime
  `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 42);
  assert.match(result.stdout, /stage: runtime Pi/);
  assert.doesNotMatch(result.stdout, /stage: runtime npm/);
});
