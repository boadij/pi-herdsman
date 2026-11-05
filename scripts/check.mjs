import { execFile, spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CHECK_TIMEOUT_MS =
  process.platform === "win32" ? 360_000 : 240_000;
const TERM_GRACE_MS = 1_000;
const TASKKILL_TIMEOUT_MS = 1_000;
const TREE_GONE_TIMEOUT_MS = 5_000;
const TREE_POLL_MS = 25;
const WORKER_SNAPSHOT_TIMEOUT_MS = 5_000;
const WORKER_SNAPSHOT_AT_MS = 215_000;
const SNAPSHOT_CANCEL_TIMEOUT_MS =
  2 * TASKKILL_TIMEOUT_MS + TREE_GONE_TIMEOUT_MS + 2 * TERM_GRACE_MS;
const isWindows = process.platform === "win32";
const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const testRunnerArgs = [
  "--experimental-test-module-mocks",
  "--import=./scripts/test-env.mjs",
  "--test",
];

function processTreeExists(pid) {
  try {
    process.kill(isWindows ? pid : -pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function waitForTreeGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      if (!processTreeExists(pid)) return true;
    } catch (error) {
      // macOS can briefly report EPERM while a killed process group is
      // disappearing; keep polling so the later ESRCH probe proves it gone.
      if (error?.code !== "EPERM") return false;
    }
    await sleep(TREE_POLL_MS);
  }
  return false;
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function terminateWindowsProcessTree(pid) {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
      (error) => (error ? reject(error) : resolvePromise()),
    );
  });
}

// Only accept complete command-line arguments that resolve to existing test files.
export function windowsTestFile(command) {
  const files = new Set();
  for (const match of command.matchAll(
    /(?:^|\s)(?:"([^"\r\n]+)"|([^\s"]+))(?=\s|$)/g,
  )) {
    const argument = match[1] ?? match[2];
    if (!/\.test\.(?:[cm]?[jt]s)$/i.test(argument)) continue;
    try {
      const root = realpathSync(repoRoot);
      const file = realpathSync(resolve(root, argument));
      const name = relative(root, file).split(sep).join("/");
      if (
        /^(?!\.\.?\/)[a-z0-9_./-]+\.test\.(?:[cm]?[jt]s)$/i.test(name) &&
        statSync(file).isFile()
      )
        files.add(name);
    } catch {
      // Unresolvable arguments are not evidence of a test worker.
    }
  }
  return files.size === 1 ? [...files][0] : undefined;
}

