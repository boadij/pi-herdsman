import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CHECK_TIMEOUT_MS,
  WORKER_SNAPSHOT_AT_MS,
  runTestRunner,
  snapshotWindowsTestWorkers,
  windowsTestFileClassifierScript,
  windowsTestFile,
} from "../scripts/check.mjs";

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 },
      (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ETIMEDOUT") reject(new Error("PowerShell timed out"));
          else if (code === "ENOENT")
            reject(new Error("PowerShell executable unavailable"));
          else reject(new Error("PowerShell execution failed"));
        } else resolvePromise(stdout.trim());
      },
    );
  });
}

function waitForChildClose(closed: Promise<void>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error("test-owned child cleanup exceeded its bound")),
      5_000,
    );
    closed.then(() => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function childIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error("test-owned child process state unavailable");
  }
}

test("check suite deadline allows extra time on Windows", () => {
  assert.equal(
    CHECK_TIMEOUT_MS,
    process.platform === "win32" ? 360_000 : 240_000,
  );
});

test("worker snapshot is scheduled 25 seconds before the suite deadline", () => {
  assert.equal(WORKER_SNAPSHOT_AT_MS, CHECK_TIMEOUT_MS - 25_000);
});

test("proactive worker snapshot is scheduled and emitted when it completes", async () => {
  let emitted = "";
  let started = false;
  const result = await runTestRunner(
    ["-e", "setTimeout(() => {}, 150)"],
    Date.now() + 1_000,
    "snapshot fixture",
    async () => {
      started = true;
      return "check: Windows worker snapshot\ncheck: unattributed node workers=1";
    },
    "ignore",
    { snapshotAt: 20, emit: (text: string) => (emitted = text) },
  );
  assert.equal(result.ok, true);
  assert.equal(started, true);
  assert.match(
    emitted,
    /^check: Windows worker snapshot phase=pre-deadline elapsed=\d+ms\n/,
  );
  assert.match(emitted, /unattributed node workers=1/);
  assert.doesNotMatch(emitted, /(?:pid|node\.exe|[A-Za-z]:\\)/i);
});

test("proactive capture is cancelled without timeout attribution when runner exits", async () => {
  let cancelled = false;
  let emitted = false;
  const result = await runTestRunner(
    ["-e", "setTimeout(() => {}, 75)"],
    Date.now() + 1_000,
    "snapshot fixture",
    (_pid: number, signal: AbortSignal) => ({
      promise: new Promise<string>((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        }),
      ),
      cancelAndWait: async () => {
        cancelled = true;
        return true;
      },
    }),
    "ignore",
    { snapshotAt: 10, emit: () => (emitted = true) },
  );
  assert.equal(result.ok, true);
  assert.equal(cancelled, true);
  assert.equal(emitted, false);
  assert.equal(result.workerDiagnostic, undefined);
});

test("suite timeout reuses the completed proactive snapshot", async () => {
  let starts = 0;
  let emitted = "";
  const result = await runTestRunner(
    ["-e", "setInterval(() => {}, 1000)"],
    Date.now() + 100,
    "snapshot fixture",
    async () => {
      starts++;
      return "check: Windows worker snapshot\ncheck: unattributed node workers=1";
    },
    "ignore",
    { snapshotAt: 10, emit: (text: string) => (emitted = text) },
  );
  assert.equal(result.kind, "suite-timeout");
  assert.equal(starts, 1);
  assert.match(emitted, /phase=pre-deadline elapsed=/);
  assert.match(result.workerDiagnostic, /unattributed node workers=1/);
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

test("Windows snapshot attribution uses the repository root outside the checkout", async (t) => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const originalCwd = process.cwd();
  const outsideDirectory = await mkdtemp(join(tmpdir(), "check-snapshot-cwd-"));
  t.after(async () => {
    process.chdir(originalCwd);
    await rm(outsideDirectory, { recursive: true, force: true });
  });

  let snapshotCwdIsRepositoryRoot = false;
  process.chdir(outsideDirectory);
  const { promise } = snapshotWindowsTestWorkers(
    1,
    new AbortController().signal,
    (
      _command: string,
      _args: string[],
      options: { cwd?: string },
      callback: (error: null, stdout: string) => void,
    ) => {
      snapshotCwdIsRepositoryRoot = options.cwd === repositoryRoot;
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 1 });
      queueMicrotask(() => {
        callback(
          null,
          JSON.stringify({
            rows: [
              {
                node: true,
                file: "extension/check-runner.test.ts",
                category: null,
              },
            ],
            truncated: false,
          }),
        );
        child.emit("close", 0, null);
      });
      return child;
    },
  );
  const workerDiagnostic = await promise;

  assert.equal(
    snapshotCwdIsRepositoryRoot,
    true,
    "snapshot runs with the configured repository root as its cwd",
  );
  assert.equal(
    workerDiagnostic,
    "check: Windows timeout snapshot\ncheck: candidate test worker file=extension/check-runner.test.ts\ncheck: unattributed node workers=0\ncheck: unattributed workers ambiguous-test-path=0\ncheck: unattributed workers command-line-unavailable=0\ncheck: unattributed workers file-uri-argument=0\ncheck: unattributed workers in-repo-path-validation-failure=0\ncheck: unattributed workers resolve-path-invalid-form=0\ncheck: unattributed workers resolve-path-not-found=0\ncheck: unattributed workers resolve-path-other-error=0\ncheck: unattributed workers resolved-outside-repo=0\ncheck: unattributed workers unrecognized-arguments=0\ncheck: other descendants=0\ncheck: snapshot truncated=false",
  );
});

