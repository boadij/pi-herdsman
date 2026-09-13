import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { basename, dirname } from "node:path";
import { mock, test } from "node:test";

let deleteBeforeRead = false;
let failConfigRename = false;
let configPath: string | undefined;
const testAgentDir =
  process.env.PI_CODING_AGENT_DIR ?? "/tmp/pi-herdsman-config-test";
mock.module("@earendil-works/pi-coding-agent", {
  namedExports: {
    getAgentDir: () => testAgentDir,
  },
});
mock.module("node:fs", {
  namedExports: {
    chmodSync: realFs.chmodSync,
    closeSync: realFs.closeSync,
    constants: realFs.constants,
    existsSync: realFs.existsSync,
    fsyncSync: realFs.fsyncSync,
    fstatSync: realFs.fstatSync,
    mkdirSync: realFs.mkdirSync,
    openSync: realFs.openSync,
    readFileSync: (path: string, encoding: BufferEncoding) => {
      if (deleteBeforeRead && configPath !== undefined && path === configPath) {
        deleteBeforeRead = false;
        realFs.unlinkSync(path);
      }
      return realFs.readFileSync(path, encoding);
    },
    readSync: realFs.readSync,
    realpathSync: realFs.realpathSync,
    renameSync: (from: string, to: string) => {
      if (
        failConfigRename &&
        configPath !== undefined &&
        dirname(from) === dirname(configPath) &&
        basename(from).startsWith(`.${basename(configPath)}.`) &&
        !basename(from).startsWith(`.${basename(configPath)}.lock.`)
      ) {
        failConfigRename = false;
        const error = new Error(
          "injected config rename failure",
        ) as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return realFs.renameSync(from, to);
    },
    readdirSync: realFs.readdirSync,
    rmdirSync: realFs.rmdirSync,
    statSync: realFs.statSync,
    unlinkSync: realFs.unlinkSync,
    writeFileSync: realFs.writeFileSync,
    writeSync: realFs.writeSync,
  },
});

const {
  DEFAULT_CONFIG,
  MAX_BYTE_LIMIT,
  MIN_BYTE_LIMIT,
  readConfig,
  updateConfig,
  validByteLimit,
} = await import("./config.ts");
const { herdsmanConfigPath, herdsmanDataRoot } = await import("./storage.ts");
const { claimProcessLock } = await import("./lock.ts");
configPath = herdsmanConfigPath();

function resetConfig(): void {
  realFs.rmSync(herdsmanDataRoot(), { recursive: true, force: true });
}

test.afterEach(resetConfig);

test("missing config resolves to defaults without creating storage", () => {
  resetConfig();
  assert.deepEqual(readConfig(), DEFAULT_CONFIG);
  assert.equal(readConfig().contextRetirement, true);
  assert.equal(realFs.existsSync(herdsmanDataRoot()), false);
});

test("partial and complete valid configs overlay defaults", () => {
  realFs.mkdirSync(herdsmanDataRoot(), { recursive: true });
  realFs.writeFileSync(
    herdsmanConfigPath(),
    JSON.stringify({ spawnPlacement: "split", contextRetirement: false }),
  );
  assert.deepEqual(readConfig(), {
    ...DEFAULT_CONFIG,
    spawnPlacement: "split",
    contextRetirement: false,
  });
  realFs.writeFileSync(
    herdsmanConfigPath(),
    JSON.stringify({
      spawnPlacement: "tab",
      inlineAttachmentLimitBytes: MIN_BYTE_LIMIT,
      mailboxPayloadLimitBytes: MAX_BYTE_LIMIT,
    }),
  );
  assert.deepEqual(readConfig(), {
    spawnPlacement: "tab",
    contextRetirement: true,
    inlineAttachmentLimitBytes: MIN_BYTE_LIMIT,
    mailboxPayloadLimitBytes: MAX_BYTE_LIMIT,
  });
});

test("invalid values, malformed JSON, non-object roots, and unknown keys fail clearly", () => {
  realFs.mkdirSync(herdsmanDataRoot(), { recursive: true });
  for (const [content, message] of [
    ['{"spawnPlacement":"invalid"}', "spawnPlacement"],
    [
      `{"inlineAttachmentLimitBytes":${MIN_BYTE_LIMIT - 1}}`,
      "inlineAttachmentLimitBytes",
    ],
    [
      `{"mailboxPayloadLimitBytes":${MAX_BYTE_LIMIT + 1}}`,
      "mailboxPayloadLimitBytes",
    ],
    [
      `{"mailboxPayloadLimitBytes":${MIN_BYTE_LIMIT + 0.5}}`,
      "mailboxPayloadLimitBytes",
    ],
    ['{"contextRetirement":"false"}', "contextRetirement"],
    ["{", "Invalid Pi Herdsman config JSON"],
    ["[]", "root must be an object"],
    ['{"typo":true}', "unknown field typo"],
  ] as const) {
    realFs.writeFileSync(herdsmanConfigPath(), content);
    assert.throws(() => readConfig(), new RegExp(message));
  }
  assert.equal(validByteLimit(MIN_BYTE_LIMIT), true);
  assert.equal(validByteLimit(MAX_BYTE_LIMIT), true);
  assert.equal(validByteLimit(MIN_BYTE_LIMIT + 0.5), false);
});

test("updates preserve configured keys, reset one key, and delete the final config", () => {
  updateConfig("spawnPlacement", "tab");
  updateConfig("contextRetirement", false);
  updateConfig("mailboxPayloadLimitBytes", 64 * 1024);
  assert.deepEqual(
    JSON.parse(realFs.readFileSync(herdsmanConfigPath(), "utf8")),
    {
      spawnPlacement: "tab",
      contextRetirement: false,
      mailboxPayloadLimitBytes: 64 * 1024,
    },
  );
  assert.equal(readConfig().spawnPlacement, "tab");
  assert.equal(readConfig().contextRetirement, false);
  updateConfig("spawnPlacement", undefined);
  assert.deepEqual(
    JSON.parse(realFs.readFileSync(herdsmanConfigPath(), "utf8")),
    {
      contextRetirement: false,
      mailboxPayloadLimitBytes: 64 * 1024,
    },
  );
  updateConfig("mailboxPayloadLimitBytes", undefined);
  updateConfig("contextRetirement", undefined);
  assert.equal(realFs.existsSync(herdsmanConfigPath()), false);
  assert.deepEqual(readConfig(), DEFAULT_CONFIG);
});

test("a read racing with final reset treats ENOENT as absent", () => {
  updateConfig("spawnPlacement", "tab");
  deleteBeforeRead = true;
  assert.deepEqual(readConfig(), DEFAULT_CONFIG);
});

test("failed atomic replacement preserves the old config and cleans its temporary file", () => {
  updateConfig("spawnPlacement", "tab");
  const before = realFs.readFileSync(herdsmanConfigPath(), "utf8");
  failConfigRename = true;
  assert.throws(
    () => updateConfig("inlineAttachmentLimitBytes", 64 * 1024),
    /injected config rename failure/,
  );
  assert.equal(realFs.readFileSync(herdsmanConfigPath(), "utf8"), before);
  assert.deepEqual(
    realFs
      .readdirSync(herdsmanDataRoot())
      .filter((entry) => entry.startsWith(".config.json.")),
    [],
  );
});

test("config updates honor the shared process lock", () => {
  const release = claimProcessLock(`${herdsmanConfigPath()}.lock`, {
    name: "Pi Herdsman config update",
  });
  try {
    assert.throws(
      () => updateConfig("spawnPlacement", "split"),
      /Pi Herdsman config update is in progress/,
    );
  } finally {
    release();
  }
});
