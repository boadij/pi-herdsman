import { deepEqual, equal, throws } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireProcessLock,
  claimProcessLock,
  ProcessLockOccupiedError,
  readLiveProcessLock,
} from "./lock.ts";

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

test("claim wrapper retains atomic stale recovery after a crash", () => {
  const path = temporaryPath();
  try {
    mkdirSync(path, 0o700);
    writeFileSync(
      join(path, "999999-stale"),
      JSON.stringify({ pid: 999999, id: "stale" }),
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

test("stale recovery reports a concurrent claimant as occupied", () => {
  const path = temporaryPath();
  let releaseConcurrent: (() => void) | undefined;
  try {
    mkdirSync(path, 0o700);
    writeFileSync(
      join(path, "999999-stale"),
      JSON.stringify({ pid: 999999, id: "stale" }),
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