test("Windows worker snapshot reports only allowlisted unattributed categories", async () => {
  const cases = [
    ["command-line-unavailable", "command-line-unavailable"],
    ["unrecognized-arguments", "unrecognized-arguments"],
    ["file-uri-argument", "file-uri-argument"],
    ["resolve-path-not-found", "resolve-path-not-found"],
    ["resolve-path-invalid-form", "resolve-path-invalid-form"],
    ["resolve-path-other-error", "resolve-path-other-error"],
    ["resolved-outside-repo", "resolved-outside-repo"],
    ["in-repo-path-validation-failure", "in-repo-path-validation-failure"],
    ["ambiguous-test-path", "ambiguous-test-path"],
  ] as const;
  for (const [category, expected] of cases) {
    const { promise } = snapshotWindowsTestWorkers(
      1,
      new AbortController().signal,
      (_command, _args, _options, callback) => {
        const child = new EventEmitter() as ChildProcess;
        Object.assign(child, { pid: 1 });
        queueMicrotask(() => {
          callback(
            null,
            JSON.stringify({
              rows: [{ node: true, file: null, category }],
              truncated: false,
            }),
          );
          child.emit("close", 0, null);
        });
        return child;
      },
    );
    const diagnostic = await promise;
    assert.match(diagnostic, new RegExp(`unattributed workers ${expected}=1`));
    assert.doesNotMatch(diagnostic, /private|[A-Za-z]:\\|node\.exe/i);
  }
});

