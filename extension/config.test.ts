import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mock, test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

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
    lstatSync: realFs.lstatSync,
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
    utimesSync: realFs.utimesSync,
    watch: realFs.watch,
    writeFileSync: realFs.writeFileSync,
    writeSync: realFs.writeSync,
  },
});

const {
  DEFAULT_CONFIG,
  MAX_BYTE_LIMIT,
  MIN_BYTE_LIMIT,
  readConfig,
  isWorktreeRemovalPreapproved,
  setWorktreeRemovalPreapproved,
  readEffectiveConfig,
  readProjectOverrides,
  updateConfig,
  updateProjectOverride,
  validByteLimit,
} = await import("./config.ts");
const { herdsmanConfigPath, herdsmanDataRoot } = await import("./storage.ts");
const { claimProcessLock } = await import("./lock.ts");
const { lockSync } = await import("proper-lockfile");
configPath = herdsmanConfigPath();

function resetConfig(): void {
  realFs.rmSync(herdsmanDataRoot(), { recursive: true, force: true });
}

test.afterEach(resetConfig);

test("missing config resolves to defaults without creating storage", () => {
  resetConfig();
  assert.deepEqual(readConfig(), DEFAULT_CONFIG);
  assert.equal(readConfig().contextRetirement, true);
  assert.equal(readConfig().defaultLeadExecution, "flexible");
  assert.equal(readConfig().autoActivateManager, false);
  assert.equal(realFs.existsSync(herdsmanDataRoot()), false);
});

test("worktree-removal preauthorization is repository-scoped and survives reload", () => {
  assert.equal(isWorktreeRemovalPreapproved("/repo-a"), false);
  setWorktreeRemovalPreapproved("/repo-a", true);
  assert.equal(isWorktreeRemovalPreapproved("/repo-a"), true);
  assert.equal(isWorktreeRemovalPreapproved("/repo-b"), false);
  assert.deepEqual(readConfig().worktreeRemovalPreapprovedRepos, ["/repo-a"]);
  setWorktreeRemovalPreapproved("/repo-a", false);
  assert.equal(isWorktreeRemovalPreapproved("/repo-a"), false);
  assert.equal(realFs.existsSync(configPath!), false);
});

test("invalid worktree-removal preauthorization fails closed", () => {
  realFs.mkdirSync(herdsmanDataRoot(), { recursive: true });
  realFs.writeFileSync(
    configPath!,
    JSON.stringify({ worktreeRemovalPreapprovedRepos: ["/repo-a", 2] }),
  );
  assert.throws(
    () => isWorktreeRemovalPreapproved("/repo-a"),
    /worktreeRemovalPreapprovedRepos/,
  );
});

test("partial and complete valid configs overlay defaults", () => {
  realFs.mkdirSync(herdsmanDataRoot(), { recursive: true });
  realFs.writeFileSync(
    herdsmanConfigPath(),
    JSON.stringify({
      spawnPlacement: "split",
      defaultLeadExecution: "flexible",
      contextRetirement: false,
      autoActivateManager: false,
    }),
  );
  assert.deepEqual(readConfig(), {
    ...DEFAULT_CONFIG,
    spawnPlacement: "split",
    contextRetirement: false,
    autoActivateManager: false,
  });
  realFs.writeFileSync(
    herdsmanConfigPath(),
    JSON.stringify({
      spawnPlacement: "tab",
      defaultLeadExecution: "orchestrate",
      inlineAttachmentLimitBytes: MIN_BYTE_LIMIT,
      mailboxPayloadLimitBytes: MAX_BYTE_LIMIT,
      autoActivateManager: true,
    }),
  );
  assert.deepEqual(readConfig(), {
    ...DEFAULT_CONFIG,
    spawnPlacement: "tab",
    defaultLeadExecution: "orchestrate",
    contextRetirement: true,
    autoActivateManager: true,
    inlineAttachmentLimitBytes: MIN_BYTE_LIMIT,
    mailboxPayloadLimitBytes: MAX_BYTE_LIMIT,
  });
});

