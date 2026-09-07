import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTestRunner } from "../scripts/check.mjs";

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForPids(path: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      const pids = JSON.parse(await readFile(path, "utf8")) as {
        parent: number;
        child: number;
      };
      if (Number.isInteger(pids.parent) && Number.isInteger(pids.child))
        return pids;
    } catch {
      // The fixture has not published its complete readiness record yet.
    }
    await sleep(10);
  }
  throw new Error(`fixture did not publish PIDs within ${timeoutMs} ms`);
}

test("check timeout kills and reaps a fixture process group", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdsman-check-runner-"));
  const pidPath = join(directory, "pids.json");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const startedAt = Date.now();
  let pids;
  const deadline = waitForPids(pidPath, 5_000).then((readyPids) => {
    pids = readyPids;
    return Date.now() + 750;
  });
  const result = await runTestRunner(
    ["scripts/check-hang.mjs", pidPath],
    deadline,
    "hanging fixture",
  );

  assert.equal(result.ok, false);
  assert.equal(result.kind, "suite-timeout");
  assert.equal(result.timedOut, true);
  assert.match(result.diagnostic, /suite deadline/);
  assert.equal(result.termSent, true);
  assert.equal(result.killSent, true);
  assert.equal(result.groupGone, true);
  assert.ok(Date.now() - startedAt < 8_000);

  for (const pid of [pids.parent, pids.child])
    assert.throws(
      () => process.kill(pid, 0),
      (error: any) => error?.code === "ESRCH",
    );
});