test(
  "Windows PowerShell classifier distinguishes sanitized worker path reasons",
  { skip: process.platform !== "win32", timeout: 15_000 },
  async () => {
    const repositoryRoot = process.cwd();
    const repositoryFixtureDir = await mkdtemp(
      join(repositoryRoot, ".check-worker-reasons-"),
    );
    const outsideFixtureDir = await mkdtemp(
      join(tmpdir(), "check-worker-reasons-"),
    );
    const invalidName = join(repositoryFixtureDir, "not allowed.test.ts");
    const outsideFile = join(outsideFixtureDir, "outside.test.ts");
    await writeFile(invalidName, "");
    await writeFile(outsideFile, "");
    try {
      const quote = (value: string) => `"${value}"`;
      const inputs = [
        null,
        "node.exe --worker-mode",
        `node.exe ${quote(pathToFileURL(invalidName).href)}`,
        `node.exe ${quote(join(repositoryFixtureDir, "missing.test.ts"))}`,
        `node.exe ${quote(join(repositoryFixtureDir, "mock-invalid.test.ts"))}`,
        `node.exe ${quote(join(repositoryFixtureDir, "mock-other.test.ts"))}`,
        `node.exe ${quote(outsideFile)}`,
        `node.exe ${quote(invalidName)}`,
        `node.exe ${quote(join(repositoryRoot, "extension", "check-runner.test.ts"))} ${quote(join(repositoryRoot, "scripts", "node-target.test.mjs"))}`,
      ];
      const payload = Buffer.from(JSON.stringify(inputs), "utf16le").toString(
        "base64",
      );
      const root = Buffer.from(repositoryRoot, "utf16le").toString("base64");
      const script = `
$ErrorActionPreference = 'Stop'
$repoRoot = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${root}'))
$repoRoot += [IO.Path]::DirectorySeparatorChar
$inputs = ConvertFrom-Json ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${payload}')))
function Resolve-Path {
  [CmdletBinding()]
  param([string]$LiteralPath)
  if ($LiteralPath -like '*mock-invalid.test.ts') { Write-Error -Message 'synthetic invalid form' -Category InvalidArgument -ErrorAction Stop }
  if ($LiteralPath -like '*mock-other.test.ts') { throw [InvalidOperationException]::new('synthetic') }
  Microsoft.PowerShell.Management\\Resolve-Path @PSBoundParameters
}
${windowsTestFileClassifierScript}
$results = foreach ($inputCommand in $inputs) {
  (Resolve-TestFile ([pscustomobject]@{ CommandLine = $inputCommand }) $repoRoot).category
}
$success = Resolve-TestFile ([pscustomobject]@{ CommandLine = ('node.exe "' + (Join-Path $repoRoot 'extension/check-runner.test.ts') + '"') }) $repoRoot
ConvertTo-Json -InputObject @{ categories = @($results); file = $success.file; category = $success.category } -Compress
`;
      const result = await runPowerShell(script);
      const classification = JSON.parse(result);
      assert.deepEqual(classification.categories, [
        "command-line-unavailable",
        "unrecognized-arguments",
        "file-uri-argument",
        "resolve-path-not-found",
        "resolve-path-invalid-form",
        "resolve-path-other-error",
        "resolved-outside-repo",
        "in-repo-path-validation-failure",
        "ambiguous-test-path",
      ]);
      assert.deepEqual(
        { file: classification.file, category: classification.category },
        { file: "extension/check-runner.test.ts", category: null },
      );
      assert.doesNotMatch(result, /[A-Za-z]:\\|file:\/\/|node\.exe/i);
    } finally {
      await Promise.all([
        rm(repositoryFixtureDir, { recursive: true, force: true }),
        rm(outsideFixtureDir, { recursive: true, force: true }),
      ]);
    }
  },
);

test(
  "Windows targeted CIM query identifies and cleans its exact test child",
  { skip: process.platform !== "win32", timeout: 15_000 },
  async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore", windowsHide: true },
    );
    const closed = new Promise<void>((resolvePromise) =>
      child.once("close", () => resolvePromise()),
    );
    let pid: number | undefined;
    try {
      pid = await new Promise<number>((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("spawn", () => {
          if (child.pid === undefined)
            reject(new Error("worker PID unavailable"));
          else resolvePromise(child.pid);
        });
      });
      const script = `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId = ${pid}'; ConvertTo-Json -InputObject @{ found = ($null -ne $p); node = ($null -ne $p -and $p.Name -ieq 'node.exe'); parent = ($null -ne $p -and $p.ParentProcessId -eq ${process.pid}) } -Compress`;
      const result = await runPowerShell(script);
      assert.deepEqual(JSON.parse(result), {
        found: true,
        node: true,
        parent: true,
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await waitForChildClose(closed);
      if (pid !== undefined) assert.equal(childIsRunning(pid), false);
    }
  },
);

test("Windows worker snapshot rejects unknown categories without echoing raw fields", async () => {
  const injectedCommand = "node.exe --private-secret=do-not-print";
  const injectedPath = "C:\\private\\machine\\secret.test.ts";
  const { promise } = snapshotWindowsTestWorkers(
    1,
    new AbortController().signal,
    (_command, _args, _options, callback) => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: 1 });
      queueMicrotask(() => {
        callback(
          null,
          JSON.stringify({
            rows: [
              {
                node: true,
                file: null,
                category: "unrecognized-private-category",
                commandLine: injectedCommand,
                args: [injectedCommand],
                path: injectedPath,
              },
            ],
            truncated: false,
          }),
        );
        child.emit("close", 0, null);
      });
      return child;
    },
  );

  const diagnostic = await promise;
  assert.equal(
    diagnostic,
    "check: Windows timeout snapshot unavailable (invalid snapshot)",
  );
  for (const injectedValue of [
    "unrecognized-private-category",
    injectedCommand,
    injectedPath,
  ])
    assert.equal(diagnostic.includes(injectedValue), false);
});

