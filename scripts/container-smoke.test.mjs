import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

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
    remote() {
      sh -c 'pi() { echo expected; }; readlink() { echo /opt/pi/pi; }; mkdir() { [ "$2" = /test/npm-root ]; }; npm() { if [ "$1" = root ]; then echo /test/npm-root; else return 42; fi; }; '"$1"
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
