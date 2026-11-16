import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("test preload isolates inherited model restoration", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import=./scripts/test-env.mjs",
      "--input-type=module",
      "-e",
      `
        import assert from "node:assert/strict";
        assert.equal(process.env.PI_HERDSMAN_RESTORE_MODEL, undefined);
        process.env.PI_HERDSMAN_RESTORE_MODEL = "saved-session";
        assert.equal(process.env.PI_HERDSMAN_RESTORE_MODEL, "saved-session");
      `,
    ],
    {
      env: {
        ...process.env,
        PI_HERDSMAN_RESTORE_MODEL: "saved-session",
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
});
