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
  { timeout: 42_500 },
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
    assert.equal(
      result.treeGone,
      process.platform === "win32" ? undefined : true,
    );
    if (process.platform === "win32") {
      assert.equal(result.runnerGone, true);
      assert.match(result.diagnostic, /descendant cleanup unverified/);
      assert.doesNotMatch(result.workerDiagnostic, /[A-Za-z]:\\|node\.exe/i);
    } else {
      assert.equal(result.workerDiagnostic, undefined);
    }
    assert.ok(Date.now() - startedAt < 38_000);

    for (const pid of [pids.parent, pids.child])
      assert.throws(
        () => process.kill(pid, 0),
        (error: any) => error?.code === "ESRCH",
      );
  },
);

test(
  "snapshot failures do not bypass timeout cleanup",
  { timeout: 15_000 },
  async () => {
    for (const snapshot of [
      () => Promise.reject(new Error("private snapshot error")),
      () => {
        throw new Error("private snapshot error");
      },
    ]) {
      const result = await runTestRunner(
        ["-e", "setInterval(() => {}, 1000)"],
        Date.now() + 250,
        "hanging fixture",
        snapshot,
      );
      assert.equal(result.kind, "suite-timeout");
      assert.equal(
        result.treeGone,
        process.platform === "win32" ? undefined : true,
      );
      assert.equal(
        result.workerDiagnostic,
        "check: Windows timeout snapshot unavailable",
      );
      assert.throws(
        () => process.kill(result.pid, 0),
        (error: any) => error?.code === "ESRCH",
      );
    }
  },
);

test(
  "Windows timeout stops waiting for a snapshot when the runner exits",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "check-snapshot-"));
    const release = join(directory, "release");
    t.after(() => rm(directory, { recursive: true, force: true }));
    const startedAt = Date.now();
    let aborted = false;
    const result = await runTestRunner(
      [
        "-e",
        "const fs = require('node:fs'); const timer = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(timer); }, 10)",
        release,
      ],
      Date.now() + 250,
      "exiting fixture",
      async (_pid: number, signal: AbortSignal) => {
        const pending = new Promise<string>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve("aborted");
            },
            { once: true },
          );
        });
        await writeFile(release, "");
        return pending;
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.kind, "suite-timeout");
    assert.equal(result.timedOut, true);
    assert.equal(
      result.treeGone,
      process.platform === "win32" ? undefined : true,
    );
    assert.equal(
      result.workerDiagnostic,
      "check: Windows timeout snapshot unavailable (runner exited)",
    );
    assert.equal(aborted, true);
    assert.ok(Date.now() - startedAt < 10_000);
  },
);

test(
  "cleanup starts before a slow snapshot completes",
  { timeout: 15_000 },
  async () => {
    let snapshotStarted = false;
    let aborted = false;
    const result = await runTestRunner(
      ["-e", "setInterval(() => {}, 1000)"],
      Date.now() + 250,
      "hanging fixture",
      (_pid: number, signal: AbortSignal) => {
        snapshotStarted = true;
        return new Promise<string>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve("aborted");
            },
            { once: true },
          );
        });
      },
    );
    assert.equal(snapshotStarted, true);
    assert.equal(aborted, true);
    assert.equal(result.kind, "suite-timeout");
    assert.throws(
      () => process.kill(result.pid, 0),
      (error: any) => error?.code === "ESRCH",
    );
  },
);

test(
  "Windows detached survivor is not reported as verified cleanup",
  { timeout: 45_000, skip: process.platform !== "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "check-detached-"));
    const pidPath = join(directory, "pids.json");
    t.after(() => rm(directory, { recursive: true, force: true }));
    let pids: { parent: number; child: number } | undefined;
    try {
      const deadline = waitForPids(pidPath, 5_000).then((ready) => {
        pids = ready;
        process.kill(ready.parent);
        return Date.now() - 1;
      });
      // shortcut: an unpublished detached child lives at most 60 seconds; use a release mechanism if that bound is too long.
      const result = await runTestRunner(
        [
          "-e",
          "const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{detached:true,stdio:'ignore'}); c.unref(); fs.writeFileSync(process.argv[1]+'.tmp',JSON.stringify({parent:process.pid,child:c.pid})); fs.renameSync(process.argv[1]+'.tmp',process.argv[1]); setInterval(()=>{},1000)",
          pidPath,
        ],
        deadline,
        "detached fixture",
      );
      assert.ok(pids);
      process.kill(pids.child, 0);
      assert.equal(result.treeGone, undefined);
      assert.match(result.diagnostic, /descendant cleanup unverified/);
    } finally {
      if (pids) {
        try {
          process.kill(pids.child);
        } catch (error: any) {
          if (error?.code !== "ESRCH") throw error;
        }
        const until = Date.now() + 5_000;
        while (true) {
          try {
            process.kill(pids.child, 0);
          } catch (error: any) {
            if (error?.code === "ESRCH") break;
            throw error;
          }
          assert.ok(Date.now() < until, "detached fixture child did not exit");
          await sleep(25);
        }
      }
    }
  },
);

test(
  "timeout attempts native test-file worker attribution on Windows",
  { timeout: 42_500 },
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
    assert.equal(
      result.treeGone,
      process.platform === "win32" ? undefined : true,
    );
    if (process.platform === "win32") {
      assert.match(result.workerDiagnostic, /Windows timeout snapshot/);
      assert.doesNotMatch(result.workerDiagnostic, /[A-Za-z]:\\|node\.exe/i);
      for (const line of result.workerDiagnostic.split("\n")) {
        if (line.startsWith("check: candidate test worker "))
          assert.equal(
            line,
            `check: candidate test worker pid=${pids.child} file=extension/check-runner.test.ts`,
          );
      }
    } else {
      assert.equal(result.workerDiagnostic, undefined);
    }
    assert.throws(
      () => process.kill(pids.child, 0),
      (error: any) => error?.code === "ESRCH",
    );
  },
);
