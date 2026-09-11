import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CHECK_TIMEOUT_MS = 120_000;
const TERM_GRACE_MS = 1_000;
const GROUP_GONE_TIMEOUT_MS = 5_000;
const GROUP_POLL_MS = 25;
const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const testRunnerArgs = [
  "--experimental-test-module-mocks",
  "--import=./scripts/test-env.mjs",
  "--test",
];

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

async function waitForGroupGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      if (!groupExists(pid)) return true;
    } catch {
      return false;
    }
    await sleep(GROUP_POLL_MS);
  }
  return false;
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function terminateGroup(pid) {
  let termSent = false;
  let killSent = false;
  let groupGone = false;
  let cleanupError;
  try {
    termSent = signalGroup(pid, "SIGTERM");
    groupGone = await waitForGroupGone(pid, TERM_GRACE_MS);
    if (!groupGone) {
      killSent = signalGroup(pid, "SIGKILL");
      groupGone = await waitForGroupGone(pid, GROUP_GONE_TIMEOUT_MS);
    }
  } catch (error) {
    cleanupError = error instanceof Error ? error.message : String(error);
  }
  return { termSent, killSent, groupGone, cleanupError };
}

async function awaitClose(closePromise) {
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(undefined), GROUP_GONE_TIMEOUT_MS);
  });
  const result = await Promise.race([closePromise, timeout]);
  clearTimeout(timer);
  return result;
}

export async function runTestRunner(args, deadline, label = "tests") {
  if (process.platform === "win32")
    return {
      ok: false,
      kind: "unsupported-platform",
      label,
      diagnostic: "check: POSIX process groups are required",
    };
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
      detached: true,
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
      ? await terminateGroup(pid)
      : {
          termSent: false,
          killSent: false,
          groupGone: true,
          cleanupError: undefined,
        };
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
    const groupRemains = (() => {
      try {
        return groupExists(child.pid);
      } catch {
        return true;
      }
    })();
    if (groupRemains) {
      const cleanup = await terminateGroup(child.pid);
      return {
        ok: false,
        kind: cleanup.groupGone
          ? "leaked-process-group"
          : "leaked-process-group-cleanup-failed",
        label,
        pid: child.pid,
        ...cleanup,
        close,
        diagnostic: cleanup.groupGone
          ? `check: ${label} left descendants in process group ${child.pid}`
          : `check: process group ${child.pid} did not disappear after leaked descendant cleanup`,
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
      sleep(GROUP_GONE_TIMEOUT_MS).then(() => undefined),
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
    const cleanup = await terminateGroup(pid);
    const close = await awaitClose(closePromise);
    const cleanupComplete = cleanup.groupGone && close !== undefined;
    return {
      ok: false,
      kind: cleanupComplete ? "suite-timeout" : "suite-timeout-cleanup-failed",
      label,
      pid,
      timedOut: true,
      ...cleanup,
      close,
      diagnostic: !cleanup.groupGone
        ? `check: process group ${pid} did not disappear after forced termination`
        : close === undefined
          ? `check: ${label} did not close after forced termination`
          : `check: suite deadline exceeded while running ${label}`,
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
    const cleanup = await terminateGroup(pid);
    const close = await awaitClose(closePromise);
    const cleanupComplete = cleanup.groupGone && close !== undefined;
    return {
      ok: false,
      kind: cleanupComplete ? "suite-timeout" : "suite-timeout-cleanup-failed",
      label,
      pid,
      timedOut: true,
      ...cleanup,
      close,
      diagnostic: !cleanup.groupGone
        ? `check: process group ${pid} did not disappear after forced termination`
        : close === undefined
          ? `check: ${label} did not close after forced termination`
          : `check: suite deadline exceeded while running ${label}`,
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
        result.groupGone
          ? "check: timed-out test runner did not close"
          : `check: process group ${result.pid} could not be reaped`,
      );
    process.exitCode = 1;
  }
}
