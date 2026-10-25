import { deepEqual, equal, throws } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  acquireProcessLock,
  claimProcessLock,
  ProcessLockOccupiedError,
  readLiveProcessLock,
  readProcessLockStatus,
} from "./lock.ts";

const metadataNames = [".DS_Store", "desktop.ini", "Thumbs.db", ".directory"];

function temporaryPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-herdsman-lock-")), "lock");
}

test("claim wrapper publishes a complete claim and releases exactly", () => {
  const path = temporaryPath();
  try {
    const release = claimProcessLock(path);
    assertOccupied(path);
    equal(readdirSync(path).length, 1);
    release();
    throws(() => readdirSync(path), { code: "ENOENT" });
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("interrupted release does not strand the canonical lock", (t) => {
  const path = temporaryPath();
  const release = claimProcessLock(path);
  const originalRmdir = fs.rmdirSync;
  t.mock.method(fs, "rmdirSync", (directory: string) => {
    if (directory === path || directory.endsWith(".released"))
      throw new Error("simulated release interruption");
    return originalRmdir(directory);
  });
  syncBuiltinESMExports();
  let replacement: (() => void) | undefined;
  try {
    throws(release, /simulated release interruption/);
    throws(() => readdirSync(path), { code: "ENOENT" });
    replacement = claimProcessLock(path);
    assertOccupied(path);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    try {
      replacement?.();
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  }
});

test("retired generation cleanup preserves a replacement owner", (t) => {
  const path = temporaryPath();
  const lease = acquireProcessLock(path);
  const originalRename = fs.renameSync;
  let replacement: ReturnType<typeof acquireProcessLock> | undefined;
  t.mock.method(fs, "renameSync", (source: string, destination: string) => {
    originalRename(source, destination);
    if (source === path && destination.endsWith(".released"))
      replacement = acquireProcessLock(path);
  });
  syncBuiltinESMExports();
  try {
    lease.release();
    equal(replacement === undefined, false);
    deepEqual(readLiveProcessLock(path), replacement!.claim);
    assertOccupied(path);
    lease.release();
    deepEqual(readLiveProcessLock(path), replacement!.claim);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    try {
      replacement?.release();
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  }
});

test("acquireProcessLock returns an exact claim", () => {
  const path = temporaryPath();
  try {
    const lease = acquireProcessLock(path);
    deepEqual(lease.claim, { pid: process.pid, id: lease.claim.id });
    assertOccupied(path);
    lease.release();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("publication collision during release is reported as occupied", (t) => {
  const path = temporaryPath();
  const previousLease = acquireProcessLock(path);
  const originalRename = fs.renameSync;
  let released = false;
  t.mock.method(fs, "renameSync", (source: string, destination: string) => {
    try {
      return originalRename(source, destination);
    } catch (error) {
      if (
        destination === path &&
        ["EEXIST", "ENOTEMPTY", "EPERM"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        previousLease.release();
        released = true;
      }
      throw error;
    }
  });
  syncBuiltinESMExports();
  let replacement: ReturnType<typeof acquireProcessLock> | undefined;
  try {
    throws(
      () => acquireProcessLock(path),
      (error: unknown) => error instanceof ProcessLockOccupiedError,
    );
    equal(released, true);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    replacement = acquireProcessLock(path);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    try {
      replacement?.release();
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  }
});

test("owner retirement after observation during acquisition is contention", (t) => {
  const path = temporaryPath();
  const lease = acquireProcessLock(path);
  const ownerPath = join(path, readdirSync(path)[0]!);
  const originalRead = fs.readFileSync;
  let retired = false;
  t.mock.method(fs, "readFileSync", (file: string, encoding: "utf8") => {
    if (file === ownerPath && !retired) {
      retired = true;
      lease.release();
    }
    return originalRead(file, encoding);
  });
  syncBuiltinESMExports();

  try {
    throws(
      () => acquireProcessLock(path),
      (error: unknown) => error instanceof ProcessLockOccupiedError,
    );
    equal(retired, true);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(dirname(path), { recursive: true, force: true });
  }
});

test("replacement owner during acquisition remains protected", (t) => {
  const path = temporaryPath();
  const lease = acquireProcessLock(path);
  const ownerPath = join(path, readdirSync(path)[0]!);
  const originalRead = fs.readFileSync;
  let replacement: ReturnType<typeof acquireProcessLock> | undefined;
  let intercepted = false;
  t.mock.method(fs, "readFileSync", (file: string, encoding: "utf8") => {
    if (file === ownerPath && !intercepted) {
      intercepted = true;
      lease.release();
      replacement = acquireProcessLock(path);
    }
    return originalRead(file, encoding);
  });
  syncBuiltinESMExports();

  try {
    throws(
      () => acquireProcessLock(path),
      (error: unknown) => error instanceof ProcessLockOccupiedError,
    );
    equal(intercepted, true);
    deepEqual(readLiveProcessLock(path), replacement!.claim);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    try {
      replacement?.release();
      lease.release();
    } finally {
      rmSync(dirname(path), { recursive: true, force: true });
    }
  }
});

test("Linux reused PID owner is recovered without exposing private identity", (t) => {
  if (process.platform !== "linux") return t.skip("Linux process identity");
  const path = temporaryPath();
  const id = randomUUID();
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const fields = stat
    .slice(stat.lastIndexOf(") ") + 2)
    .trim()
    .split(/\s+/);
  const actualTicks = fields[19]!;
  const differentTicks = actualTicks === "0" ? "1" : "0";
  try {
    mkdirSync(path, 0o700);
    writeFileSync(
      join(path, `${process.pid}-${id}`),
      JSON.stringify({
        pid: process.pid,
        id,
        linuxBirth: { bootId, startTicks: differentTicks },
      }),
    );
    const lease = acquireProcessLock(path);
    try {
      deepEqual(lease.claim, { pid: process.pid, id: lease.claim.id });
      deepEqual(readProcessLockStatus(path), {
        claim: lease.claim,
        live: true,
      });
    } finally {
      lease.release();
    }
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("release rejects a dangling owner symlink", () => {
  const path = temporaryPath();
  try {
    const lease = acquireProcessLock(path);
    const owner = readdirSync(path)[0]!;
    unlinkSync(join(path, owner));
    symlinkSync("missing-target", join(path, owner));
    throws(() => lease.release(), /Unable to verify .* ownership/);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("release remains harmless when its owner entry is already removed", () => {
  const path = temporaryPath();
  try {
    const lease = acquireProcessLock(path);
    unlinkSync(join(path, readdirSync(path)[0]!));
    lease.release();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("claim wrapper retains atomic stale recovery after a crash", () => {
  const path = temporaryPath();
  const id = randomUUID();
  try {
    mkdirSync(path, 0o700);
    writeFileSync(
      join(path, `2147483647-${id}`),
      JSON.stringify({ pid: 2147483647, id }),
    );
    throws(
      () =>
        claimProcessLock(path, {
          afterStaleOwnerRemoved: () => {
            throw new Error("simulated crash");
          },
        }),
      /simulated crash/,
    );
    throws(() => readdirSync(path), { code: "ENOENT" });

    const release = claimProcessLock(path);
    assertOccupied(path);
    release();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("metadata does not affect live lock verification and is removed on release", () => {
  const path = temporaryPath();
  try {
    const lease = acquireProcessLock(path);
    for (const name of metadataNames)
      writeFileSync(join(path, name), "metadata");
    unlinkSync(join(path, "desktop.ini"));
    writeFileSync(join(path, "DESKTOP.INI"), "metadata");
    deepEqual(readProcessLockStatus(path), { claim: lease.claim, live: true });
    assertOccupied(path);
    lease.release();
    throws(() => readdirSync(path), { code: "ENOENT" });

    const reacquired = acquireProcessLock(path);
    reacquired.release();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("stale recovery removes metadata only after verifying the stale owner", () => {
  const path = temporaryPath();
  const id = randomUUID();
  try {
    mkdirSync(path, 0o700);
    writeFileSync(
      join(path, `2147483647-${id}`),
      JSON.stringify({ pid: 2147483647, id }),
    );
    for (const name of metadataNames)
      writeFileSync(join(path, name), "metadata");
    const release = claimProcessLock(path);
    assertOccupied(path);
    release();
    throws(() => readdirSync(path), { code: "ENOENT" });
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("metadata alone and unsafe entries remain ambiguous", () => {
  for (const name of metadataNames) {
    const path = temporaryPath();
    try {
      mkdirSync(path, 0o700);
      writeFileSync(join(path, name), "metadata");
      throws(() => claimProcessLock(path), /Unable to verify/);
      throws(() => readProcessLockStatus(path), /Unable to verify/);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
    for (const entry of ["symlink", "directory"]) {
      const unsafePath = temporaryPath();
      try {
        mkdirSync(unsafePath, 0o700);
        if (entry === "symlink") symlinkSync("missing", join(unsafePath, name));
        else mkdirSync(join(unsafePath, name));
        throws(() => claimProcessLock(unsafePath), /Unable to verify/);
        throws(() => readProcessLockStatus(unsafePath), /Unable to verify/);
      } finally {
        rmSync(unsafePath, { recursive: true, force: true });
      }
    }
  }
});

test("owner with a metadata symlink or unknown file is rejected", () => {
  for (const entry of ["symlink", "directory", "unknown"]) {
    const path = temporaryPath();
    const lease = acquireProcessLock(path);
    try {
      if (entry === "symlink")
        symlinkSync("missing", join(path, "desktop.ini"));
      else if (entry === "directory") mkdirSync(join(path, ".directory"));
      else writeFileSync(join(path, "unexpected"), "unknown");
      throws(() => readProcessLockStatus(path), /Unable to verify/);
      throws(() => lease.release(), /Unable to verify/);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

test("stale recovery reports a concurrent claimant as occupied", () => {
  const path = temporaryPath();
  const id = randomUUID();
  let releaseConcurrent: (() => void) | undefined;
  try {
    mkdirSync(path, 0o700);
    writeFileSync(
      join(path, `2147483647-${id}`),
      JSON.stringify({ pid: 2147483647, id }),
    );
    throws(
      () =>
        claimProcessLock(path, {
          afterStaleOwnerRemoved: () => {
            releaseConcurrent = claimProcessLock(path);
          },
        }),
      (error: unknown) => error instanceof ProcessLockOccupiedError,
    );
  } finally {
    releaseConcurrent?.();
    rmSync(path, { recursive: true, force: true });
  }
});

test("stale recovery rejects malformed evidence without touching it", () => {
  const path = temporaryPath();
  const owner = "2147483647-stale";
  try {
    mkdirSync(path, 0o700);
    writeFileSync(
      join(path, owner),
      JSON.stringify({ pid: 2147483647, id: "stale" }),
    );
    throws(() => claimProcessLock(path), /Unable to verify process lock/);
    deepEqual(readdirSync(path), [owner]);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("empty lock directories fail closed", () => {
  const path = temporaryPath();
  try {
    mkdirSync(path, 0o700);
    throws(() => claimProcessLock(path), /Unable to verify/);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("readLiveProcessLock returns a valid live claim", () => {
  const path = temporaryPath();
  try {
    const lease = acquireProcessLock(path);
    deepEqual(readLiveProcessLock(path), lease.claim);
    lease.release();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("readLiveProcessLock rejects a dead PID", () => {
  const path = temporaryPath();
  const id = randomUUID();
  try {
    mkdirSync(path, 0o700);
    writeFileSync(
      join(path, `2147483647-${id}`),
      JSON.stringify({ pid: 2147483647, id }),
    );
    deepEqual(readProcessLockStatus(path), {
      claim: { pid: 2147483647, id },
      live: false,
    });
    throws(() => readLiveProcessLock(path), /Unable to verify/);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("readLiveProcessLock rejects a malformed owner", () => {
  const path = temporaryPath();
  const id = randomUUID();
  try {
    mkdirSync(path, 0o700);
    writeFileSync(
      join(path, `${process.pid}-${id}`),
      JSON.stringify({ pid: process.pid, id, unexpected: true }),
    );
    throws(() => readProcessLockStatus(path), /Unable to verify/);
    throws(() => readLiveProcessLock(path), /Unable to verify/);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("readLiveProcessLock rejects empty and multiple owners", () => {
  for (const owners of [
    [],
    [`${process.pid}-${randomUUID()}`, `${process.pid}-${randomUUID()}`],
  ]) {
    const path = temporaryPath();
    try {
      mkdirSync(path, 0o700);
      for (const owner of owners)
        writeFileSync(
          join(path, owner),
          JSON.stringify({
            pid: process.pid,
            id: owner.slice(owner.indexOf("-") + 1),
          }),
        );
      throws(() => readLiveProcessLock(path), /Unable to verify/);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  }
});

function assertOccupied(path: string): void {
  throws(
    () => claimProcessLock(path),
    (error: unknown) => {
      return error instanceof ProcessLockOccupiedError;
    },
  );
}