test("trusted project preferences override only the two supported global values", () => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "pi-herdsman-project-config-"));
  try {
    realFs.mkdirSync(`${cwd}/.pi`, { recursive: true });
    updateConfig("autoActivateManager", true);
    updateConfig("contextRetirement", true);
    const ctx = { cwd, isProjectTrusted: () => true } as never;
    realFs.writeFileSync(
      `${cwd}/.pi/settings.json`,
      '\uFEFF{"other":1,"piHerdsman":{"autoActivateManager":false}}',
    );
    assert.deepEqual(readProjectOverrides(ctx), { autoActivateManager: false });
    assert.equal(readEffectiveConfig(ctx).autoActivateManager, false);
    assert.equal(readEffectiveConfig(ctx).contextRetirement, true);
    assert.equal(
      readEffectiveConfig({ ...ctx, isProjectTrusted: () => false })
        .autoActivateManager,
      true,
    );
    realFs.writeFileSync(
      `${cwd}/.pi/settings.json`,
      '{"piHerdsman":{"contextRetirement":false,"autoActivateManager":false}}',
    );
    assert.equal(readEffectiveConfig(ctx).contextRetirement, false);
    for (const content of [
      '{"piHerdsman":{"autoActivateManager":"false"}}',
      '{"piHerdsman":{"defaultLeadExecution":"flexible"}}',
      "{",
    ]) {
      realFs.writeFileSync(`${cwd}/.pi/settings.json`, content);
      assert.throws(
        () => readProjectOverrides(ctx),
        /settings|boolean|unsupported/,
      );
    }
  } finally {
    realFs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("project overrides update one trusted preference and preserve Pi settings", () => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "pi-herdsman-project-write-"));
  const path = join(cwd, ".pi", "settings.json");
  const ctx = { cwd, isProjectTrusted: () => true } as never;
  try {
    updateConfig("autoActivateManager", true);
    updateProjectOverride(ctx, "autoActivateManager", false);
    updateProjectOverride(ctx, "contextRetirement", true);
    assert.deepEqual(JSON.parse(realFs.readFileSync(path, "utf8")), {
      piHerdsman: { autoActivateManager: false, contextRetirement: true },
    });
    assert.equal(readEffectiveConfig(ctx).autoActivateManager, false);
    assert.equal(realFs.statSync(path).isFile(), true);
    realFs.accessSync(path, realFs.constants.R_OK | realFs.constants.W_OK);
    if (process.platform !== "win32") {
      assert.equal(realFs.statSync(path).mode & 0o777, 0o600);
    }

    realFs.writeFileSync(
      path,
      JSON.stringify({
        theme: "dark",
        piHerdsman: { autoActivateManager: false },
      }),
    );
    realFs.chmodSync(path, 0o640);
    updateProjectOverride(ctx, "contextRetirement", false);
    assert.deepEqual(JSON.parse(realFs.readFileSync(path, "utf8")), {
      theme: "dark",
      piHerdsman: { autoActivateManager: false, contextRetirement: false },
    });
    assert.equal(realFs.statSync(path).isFile(), true);
    realFs.accessSync(path, realFs.constants.R_OK | realFs.constants.W_OK);
    if (process.platform !== "win32") {
      assert.equal(realFs.statSync(path).mode & 0o777, 0o640);
    }

    updateProjectOverride(ctx, "autoActivateManager", undefined);
    assert.deepEqual(JSON.parse(realFs.readFileSync(path, "utf8")), {
      theme: "dark",
      piHerdsman: { contextRetirement: false },
    });
    updateProjectOverride(ctx, "contextRetirement", undefined);
    assert.deepEqual(JSON.parse(realFs.readFileSync(path, "utf8")), {
      theme: "dark",
    });
    assert.equal(readEffectiveConfig(ctx).autoActivateManager, true);
    assert.equal(readEffectiveConfig(ctx).contextRetirement, true);
  } finally {
    realFs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("project overrides coexist with Pi SettingsManager project updates", async () => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "pi-herdsman-pi-settings-"));
  const path = join(cwd, ".pi", "settings.json");
  const ctx = { cwd, isProjectTrusted: () => true } as never;
  try {
    const settings = SettingsManager.create(cwd, testAgentDir);

    settings.setProjectExtensionPaths(["./example-extension"]);
    await settings.flush();
    updateProjectOverride(ctx, "autoActivateManager", false);

    settings.setProjectPackages(["npm:example-package"]);
    await settings.flush();

    assert.deepEqual(JSON.parse(realFs.readFileSync(path, "utf8")), {
      extensions: ["./example-extension"],
      packages: ["npm:example-package"],
      piHerdsman: { autoActivateManager: false },
    });
  } finally {
    realFs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("inheriting on a missing project file does not create it", () => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "pi-herdsman-project-empty-"));
  try {
    updateProjectOverride(
      { cwd, isProjectTrusted: () => true } as never,
      "contextRetirement",
      undefined,
    );
    assert.equal(realFs.existsSync(join(cwd, ".pi")), false);
  } finally {
    realFs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("project writes enforce trust and reject invalid data without changing bytes", () => {
  const cwd = realFs.mkdtempSync(
    join(tmpdir(), "pi-herdsman-project-invalid-"),
  );
  const path = join(cwd, ".pi", "settings.json");
  realFs.mkdirSync(dirname(path), { recursive: true });
  const ctx = { cwd, isProjectTrusted: () => true } as never;
  try {
    for (const content of [
      "{",
      '{"piHerdsman":{"other":true}}',
      '{"piHerdsman":{"autoActivateManager":"false"}}',
    ]) {
      realFs.writeFileSync(path, content);
      assert.throws(() =>
        updateProjectOverride(ctx, "autoActivateManager", true),
      );
      assert.equal(realFs.readFileSync(path, "utf8"), content);
    }
    const original = realFs.readFileSync(path, "utf8");
    assert.throws(
      () =>
        updateProjectOverride(
          { cwd, isProjectTrusted: () => false } as never,
          "autoActivateManager",
          true,
        ),
      /untrusted/,
    );
    assert.throws(
      () => updateProjectOverride(ctx, "unknown" as never, true),
      /key/,
    );
    assert.throws(
      () => updateProjectOverride(ctx, "autoActivateManager", "true" as never),
      /value/,
    );
    assert.equal(realFs.readFileSync(path, "utf8"), original);
  } finally {
    realFs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("project writes reject symlink targets and fail safely on lock contention", () => {
  const cwd = realFs.mkdtempSync(join(tmpdir(), "pi-herdsman-project-safe-"));
  const path = join(cwd, ".pi", "settings.json");
  realFs.mkdirSync(dirname(path), { recursive: true });
  const ctx = { cwd, isProjectTrusted: () => true } as never;
  try {
    const target = join(cwd, "target.json");
    realFs.writeFileSync(target, '{"other":1}');
    realFs.symlinkSync(target, path);
    assert.throws(() => updateProjectOverride(ctx, "contextRetirement", true));
    assert.equal(realFs.readFileSync(target, "utf8"), '{"other":1}');
    realFs.unlinkSync(path);

    realFs.writeFileSync(path, "{}");
    const release = lockSync(path, { realpath: false });
    try {
      assert.throws(
        () => updateProjectOverride(ctx, "contextRetirement", true),
        (error: NodeJS.ErrnoException) => error.code === "ELOCKED",
      );
    } finally {
      release();
    }
    assert.equal(realFs.readFileSync(path, "utf8"), "{}");
  } finally {
    realFs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("invalid values, malformed JSON, non-object roots, and unknown keys fail clearly", () => {
  realFs.mkdirSync(herdsmanDataRoot(), { recursive: true });
  for (const [content, message] of [
    ['{"spawnPlacement":"invalid"}', "spawnPlacement"],
    ['{"defaultLeadExecution":"invalid"}', "defaultLeadExecution"],
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
    ['{"autoActivateManager":"true"}', "autoActivateManager"],
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
  realFs.writeFileSync(herdsmanConfigPath(), "{}");
  assert.throws(
    () => updateConfig("defaultLeadExecution", "invalid" as never),
    /defaultLeadExecution/,
  );
});

test("updates preserve configured keys, reset one key, and delete the final config", () => {
  updateConfig("spawnPlacement", "tab");
  updateConfig("defaultLeadExecution", "orchestrate");
  updateConfig("contextRetirement", false);
  updateConfig("autoActivateManager", true);
  updateConfig("mailboxPayloadLimitBytes", 64 * 1024);
  assert.deepEqual(
    JSON.parse(realFs.readFileSync(herdsmanConfigPath(), "utf8")),
    {
      spawnPlacement: "tab",
      defaultLeadExecution: "orchestrate",
      contextRetirement: false,
      autoActivateManager: true,
      mailboxPayloadLimitBytes: 64 * 1024,
    },
  );
  assert.equal(readConfig().spawnPlacement, "tab");
  assert.equal(readConfig().defaultLeadExecution, "orchestrate");
  assert.equal(readConfig().contextRetirement, false);
  assert.equal(readConfig().autoActivateManager, true);
  updateConfig("spawnPlacement", undefined);
  updateConfig("defaultLeadExecution", undefined);
  assert.deepEqual(
    JSON.parse(realFs.readFileSync(herdsmanConfigPath(), "utf8")),
    {
      contextRetirement: false,
      autoActivateManager: true,
      mailboxPayloadLimitBytes: 64 * 1024,
    },
  );
  updateConfig("mailboxPayloadLimitBytes", undefined);
  updateConfig("contextRetirement", undefined);
  updateConfig("autoActivateManager", undefined);
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
