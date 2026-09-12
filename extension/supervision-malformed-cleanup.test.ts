import { strict as assert } from "node:assert";
import * as realFs from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mock, test } from "node:test";

let failUnlink = false;
let failureDirectory: string | undefined;
let raceJsonRename = false;
let failMarkerUnlink = false;
let failDirectoryFsyncAt: number | undefined;
let directoryFsyncCount = 0;
let lastDirectoryFsyncError: Error | undefined;
const directoryFsyncFds = new Set<number>();
mock.module("@earendil-works/pi-coding-agent", {
  namedExports: {
    getAgentDir: () => process.env.PI_CODING_AGENT_DIR ?? tmpdir(),
  },
});
mock.module("node:fs", {
  namedExports: {
    accessSync: realFs.accessSync,
    constants: realFs.constants,
    existsSync: realFs.existsSync,
    chmodSync: realFs.chmodSync,
    closeSync: (fd: number) => {
      directoryFsyncFds.delete(fd);
      return realFs.closeSync(fd);
    },
    fstatSync: realFs.fstatSync,
    fsyncSync: (...args: Parameters<typeof realFs.fsyncSync>) => {
      if (typeof args[0] === "number" && directoryFsyncFds.has(args[0]))
        directoryFsyncCount++;
      if (
        failDirectoryFsyncAt === directoryFsyncCount &&
        typeof args[0] === "number" &&
        directoryFsyncFds.has(args[0])
      ) {
        const error = new Error(
          "directory fsync failed",
        ) as NodeJS.ErrnoException;
        error.code = "EIO";
        lastDirectoryFsyncError = error;
        throw error;
      }
      return realFs.fsyncSync(...args);
    },
    mkdirSync: realFs.mkdirSync,
    openSync: (...args: Parameters<typeof realFs.openSync>) => {
      const fd = realFs.openSync(...args);
      if (typeof args[0] === "string" && args[0] === failureDirectory)
        directoryFsyncFds.add(fd);
      return fd;
    },
    readFileSync: realFs.readFileSync,
    realpathSync: realFs.realpathSync,
    readdirSync: realFs.readdirSync,
    renameSync: (...args: Parameters<typeof realFs.renameSync>) => {
      if (
        raceJsonRename &&
        String(args[0]).endsWith(".json") &&
        String(args[1]).endsWith(".cleanup")
      ) {
        raceJsonRename = false;
        realFs.renameSync(...args);
        realFs.unlinkSync(args[1]);
        const error = new Error(
          "message already removed",
        ) as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }
      return realFs.renameSync(...args);
    },
    rmSync: realFs.rmSync,
    rmdirSync: realFs.rmdirSync,
    statSync: realFs.statSync,
    unlinkSync: (...args: Parameters<typeof realFs.unlinkSync>) => {
      if (
        failMarkerUnlink &&
        String(args[0]).endsWith(".json.quarantine") &&
        dirname(String(args[0])) === failureDirectory
      ) {
        const error = new Error(
          "marker unlink failed",
        ) as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      if (
        failUnlink &&
        String(args[0]).endsWith(".cleanup") &&
        dirname(String(args[0])) === failureDirectory
      ) {
        const error = new Error("unlink failed") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realFs.unlinkSync(...args);
    },
    writeFileSync: realFs.writeFileSync,
    writeSync: realFs.writeSync,
  },
});

const {
  chiefMessagePath,
  claimChiefLease,
  drainChiefInbox,
  supervisionRuntime,
  quarantineChiefMessage,
  writeChiefMessage,
} = await import("./supervision.ts");

const socket = () =>
  join(realFs.mkdtempSync(join(tmpdir(), "supervision-")), "sock");

function malformedInbox() {
  const runtime = supervisionRuntime(socket());
  const path = chiefMessagePath(runtime, "lead", randomUUID());
  realFs.mkdirSync(dirname(path), { recursive: true });
  realFs.writeFileSync(path, "{ truncated", "utf8");
  return { runtime, path };
}

test(
  "Chief descriptor publication fsyncs its containing directory",
  { concurrency: false },
  () => {
    const previousSocket = process.env.HERDR_SOCKET_PATH;
    process.env.HERDR_SOCKET_PATH = socket();
    const runtime = supervisionRuntime();
    directoryFsyncCount = 0;
    failureDirectory = runtime.root;
    try {
      const lease = claimChiefLease({
        piSessionId: randomUUID(),
        paneId: "pane",
        workspaceId: "workspace",
      });
      assert.equal(directoryFsyncCount, process.platform === "win32" ? 0 : 1);
      lease.release();
    } finally {
      directoryFsyncCount = 0;
      failureDirectory = undefined;
      if (previousSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
      else process.env.HERDR_SOCKET_PATH = previousSocket;
    }
  },
);

function assertCleanupError(
  error: unknown,
  message: string,
  code: string | undefined,
  cause?: { message: string; code: string },
) {
  assert.ok(error instanceof Error);
  assert.equal(error.message, message);
  if (code) assert.equal((error as NodeJS.ErrnoException).code, code);
  if (cause) {
    assert.ok(error.cause instanceof Error);
    assert.equal(error.cause.message, cause.message);
    assert.equal((error.cause as NodeJS.ErrnoException).code, cause.code);
  }
}

test(
  "drain reports malformed cleanup failure and retains it for retry",
  { concurrency: false },
  async () => {
    const { runtime, path } = malformedInbox();
    const errors: unknown[] = [];
    failUnlink = true;
    failureDirectory = dirname(path);
    try {
      await drainChiefInbox({
        runtime,
        sessionId: "lead",
        isAuthorized: () => true,
        isDelivered: () => false,
        sendMessage: () => assert.fail("malformed message was sent"),
        cleanupError: (error) => errors.push(error),
      });
      assert.equal(errors.length, 1);
      assertCleanupError(errors[0], "unlink failed", "EACCES");
      assert.equal(realFs.existsSync(path), true);
    } finally {
      failUnlink = false;
      failureDirectory = undefined;
    }
  },
);

test(
  "failed quarantine-marker cleanup reports an error and retains back-pressure",
  { concurrency: false },
  async () => {
    const { runtime, path } = malformedInbox();
    const errors: unknown[] = [];
    failMarkerUnlink = true;
    failureDirectory = dirname(path);
    try {
      await drainChiefInbox({
        runtime,
        sessionId: "lead",
        isAuthorized: () => true,
        isDelivered: () => false,
        sendMessage: () => assert.fail("malformed message was sent"),
        cleanupError: (error) => errors.push(error),
      });
      assert.equal(errors.length, 1);
      assertCleanupError(
        errors[0],
        "Unable to remove Chief message quarantine",
        undefined,
        {
          message: "marker unlink failed",
          code: "EACCES",
        },
      );
      assert.equal(realFs.existsSync(path), false);
      assert.equal(realFs.existsSync(`${path}.quarantine`), true);
    } finally {
      failMarkerUnlink = false;
      failureDirectory = undefined;
    }
  },
);

test(
  "drain reports quarantine-marker fsync failure and retains quarantine",
  { concurrency: false, skip: process.platform === "win32" },
  async () => {
    const { runtime, path } = malformedInbox();
    const errors: unknown[] = [];
    // Fail marker creation's directory fsync, before detach can begin.
    failDirectoryFsyncAt = 1;
    directoryFsyncCount = 0;
    failureDirectory = dirname(path);
    try {
      await drainChiefInbox({
        runtime,
        sessionId: "lead",
        isAuthorized: () => true,
        isDelivered: () => false,
        sendMessage: () => assert.fail("malformed message was sent"),
        cleanupError: (error) => errors.push(error),
      });
      assert.equal(errors.length, 1);
      assertCleanupError(errors[0], "directory fsync failed", "EIO");
      assert.equal(realFs.existsSync(path), true);
    } finally {
      failDirectoryFsyncAt = undefined;
      directoryFsyncCount = 0;
      failureDirectory = undefined;
    }
  },
);

test(
  "replacement retains quarantine after final marker fsync failure",
  { concurrency: false, skip: process.platform === "win32" },
  () => {
    const runtime = supervisionRuntime(socket());
    const record = {
      version: 1 as const,
      id: randomUUID(),
      leaseId: randomUUID(),
      kind: "lead_message" as const,
      fromSessionId: "lead",
      toSessionId: "chief",
      leadSessionId: "lead",
      text: "original",
      createdAt: 1,
    };
    writeChiefMessage(record, runtime);
    const path = chiefMessagePath(runtime, record.toSessionId, record.id);
    const replacement = { ...record, text: "replacement" };
    quarantineChiefMessage(runtime, record.toSessionId, record.id);
    // replacement fsync (#1), then fail the final quarantine-marker removal
    // fsync (#2); restoration fsync must succeed afterward.
    failDirectoryFsyncAt = 2;
    directoryFsyncCount = 0;
    lastDirectoryFsyncError = undefined;
    failureDirectory = dirname(path);
    try {
      assert.throws(
        () => writeChiefMessage(replacement, runtime),
        (error) => error === lastDirectoryFsyncError,
      );
      assert.equal(realFs.existsSync(`${path}.quarantine`), true);
      assert.deepEqual(
        JSON.parse(realFs.readFileSync(path, "utf8")),
        replacement,
      );
    } finally {
      failDirectoryFsyncAt = undefined;
      directoryFsyncCount = 0;
      lastDirectoryFsyncError = undefined;
      failureDirectory = undefined;
    }
  },
);

test(
  "drain reports final quarantine-marker fsync failure after detach",
  { concurrency: false, skip: process.platform === "win32" },
  async () => {
    const { runtime, path } = malformedInbox();
    const errors: unknown[] = [];
    // quarantine marker fsync (#1), detach fsync (#2), cleanup fsync (#3),
    // then fail the final quarantine-marker removal fsync (#4). Restoration
    // must perform the fifth directory fsync and retain the marker.
    failDirectoryFsyncAt = 4;
    directoryFsyncCount = 0;
    lastDirectoryFsyncError = undefined;
    failureDirectory = dirname(path);
    try {
      await drainChiefInbox({
        runtime,
        sessionId: "lead",
        isAuthorized: () => true,
        isDelivered: () => false,
        sendMessage: () => assert.fail("malformed message was sent"),
        cleanupError: (error) => errors.push(error),
      });
      assert.equal(errors.length, 1);
      assertCleanupError(
        errors[0],
        "Unable to remove Chief message quarantine",
        undefined,
        { message: "directory fsync failed", code: "EIO" },
      );
      assert.equal(directoryFsyncCount, 5);
      assert.equal(realFs.existsSync(path), false);
      assert.equal(realFs.existsSync(`${path}.quarantine`), true);
    } finally {
      failDirectoryFsyncAt = undefined;
      directoryFsyncCount = 0;
      failureDirectory = undefined;
    }
  },
);

test(
  "unauthorized cleanup reports failure and retains quarantine",
  { concurrency: false },
  async () => {
    const runtime = supervisionRuntime(socket());
    const id = randomUUID();
    const path = writeChiefMessage(
      {
        version: 1,
        id,
        leaseId: randomUUID(),
        kind: "chief_message",
        fromSessionId: "chief",
        toSessionId: "lead",
        leadSessionId: "lead",
        text: "rejected",
        createdAt: Date.now(),
      },
      runtime,
    );
    const errors: unknown[] = [];
    failUnlink = true;
    failureDirectory = dirname(path);
    try {
      await drainChiefInbox({
        runtime,
        sessionId: "lead",
        isAuthorized: () => false,
        isDelivered: () => false,
        sendMessage: () => assert.fail("unauthorized message was sent"),
        rejected: () => {},
        cleanupError: (error) => errors.push(error),
      });
      assert.equal(errors.length, 1);
      assertCleanupError(
        errors[0],
        "Unable to remove Chief message",
        undefined,
        {
          message: "unlink failed",
          code: "EACCES",
        },
      );
      assert.equal(realFs.existsSync(path), true);
      assert.equal(realFs.existsSync(`${path}.quarantine`), true);
    } finally {
      failUnlink = false;
      failureDirectory = undefined;
    }
  },
);