test(
  "native attribution fixture",
  { skip: !process.env.CHECK_WORKER_FIXTURE },
  async () => {
    await writeFile(
      process.env.CHECK_WORKER_FIXTURE!,
      JSON.stringify({ parent: process.ppid, child: process.pid }),
    );
    setInterval(() => {}, 1_000);
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
  "runner exit wins the snapshot race and capture is awaited after abort",
  { timeout: 15_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "check-snapshot-"));
    const release = join(directory, "release");
    t.after(() => rm(directory, { recursive: true, force: true }));
    const startedAt = Date.now();
    let aborted = false;
    let snapshotSettled = false;
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
              snapshotSettled = true;
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
    assert.equal(snapshotSettled, true);
    assert.ok(Date.now() - startedAt < 10_000);
  },
);

test(
  "successful worker snapshot is retained before timeout cleanup",
  { timeout: 10_000 },
  async () => {
    let snapshotStarted = false;
    let snapshotSignal: AbortSignal | undefined;
    const result = await runTestRunner(
      ["-e", "setInterval(() => {}, 1000)"],
      Date.now() + 250,
      "hanging fixture",
      async (pid: number, signal: AbortSignal) => {
        snapshotStarted = true;
        snapshotSignal = signal;
        assert.doesNotThrow(() => process.kill(pid, 0));
        return "check: Windows timeout snapshot\ncheck: candidate test worker file=extension/check-runner.test.ts";
      },
    );
    assert.equal(snapshotStarted, true);
    assert.equal(snapshotSignal?.aborted, true);
    assert.equal(result.kind, "suite-timeout");
    assert.equal(
      result.workerDiagnostic,
      "check: Windows timeout snapshot\ncheck: candidate test worker file=extension/check-runner.test.ts",
    );
    assert.doesNotMatch(
      result.workerDiagnostic,
      /(?:^|\s)(?:pid|parent)=|[A-Za-z]:\\|node\.exe/i,
    );
    assert.throws(
      () => process.kill(result.pid, 0),
      (error: any) => error?.code === "ESRCH",
    );
  },
);

test(
  "Windows snapshot timeout cancels and closes its real execFile child",
  { timeout: 15_000 },
  async (t) => {
    let capturePid: number | undefined;
    let captureKill: (() => boolean) | undefined;
    let captureAborted = false;
    let captureClosed = false;
    let runnerAliveWhenCaptureClosed = false;
    let closeCaptureResolve: (() => void) | undefined;
    const closeCapture = new Promise<void>((resolve) => {
      closeCaptureResolve = resolve;
    });
    t.after(async () => {
      if (capturePid && !captureClosed) {
        captureKill?.();
        let timeoutId: NodeJS.Timeout;
        try {
          await Promise.race([
            closeCapture,
            new Promise(
              (_, reject) =>
                (timeoutId = setTimeout(
                  () => reject(new Error("capture child did not close")),
                  3_000,
                )),
            ),
          ]);
        } finally {
          clearTimeout(timeoutId!);
        }
      }
      if (capturePid)
        assert.throws(
          () => process.kill(capturePid!, 0),
          (error: any) => error?.code === "ESRCH",
        );
    });
    const result = await runTestRunner(
      ["-e", "setInterval(() => {}, 1000)"],
      Date.now() + 250,
      "hanging fixture",
      (runnerPid: number, signal: AbortSignal) =>
        snapshotWindowsTestWorkers(
          runnerPid,
          signal,
          (_file, _args, options, callback) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                captureAborted = true;
              },
              { once: true },
            );
            const child = execFile(
              process.execPath,
              ["-e", "setInterval(() => {}, 1000)"],
              options,
              callback,
            );
            capturePid = child.pid;
            captureKill = child.kill.bind(child);
            child.once("close", () => {
              captureClosed = true;
              closeCaptureResolve?.();
              try {
                process.kill(runnerPid, 0);
                runnerAliveWhenCaptureClosed = true;
              } catch {
                // Snapshot child closure must precede suite-runner cleanup.
              }
            });
            return child;
          },
        ),
    );
    assert.equal(
      result.workerDiagnostic,
      "check: Windows timeout snapshot unavailable (capture deadline)",
    );
    assert.equal(captureAborted, true);
    assert.equal(captureClosed, true);
    assert.equal(runnerAliveWhenCaptureClosed, true);
    assert.ok(capturePid);
  },
);

