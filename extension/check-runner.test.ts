import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CHECK_TIMEOUT_MS,
  runTestRunner,
  windowsTestFile,
} from "../scripts/check.mjs";

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

test("check suite deadline allows 240 seconds", () => {
  assert.equal(CHECK_TIMEOUT_MS, 240_000);
});

test("Windows worker attribution accepts only existing repository test paths", () => {
  const file = join(process.cwd(), "extension", "check-runner.test.ts");
  assert.equal(
    windowsTestFile(`"C:\\Program Files\\node.exe" "${file}"`),
    "extension/check-runner.test.ts",
  );
  assert.equal(windowsTestFile('node.exe "not-a-real.test.ts"'), undefined);
  assert.equal(windowsTestFile(`node.exe --file="${file}"`), undefined);
});

test(
  "native attribution fixture",
  { skip: !process.env.CHECK_WORKER_FIXTURE },
  async () => {
    await writeFile(
      process.env.CHECK_WORKER_FIXTURE!,
      JSON.stringify({ parent: process.ppid, child: process.pid }),
    );
    await new Promise(() => setInterval(() => {}, 1_000));
  },
);

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

test(
  "check timeout kills and reaps the fixture process tree",
  { timeout: 17_500 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "pi-herdsman-check-runner-"),
    );
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
    assert.equal(result.treeGone, true);
    if (process.platform === "win32") {
      assert.match(result.workerDiagnostic, new RegExp(`\\b${pids.child}\\b`));
      assert.doesNotMatch(result.workerDiagnostic, /[A-Za-z]:\\|node\.exe/i);
    } else {
      assert.equal(result.workerDiagnostic, undefined);
    }
    assert.ok(Date.now() - startedAt < 13_000);

    for (const pid of [pids.parent, pids.child])
      assert.throws(
        () => process.kill(pid, 0),
        (error: any) => error?.code === "ESRCH",
      );
  },
);

test(
  "timeout attributes a native test-file worker on Windows",
  { timeout: 17_500 },
  async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), "pi-herdsman-check-worker-"),
    );
    const pidPath = join(directory, "pids.json");
    t.after(() => rm(directory, { recursive: true, force: true }));
    let pids;
    const deadline = waitForPids(pidPath, 5_000).then((ready) => {
      pids = ready;
      return Date.now() + 750;
    });
    const previousFixture = process.env.CHECK_WORKER_FIXTURE;
    const testContext = process.env.NODE_TEST_CONTEXT;
    process.env.CHECK_WORKER_FIXTURE = pidPath;
    // The nested runner must start outside the parent node:test worker context.
    delete process.env.NODE_TEST_CONTEXT;
    let run;
    try {
      run = runTestRunner(
        [
          "--test",
          "--test-name-pattern=^native attribution fixture$",
          "extension/check-runner.test.ts",
        ],
        deadline,
        "native worker fixture",
      );
    } finally {
      if (previousFixture === undefined)
        delete process.env.CHECK_WORKER_FIXTURE;
      else process.env.CHECK_WORKER_FIXTURE = previousFixture;
      if (testContext !== undefined)
        process.env.NODE_TEST_CONTEXT = testContext;
    }
    const result = await run;
    assert.equal(result.kind, "suite-timeout");
    assert.equal(result.treeGone, true);
    if (process.platform === "win32") {
      assert.match(
        result.workerDiagnostic,
        new RegExp(
          `candidate test worker pid=${pids.child} file=extension/check-runner\\.test\\.ts`,
        ),
      );
      assert.doesNotMatch(result.workerDiagnostic, /[A-Za-z]:\\|node\.exe/i);
    } else {
      assert.equal(result.workerDiagnostic, undefined);
    }
    assert.throws(
      () => process.kill(pids.child, 0),
      (error: any) => error?.code === "ESRCH",
    );
  },
);
