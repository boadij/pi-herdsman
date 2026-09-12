import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHECK_TIMEOUT_MS = 120_000;
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

export async function runTestRunner(args, deadline, label = "tests") {
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
      diagnostic: timeoutDiagnostic(label, pid, cleanup, close),
    };
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
      diagnostic: timeoutDiagnostic(label, pid, cleanup, close),
    };
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