test(
  "Windows snapshot escalates after an error without close and reports unconfirmed stop",
  { timeout: 20_000 },
  async (t) => {
    let capturePid: number | undefined;
    let captureChild: ReturnType<typeof execFile> | undefined;
    let forceKill: (() => boolean) | undefined;
    let escalationAttempted = false;
    let captureClosedResolve: (() => void) | undefined;
    const captureClosed = new Promise<void>((resolve) => {
      captureClosedResolve = resolve;
    });
    const closeCapture = async () => {
      if (capturePid && !captureChild?.killed) forceKill?.();
      if (capturePid) {
        let timeoutId: NodeJS.Timeout;
        try {
          await Promise.race([
            captureClosed,
            new Promise(
              (_, reject) =>
                (timeoutId = setTimeout(
                  () => reject(new Error("capture child did not close")),
                  3_000,
                )),
            ),
          ]);
        } finally {
          clearTimeout(timeoutId!);
        }
      }
      if (capturePid)
        assert.throws(
          () => process.kill(capturePid!, 0),
          (error: any) => error?.code === "ESRCH",
        );
    };
    t.after(closeCapture);

    const result = await runTestRunner(
      ["-e", "setInterval(() => {}, 1000)"],
      Date.now() + 250,
      "hanging fixture",
      (runnerPid: number, signal: AbortSignal) =>
        snapshotWindowsTestWorkers(
          runnerPid,
          signal,
          (_file, _args, options, callback) => {
            const child = execFile(
              process.execPath,
              ["-e", "setInterval(() => {}, 1000)"],
              options,
              callback,
            );
            captureChild = child;
            capturePid = child.pid;
            forceKill = child.kill.bind(child);
            child.kill = () => false;
            child.once("close", () => captureClosedResolve?.());
            options.signal?.addEventListener(
              "abort",
              () => child.emit("error", new Error("simulated kill failure")),
              { once: true },
            );
            return child;
          },
          async (pid) => {
            assert.equal(pid, capturePid);
            escalationAttempted = true;
          },
        ),
    );

    assert.equal(escalationAttempted, true);
    assert.equal(result.kind, "suite-timeout-cleanup-failed");
    assert.equal(result.captureStopUnconfirmed, true);
    assert.equal(
      result.workerDiagnostic,
      "check: Windows timeout snapshot unavailable (capture stop unconfirmed)",
    );
    assert.match(
      result.diagnostic,
      /suite cleanup proceeded without confirmed capture closure/,
    );
    assert.ok(capturePid);
    assert.doesNotThrow(() => process.kill(capturePid, 0));
  },
);

test(
  "timeout waits a bounded interval for the snapshot before cleanup",
  { timeout: 15_000 },
  async () => {
    let snapshotStarted = false;
    let runnerAliveAtSnapshot = false;
    let runnerAliveAtSnapshotAbort = false;
    let aborted = false;
    let snapshotSettled = false;
    const result = await runTestRunner(
      ["-e", "setInterval(() => {}, 1000)"],
      Date.now() + 250,
      "hanging fixture",
      (pid: number, signal: AbortSignal) => {
        snapshotStarted = true;
        try {
          process.kill(pid, 0);
          runnerAliveAtSnapshot = true;
        } catch {
          // The snapshot must be attempted while the test runner is available.
        }
        return new Promise<string>((resolve) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              snapshotSettled = true;
              try {
                process.kill(pid, 0);
                runnerAliveAtSnapshotAbort = true;
              } catch {
                // Cleanup must not start until the bounded snapshot attempt ends.
              }
              resolve("aborted");
            },
            { once: true },
          );
        });
      },
    );
    assert.equal(snapshotStarted, true);
    assert.equal(runnerAliveAtSnapshot, true);
    assert.equal(runnerAliveAtSnapshotAbort, true);
    assert.equal(aborted, true);
    assert.equal(snapshotSettled, true);
    assert.equal(result.kind, "suite-timeout");
    assert.equal(
      result.workerDiagnostic,
      "check: Windows timeout snapshot unavailable (capture deadline)",
    );
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
      // Its expected forced stop must not look like an incomplete outer test run.
      run = runTestRunner(
        [
          "--test",
          "--test-name-pattern=^native attribution fixture$",
          "extension/check-runner.test.ts",
        ],
        deadline,
        "native worker fixture",
        undefined,
        "ignore",
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
            "check: candidate test worker file=extension/check-runner.test.ts",
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
