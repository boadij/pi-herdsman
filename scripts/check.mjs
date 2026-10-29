import { execFile, spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const CHECK_TIMEOUT_MS = 240_000;
const TERM_GRACE_MS = 1_000;
const TASKKILL_TIMEOUT_MS = 1_000;
const TREE_GONE_TIMEOUT_MS = 5_000;
const TREE_POLL_MS = 25;
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

function snapshotWindowsTestWorkers(pid, signal) {
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
while ($queue.Count -gt 0) {
  $parent = $queue.Dequeue()
  foreach ($process in $all) {
    if ($process.ParentProcessId -ne $parent.ProcessId -or $seen.Contains([int]$process.ProcessId)) { continue }
    if ($null -eq $process.CreationDate -or $process.CreationDate -lt $parent.CreationDate) { throw 'ancestry unavailable' }
    if ($rows.Count -ge 24) { $truncated = $true; continue }
    [void]$seen.Add([int]$process.ProcessId)
    $queue.Enqueue($process)
    $command = ''
    if ($parent.ProcessId -eq $runnerPid -and $process.Name -ieq 'node.exe') {
      if ($null -eq $process.CommandLine) { throw 'command unavailable' }
      $command = [string]$process.CommandLine
    }
    $rows.Add([pscustomobject]@{ pid = [int]$process.ProcessId; parent = [int]$parent.ProcessId; node = ($parent.ProcessId -eq $runnerPid -and $process.Name -ieq 'node.exe'); command = $command })
  }
}
if (-not (Get-Process -Id $runnerPid -ErrorAction SilentlyContinue)) { throw 'runner exited' }
ConvertTo-Json -InputObject @{ rows = @($rows.ToArray()); truncated = $truncated } -Compress -Depth 3
`;
  return new Promise((resolvePromise) => {
    try {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024, signal },
        (error, stdout) => {
          try {
            if (error)
              return resolvePromise(
                `${unavailable} (${error.killed ? "deadline" : "process error"})`,
              );
            const snapshot = JSON.parse(stdout);
            if (
              !Array.isArray(snapshot.rows) ||
              snapshot.rows.length > 24 ||
              typeof snapshot.truncated !== "boolean"
            )
              throw new Error();
            const lines = ["check: Windows timeout snapshot"];
            for (const row of snapshot.rows) {
              if (
                !Number.isSafeInteger(row.pid) ||
                row.pid <= 0 ||
                !Number.isSafeInteger(row.parent) ||
                row.parent <= 0 ||
                typeof row.node !== "boolean" ||
                typeof row.command !== "string"
              )
                throw new Error();
              const file =
                row.node && row.parent === pid
                  ? windowsTestFile(row.command)
                  : undefined;
              lines.push(
                file
                  ? `check: candidate test worker pid=${row.pid} file=${file}`
                  : `check: descendant pid=${row.pid} parent=${row.parent} type=other`,
              );
            }
            lines.push(`check: snapshot truncated=${snapshot.truncated}`);
            resolvePromise(lines.join("\n"));
          } catch {
            resolvePromise(`${unavailable} (invalid snapshot)`);
          }
        },
      );
    } catch {
      resolvePromise(`${unavailable} (process error)`);
    }
  });
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
    let treeGone = false;
    let cleanupError;
    try {
      await terminateWindowsProcessTree(pid);
      forceSent = true;
      treeGone = await waitForTreeGone(pid, TREE_GONE_TIMEOUT_MS);
    } catch (error) {
      treeGone = await waitForTreeGone(pid, TREE_GONE_TIMEOUT_MS);
      if (!treeGone || !isAlreadyGoneTaskkillError(error))
        cleanupError = error instanceof Error ? error.message : String(error);
    }
    return { forceSent, treeGone, cleanupError };
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
  if (cleanup.cleanupError)
    return `check: process tree ${pid} cleanup failed: ${cleanup.cleanupError}`;
  if (!cleanup.treeGone)
    return `check: process tree ${pid} did not disappear after forced termination`;
  if (close === undefined)
    return `check: ${label} did not close after forced termination`;
  return `check: suite deadline exceeded while running ${label}`;
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
      stdio: "inherit",
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
    // ponytail: post-parent Windows descendant accounting needs a Job Object;
    // timeout-tree cleanup is covered, but a Job Object is not implemented.
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
  const finishTimedOut = async () => {
    let workerDiagnostic;
    if (snapshot) {
      const controller = new AbortController();
      try {
        workerDiagnostic = await Promise.race([
          snapshot(pid, controller.signal),
          closePromise.then(
            () => "check: Windows timeout snapshot unavailable (runner exited)",
          ),
        ]);
      } catch {
        workerDiagnostic = "check: Windows timeout snapshot unavailable";
      } finally {
        controller.abort();
      }
    }
    const cleanup = await terminateProcessTree(pid);
    const close = await awaitClose(closePromise);
    const cleanupComplete =
      cleanup.cleanupError === undefined &&
      cleanup.treeGone &&
      close !== undefined;
    return {
      ok: false,
      kind: cleanupComplete ? "suite-timeout" : "suite-timeout-cleanup-failed",
      label,
      pid,
      timedOut: true,
      ...cleanup,
      close,
      workerDiagnostic,
      diagnostic: timeoutDiagnostic(label, pid, cleanup, close),
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
          : result.treeGone
            ? "check: timed-out test runner did not close"
            : `check: process tree ${result.pid} could not be reaped`,
      );
    process.exitCode = 1;
  }
}
