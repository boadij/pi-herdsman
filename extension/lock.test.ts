import { deepEqual, equal, throws } from "node:assert/strict";
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
} from "./lock.ts";

function temporaryPath(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-herdsman-lock-")), "lock");
}

test("generic locks retain directory publication and exact release", () => {
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

test("Chief locks publish an exact claim without changing generic callers", () => {
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

test("Chief stale recovery remains claimable after a crash before publication", () => {
  const path = temporaryPath();
  try {
    mkdirSync(path, 0o700);
    writeFileSync(
      join(path, "999999-stale"),
      JSON.stringify({ pid: 999999, id: "stale" }),
    );
    throws(
      () =>
        acquireProcessLock(path, {
          afterStaleOwnerRemoved: () => {
            throw new Error("simulated crash");
          },
        }),
      /simulated crash/,
    );
    throws(() => readdirSync(path), { code: "ENOENT" });

    const lease = acquireProcessLock(path);
    assertOccupied(path);
    lease.release();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});

test("empty generic lock directories fail closed", () => {
  const path = temporaryPath();
  try {
    mkdirSync(path, 0o700);
    throws(() => claimProcessLock(path), /Unable to verify/);
  } finally {
    rmSync(path, { recursive: true, force: true });
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