export function snapshotWindowsTestWorkers(
  pid,
  signal,
  execFileImpl = execFile,
  terminateTree = terminateProcessTree,
) {
  const unavailable = "check: Windows timeout snapshot unavailable";
  const script = `
$ErrorActionPreference = 'Stop'
$runnerPid = ${pid}
$all = @(Get-CimInstance -Query 'SELECT ProcessId, ParentProcessId, Name, CommandLine, CreationDate FROM Win32_Process')
$runner = @($all | Where-Object { $_.ProcessId -eq $runnerPid })
if ($runner.Count -ne 1 -or $null -eq $runner[0].CreationDate) { throw 'runner unavailable' }
$queue = [System.Collections.Generic.Queue[object]]::new()
$queue.Enqueue($runner[0])
$seen = [System.Collections.Generic.HashSet[int]]::new()
[void]$seen.Add($runnerPid)
$rows = [System.Collections.Generic.List[object]]::new()
$truncated = $false
$repoRoot = [System.IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\') + '\'
function Resolve-TestFile($command) {
  $files = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($match in [regex]::Matches($command, '(?:^|\\s)(?:"([^"\\r\\n]+)"|([^\\s"]+))(?=\\s|$)')) {
    $argument = if ($match.Groups[1].Success) { $match.Groups[1].Value } else { $match.Groups[2].Value }
    if ($argument -notmatch '\\.test\\.(?:[cm]?[jt]s)$') { continue }
    try {
      $candidate = if ([System.IO.Path]::IsPathRooted($argument)) { $argument } else { Join-Path $repoRoot $argument }
      $resolved = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
      if (-not $resolved.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
      $name = $resolved.Substring($repoRoot.Length).Replace('\', '/')
      if ($name -match '^(?!\\.\\.?/)[a-z0-9_./-]+\\.test\\.(?:[cm]?[jt]s)$' -and -not (Get-Item -LiteralPath $resolved).PSIsContainer) {
        [void]$files.Add($name)
      }
    } catch {
      # Unresolvable command-line arguments are not test-file evidence.
    }
  }
  if ($files.Count -eq 1) { return @($files)[0] }
  return $null
}
while ($queue.Count -gt 0) {
  $parent = $queue.Dequeue()
  foreach ($process in $all) {
    if ($process.ParentProcessId -ne $parent.ProcessId -or $seen.Contains([int]$process.ProcessId)) { continue }
    if ($null -eq $process.CreationDate -or $process.CreationDate -lt $parent.CreationDate) { throw 'ancestry unavailable' }
    if ($rows.Count -ge 24) { $truncated = $true; continue }
    [void]$seen.Add([int]$process.ProcessId)
    $queue.Enqueue($process)
    $node = ($parent.ProcessId -eq $runnerPid -and $process.Name -ieq 'node.exe')
    $file = if ($node -and $null -ne $process.CommandLine) { Resolve-TestFile ([string]$process.CommandLine) } else { $null }
    $rows.Add([pscustomobject]@{ node = $node; file = $file })
  }
}

if (-not (Get-Process -Id $runnerPid -ErrorAction SilentlyContinue)) { throw 'runner exited' }
ConvertTo-Json -InputObject @{ rows = @($rows.ToArray()); truncated = $truncated } -Compress -Depth 3
`;
  const formatSnapshot = (error, stdout) => {
    try {
      if (error)
        return `${unavailable} (${error.killed ? "deadline" : "process error"})`;
      const snapshot = JSON.parse(stdout);
      if (
        !Array.isArray(snapshot.rows) ||
        snapshot.rows.length > 24 ||
        typeof snapshot.truncated !== "boolean"
      )
        throw new Error();
      const lines = ["check: Windows timeout snapshot"];
      let unattributedNodeWorkers = 0;
      let otherDescendants = 0;
      for (const row of snapshot.rows) {
        if (
          typeof row.node !== "boolean" ||
          (row.file !== null && typeof row.file !== "string")
        )
          throw new Error();
        const file =
          row.node && row.file ? windowsTestFile(row.file) : undefined;
        if (file) lines.push(`check: candidate test worker file=${file}`);
        else if (row.node) unattributedNodeWorkers++;
        else otherDescendants++;
      }
      lines.push(`check: unattributed node workers=${unattributedNodeWorkers}`);
      lines.push(`check: other descendants=${otherDescendants}`);
      lines.push(`check: snapshot truncated=${snapshot.truncated}`);
      return lines.join("\n");
    } catch {
      return `${unavailable} (invalid snapshot)`;
    }
  };
  let child;
  let closeResolve;
  const closePromise = new Promise((resolvePromise) => {
    closeResolve = resolvePromise;
  });
  const promise = new Promise((resolvePromise) => {
    let callbackResult;
    let callbackFinished = false;
    let processClosed = false;
    const settleCapture = () => {
      if (callbackFinished && processClosed) resolvePromise(callbackResult);
    };
    try {
      child = execFileImpl(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          cwd: repoRoot,
          windowsHide: true,
          timeout: WORKER_SNAPSHOT_TIMEOUT_MS,
          maxBuffer: 32 * 1024,
          signal,
        },
        (error, stdout) => {
          callbackResult = formatSnapshot(error, stdout);
          callbackFinished = true;
          settleCapture();
        },
      );
      child.once("close", () => {
        processClosed = true;
        closeResolve();
        settleCapture();
      });
      child.once("error", () => {
        if (!child.pid) {
          processClosed = true;
          closeResolve();
          settleCapture();
        }
      });
    } catch {
      closeResolve();
      resolvePromise(`${unavailable} (process error)`);
    }
  });
  const waitForCaptureClose = async (timeoutMs) => {
    let timeoutId;
    try {
      return await Promise.race([
        closePromise.then(() => true),
        new Promise((resolvePromise) => {
          timeoutId = setTimeout(() => resolvePromise(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }
  };
  return {
    promise,
    cancelAndWait: async () => {
      if (!child?.pid) return waitForCaptureClose(TASKKILL_TIMEOUT_MS);
      try {
        child.kill();
      } catch {
        // The forced tree termination below is the fallback.
      }
      if (await waitForCaptureClose(TASKKILL_TIMEOUT_MS)) return true;
      await terminateTree(child.pid);
      return waitForCaptureClose(TASKKILL_TIMEOUT_MS);
    },
  };
}

async function snapshotWindowsTestWorkersBeforeTermination(
  pid,
  closePromise,
  snapshot,
) {
  const controller = new AbortController();
  let timeoutId;
  let capture;
  try {
    capture = snapshot(pid, controller.signal);
  } catch (error) {
    capture = Promise.reject(error);
  }
  const snapshotValue =
    capture && typeof capture === "object" && "promise" in capture
      ? capture.promise
      : capture;
  const snapshotPromise = Promise.resolve()
    .then(() => snapshotValue)
    .then(
      (workerDiagnostic) => ({ workerDiagnostic }),
      () => ({
        workerDiagnostic: "check: Windows timeout snapshot unavailable",
      }),
    );
  try {
    const result = await Promise.race([
      snapshotPromise.then((snapshotResult) => ({
        kind: "snapshot",
        workerDiagnostic: snapshotResult.workerDiagnostic,
      })),
      closePromise.then(() => ({
        kind: "runner-exited",
        workerDiagnostic:
          "check: Windows timeout snapshot unavailable (runner exited)",
      })),
      new Promise((resolvePromise) => {
        timeoutId = setTimeout(
          () =>
            resolvePromise({
              kind: "capture-timeout",
              workerDiagnostic:
                "check: Windows timeout snapshot unavailable (capture deadline)",
            }),
          WORKER_SNAPSHOT_TIMEOUT_MS,
        );
      }),
    ]);
    let workerDiagnostic = result.workerDiagnostic;
    if (result.kind !== "snapshot") {
      controller.abort();
      if (
        capture &&
        typeof capture === "object" &&
        "cancelAndWait" in capture &&
        typeof capture.cancelAndWait === "function"
      ) {
        let cancelTimeoutId;
        const stopped = await Promise.race([
          Promise.resolve()
            .then(() => capture.cancelAndWait())
            .then(Boolean, () => false),
          new Promise((resolvePromise) => {
            cancelTimeoutId = setTimeout(
              () => resolvePromise(false),
              SNAPSHOT_CANCEL_TIMEOUT_MS,
            );
          }),
        ]).finally(() => clearTimeout(cancelTimeoutId));
        if (!stopped)
          workerDiagnostic =
            "check: Windows timeout snapshot unavailable (capture stop unconfirmed)";
      }
    }
    return workerDiagnostic;
  } finally {
    clearTimeout(timeoutId);
    controller.abort();
  }
}

function isAlreadyGoneTaskkillError(error) {
  return (
    error?.code === 128 &&
    /(?:not found|no running instance|does not exist)/i.test(
      `${error.message ?? ""}\n${error.stderr ?? ""}`,
    )
  );
}

async function terminateProcessTree(pid) {
  if (isWindows) {
    let forceSent = false;
    let runnerGone = false;
    let cleanupError;
    try {
      await terminateWindowsProcessTree(pid);
      forceSent = true;
      runnerGone = await waitForTreeGone(pid, TREE_GONE_TIMEOUT_MS);
    } catch (error) {
      runnerGone = await waitForTreeGone(pid, TREE_GONE_TIMEOUT_MS);
      if (!runnerGone || !isAlreadyGoneTaskkillError(error))
        cleanupError = error instanceof Error ? error.message : String(error);
    }
    return { forceSent, runnerGone, treeGone: undefined, cleanupError };
  }
  let termSent = false;
  let killSent = false;
  let treeGone = false;
  let cleanupError;
  try {
    termSent = signalProcessGroup(pid, "SIGTERM");
    treeGone = await waitForTreeGone(pid, TERM_GRACE_MS);
    if (!treeGone) {
      killSent = signalProcessGroup(pid, "SIGKILL");
      treeGone = await waitForTreeGone(pid, TREE_GONE_TIMEOUT_MS);
    }
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error);
  }
  return { termSent, killSent, treeGone, cleanupError };
}

function noProcessTreeCleanup() {
  return isWindows
    ? { forceSent: false, treeGone: true, cleanupError: undefined }
    : {
        termSent: false,
        killSent: false,
        treeGone: true,
        cleanupError: undefined,
      };
}

function timeoutDiagnostic(label, pid, cleanup, close) {
  const unverified = isWindows ? "; Windows descendant cleanup unverified" : "";
  if (cleanup.cleanupError)
    return `check: process tree ${pid} cleanup failed: ${cleanup.cleanupError}${unverified}`;
  if (!(isWindows ? cleanup.runnerGone : cleanup.treeGone))
    return `check: ${isWindows ? "runner" : "process tree"} ${pid} did not disappear after forced termination${unverified}`;
  if (close === undefined)
    return `check: ${label} did not close after forced termination${unverified}`;
  return `check: suite deadline exceeded while running ${label}${unverified}`;
}

async function awaitClose(closePromise) {
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(undefined), TREE_GONE_TIMEOUT_MS);
  });
  const result = await Promise.race([closePromise, timeout]);
  clearTimeout(timer);
  return result;
}

export async function runTestRunner(
  args,
  deadline,
  label = "tests",
  snapshot = isWindows ? snapshotWindowsTestWorkers : undefined,
  stdio = "inherit",
  diagnosticOptions = {},
) {
  const deferredDeadline = deadline !== null && typeof deadline === "object";
  if (!deferredDeadline && deadline - Date.now() <= 0)
    return {
      ok: false,
      kind: "suite-timeout",
      label,
      diagnostic: "check: suite deadline exceeded before tests started",
    };

  let child;
  try {
    child = spawn(process.execPath, args, {
      cwd: repoRoot,
      ...(isWindows ? { windowsHide: true } : { detached: true }),
      stdio,
    });
  } catch (error) {
    return {
      ok: false,
      kind: "spawn-failed",
      label,
      diagnostic: `check: could not start ${label}: ${error}`,
    };
  }
  const closePromise = new Promise((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ code, signal }));
  });
  const lifecyclePromise = new Promise((resolveLifecycle) => {
    let settled = false;
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        resolveLifecycle({ error });
      }
    });
    child.once("close", (code, signal) => {
      if (!settled) {
        settled = true;
        resolveLifecycle({ close: { code, signal } });
      }
    });
  });

  const spawnFailure = async (error) => {
    const pid = child.pid;
    const cleanup = pid
      ? await terminateProcessTree(pid)
      : noProcessTreeCleanup();
    const close = await awaitClose(closePromise);
    return {
      ok: false,
      kind: "spawn-failed",
      label,
      ...(pid ? { pid } : {}),
      ...cleanup,
      close,
      diagnostic: error
        ? `check: could not start ${label}: ${error}`
        : close === undefined
          ? `check: ${label} did not provide a process id or close`
          : `check: ${label} did not provide a process id`,
    };
  };

  const finishClosed = async (close) => {
    clearTimeout(snapshotTimer);
    if (closeCapture)
      await Promise.race([closeCapture, sleep(SNAPSHOT_CANCEL_TIMEOUT_MS)]);
    // ponytail: post-parent Windows descendant accounting needs a Job Object;
    // timeout-tree cleanup is attempted, but a Job Object is not implemented.
    const treeRemains = isWindows
      ? false
      : (() => {
          try {
            return processTreeExists(child.pid);
          } catch {
            return true;
          }
        })();
    if (treeRemains) {
      const cleanup = await terminateProcessTree(child.pid);
      return {
        ok: false,
        kind: cleanup.treeGone
          ? "leaked-process-tree"
          : "leaked-process-tree-cleanup-failed",
        label,
        pid: child.pid,
        ...cleanup,
        close,
        diagnostic: cleanup.treeGone
          ? `check: ${label} left descendants in process tree ${child.pid}`
          : `check: process tree ${child.pid} did not disappear after leaked descendant cleanup`,
      };
    }
    if (close.code === 0) return { ok: true, label, pid: child.pid, close };
    return {
      ok: false,
      kind: "test-runner-failed",
      label,
      pid: child.pid,
      close,
      diagnostic: `check: ${label} exited with ${close.signal ?? `code ${close.code}`}`,
    };
  };

  if (!child.pid) {
    const lifecycle = await Promise.race([
      lifecyclePromise,
      sleep(TREE_GONE_TIMEOUT_MS).then(() => undefined),
    ]);
    return spawnFailure(lifecycle?.error);
  }

  const pid = child.pid;
  let proactiveSnapshot;
  let snapshotTimer;
  const snapshotAt = diagnosticOptions.snapshotAt ?? WORKER_SNAPSHOT_AT_MS;
  if (snapshot && Number.isFinite(snapshotAt)) {
    snapshotTimer = setTimeout(
      () => {
        const startedAt = Date.now();
        const controller = new AbortController();
        let capture;
        try {
          capture = snapshot(pid, controller.signal);
        } catch {
          capture = undefined;
        }
        const value =
          capture && typeof capture === "object" && "promise" in capture
            ? capture.promise
            : capture;
        proactiveSnapshot = Promise.resolve(value).then(
          (diagnostic) => {
            const safeDiagnostic =
              typeof diagnostic === "string"
                ? diagnostic
                : "check: Windows timeout snapshot unavailable";
            if (!runnerClosed)
              (diagnosticOptions.emit ?? console.log)(
                `check: Windows worker snapshot phase=pre-deadline elapsed=${Date.now() - startedAt}ms\n${safeDiagnostic}`,
              );
            return safeDiagnostic;
          },
          () => undefined,
        );
        proactiveSnapshot.controller = controller;
        proactiveSnapshot.capture = capture;
      },
      Math.max(0, snapshotAt),
    );
    snapshotTimer.unref?.();
  }
  let runnerClosed = false;
  let closeCapture;
  closePromise.then(() => {
    runnerClosed = true;
    clearTimeout(snapshotTimer);
    if (proactiveSnapshot) {
      proactiveSnapshot.controller.abort();
      if (proactiveSnapshot.capture?.cancelAndWait) {
        closeCapture = Promise.resolve()
          .then(() => proactiveSnapshot.capture.cancelAndWait())
          .catch(() => false);
      }
    }
  });
  const finishTimedOut = async () => {
    clearTimeout(snapshotTimer);
    const workerDiagnostic = proactiveSnapshot
      ? await snapshotWindowsTestWorkersBeforeTermination(
          pid,
          closePromise,
          () => ({
            promise: proactiveSnapshot,
            cancelAndWait: proactiveSnapshot.capture?.cancelAndWait,
          }),
        )
      : snapshot
        ? await snapshotWindowsTestWorkersBeforeTermination(
            pid,
            closePromise,
            snapshot,
          )
        : undefined;
    const cleanup = await terminateProcessTree(pid);
    const close = await awaitClose(closePromise);
    const cleanupComplete =
      cleanup.cleanupError === undefined &&
      (isWindows ? cleanup.runnerGone : cleanup.treeGone) &&
      !workerDiagnostic?.endsWith("(capture stop unconfirmed)") &&
      close !== undefined;
    const captureStopUnconfirmed = workerDiagnostic?.endsWith(
      "(capture stop unconfirmed)",
    );
    return {
      ok: false,
      kind: cleanupComplete ? "suite-timeout" : "suite-timeout-cleanup-failed",
      label,
      pid,
      timedOut: true,
      ...(captureStopUnconfirmed ? { captureStopUnconfirmed: true } : {}),
      ...cleanup,
      close,
      workerDiagnostic,
      diagnostic: `${timeoutDiagnostic(label, pid, cleanup, close)}${captureStopUnconfirmed ? "; Windows snapshot capture stop unconfirmed; suite cleanup proceeded without confirmed capture closure" : ""}`,
    };
  };
  let testDeadline;
  if (deferredDeadline) {
    try {
      const startup = await Promise.race([
        Promise.resolve(deadline).then((value) => ({ deadline: value })),
        lifecyclePromise,
      ]);
      if (startup?.error) return spawnFailure(startup.error);
      if (startup?.close) {
        return finishClosed(startup.close);
      }
      testDeadline = startup.deadline;
    } catch (error) {
      return spawnFailure(error);
    }
  } else {
    testDeadline = deadline;
  }
  const remaining = testDeadline - Date.now();
  if (remaining <= 0) {
    return finishTimedOut();
  }
  let timeoutId;
  const timeoutPromise = new Promise((resolveTimeout) => {
    timeoutId = setTimeout(() => resolveTimeout({ timedOut: true }), remaining);
  });
  const outcome = await Promise.race([lifecyclePromise, timeoutPromise]);
  if (outcome.error) {
    clearTimeout(timeoutId);
    return spawnFailure(outcome.error);
  }
  if (outcome.close) {
    clearTimeout(timeoutId);
    return finishClosed(outcome.close);
  }
  if (outcome.timedOut) {
    return finishTimedOut();
  }
  clearTimeout(timeoutId);
}

export async function runCheck(mode = "check") {
  if (mode !== "check")
    return {
      ok: false,
      kind: "usage",
      diagnostic: `check: unknown mode ${mode}`,
    };
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  return runTestRunner(testRunnerArgs, deadline);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  const result = await runCheck();
  if (!result.ok) {
    if (result.workerDiagnostic) console.error(result.workerDiagnostic);
    console.error(result.diagnostic);
    if (result.kind === "suite-timeout-cleanup-failed")
      console.error(
        result.cleanupError
          ? `check: process tree ${result.pid} cleanup failed: ${result.cleanupError}`
          : (isWindows ? result.runnerGone : result.treeGone)
            ? "check: timed-out test runner did not close"
            : `check: process tree ${result.pid} could not be reaped`,
      );
    process.exitCode = 1;
  }
}
