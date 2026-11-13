import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("post-checkout installs dependencies only in new linked worktrees", (t) => {
  if (process.platform === "win32") {
    t.skip("Git for Windows npm executable mocking is not verified");
    return;
  }

  const root = mkdtempSync(join(tmpdir(), "herdsman-worktree-hook-"));
  try {
    const globalConfig = join(root, "gitconfig");
    writeFileSync(globalConfig, "");
    const repo = join(root, "repo");
    const hooks = join(root, "hooks");
    const bin = join(root, "bin");
    const log = join(root, "npm.log");
    mkdirSync(repo);
    mkdirSync(hooks);
    mkdirSync(bin);
    copyFileSync(
      join(repoRoot, ".githooks/post-checkout"),
      join(hooks, "post-checkout"),
    );
    const fakeNpm = join(bin, "npm");
    writeFileSync(
      fakeNpm,
      '#!/bin/sh\nprintf "%s\\t%s\n" "$PWD" "$*" >> "$HOOK_LOG"\n[ "${FAIL_NPM:-0}" != 1 ]\n',
    );
    chmodSync(fakeNpm, 0o755);

    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      HOOK_LOG: log,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: globalConfig,
    };
    const git = (args, cwd = repo, overrides = {}) => {
      return execFileSync("git", args, {
        cwd,
        env: { ...env, ...overrides },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    };
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.invalid"]);
    writeFileSync(join(repo, "tracked.txt"), "initial\n");
    git(["add", "tracked.txt"]);
    git(["commit", "-m", "initial"]);
    git(["config", "core.hooksPath", hooks]);
    git(["branch", "existing"]);
    git(["branch", "switchable"]);

    const primaryHead = git(["rev-parse", "HEAD"]).trim();
    const primaryHook = spawnSync(
      "sh",
      [join(hooks, "post-checkout"), "0".repeat(40), primaryHead, "1"],
      {
        cwd: repo,
        env,
        encoding: "utf8",
      },
    );
    assert.equal(primaryHook.status, 0);
    assert.equal(existsSync(log), false, "primary checkout is excluded");

    git(["worktree", "add", join(root, "existing-worktree"), "existing"]);
    git(["worktree", "add", "-b", "new-branch", join(root, "new-worktree")]);
    assert.deepEqual(
      readFileSync(log, "utf8").trim().split("\n"),
      [join(root, "existing-worktree"), join(root, "new-worktree")].map(
        (cwd) => `${realpathSync(cwd)}\tci`,
      ),
    );

    git(["checkout", "switchable"]);
    git(["checkout", "main"]);
    writeFileSync(join(repo, "tracked.txt"), "changed\n");
    git(["checkout", "--", "tracked.txt"]);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2);

    const failedPath = join(root, "failed-worktree");
    const failure = spawnSync(
      "git",
      ["worktree", "add", "-b", "failed", failedPath],
      {
        cwd: repo,
        env: { ...env, FAIL_NPM: "1" },
        encoding: "utf8",
      },
    );
    assert.notEqual(failure.status, 0);
    assert.match(
      failure.stderr,
      /Run npm ci in this checkout before reusing it/,
    );
    assert.equal(
      existsSync(failedPath),
      true,
      "failed install retains checkout",
    );
    assert.deepEqual(
      readFileSync(log, "utf8").trim().split("\n").at(-1),
      `${realpathSync(failedPath)}\tci`,
    );

    const unconfigured = join(root, "unconfigured");
    mkdirSync(unconfigured);
    const runUnconfigured = (...args) =>
      execFileSync("git", args, { cwd: unconfigured, env, encoding: "utf8" });
    runUnconfigured("init", "-b", "main");
    runUnconfigured("config", "user.name", "Test");
    runUnconfigured("config", "user.email", "test@example.invalid");
    writeFileSync(join(unconfigured, "tracked.txt"), "initial\n");
    runUnconfigured("add", "tracked.txt");
    runUnconfigured("commit", "-m", "initial");
    runUnconfigured(
      "worktree",
      "add",
      "-b",
      "not-enabled",
      join(root, "not-enabled"),
    );
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("setup:hooks enables hooks without replacing existing hooks", () => {
  const root = mkdtempSync(join(tmpdir(), "herdsman-hooks-setup-"));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    const globalConfig = join(root, "gitconfig");
    writeFileSync(globalConfig, "");
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const git = (...args) =>
      execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    git("commit", "--allow-empty", "-m", "initial");
    mkdirSync(join(repo, ".githooks"));
    writeFileSync(join(repo, ".githooks", "post-checkout"), "#!/bin/sh\n");
    const setup = (cwd = repo) =>
      spawnSync(process.execPath, [join(repoRoot, "scripts/setup-hooks.mjs")], {
        cwd,
        env,
        encoding: "utf8",
      });

    const initial = setup();
    assert.equal(initial.status, 0, initial.stderr);
    assert.equal(
      git("config", "--local", "--get", "core.hooksPath"),
      join(realpathSync(repo), ".githooks"),
    );
    assert.equal(setup().status, 0);

    // A directory copy carries the original repository's absolute hooks path.
    const copied = join(root, "copied");
    cpSync(repo, copied, { recursive: true });
    const repaired = setup(copied);
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(
      execFileSync("git", ["config", "--local", "--get", "core.hooksPath"], {
        cwd: copied,
        env,
        encoding: "utf8",
      }).trim(),
      join(realpathSync(copied), ".githooks"),
    );
    assert.equal(
      git("config", "--local", "--get", "core.hooksPath"),
      join(realpathSync(repo), ".githooks"),
    );

    const linked = join(root, "linked");
    git("worktree", "add", "-b", "linked", linked);
    const refused = setup(linked);
    assert.notEqual(refused.status, 0);
    assert.match(
      refused.stderr,
      /Run setup from the primary repository checkout/,
    );

    git("config", "--local", "core.hooksPath", join(root, "other-hooks"));
    const conflict = setup();
    assert.notEqual(conflict.status, 0);
    assert.match(
      conflict.stderr,
      /Refusing to replace existing core\.hooksPath/,
    );
    assert.equal(
      git("config", "--get", "core.hooksPath"),
      join(root, "other-hooks"),
    );

    const customHooks = join(root, "custom", ".githooks");
    mkdirSync(customHooks, { recursive: true });
    writeFileSync(join(customHooks, "post-checkout"), "#!/bin/sh\nexit 1\n");
    git("config", "--local", "core.hooksPath", customHooks);
    const custom = setup();
    assert.notEqual(custom.status, 0);
    assert.equal(git("config", "--get", "core.hooksPath"), customHooks);

    git("config", "--local", "--unset", "core.hooksPath");
    writeFileSync(
      globalConfig,
      `[core]\n\thooksPath = ${join(copied, ".githooks")}\n`,
    );
    const global = setup();
    assert.notEqual(global.status, 0);
    assert.equal(
      git("config", "--get", "core.hooksPath"),
      join(copied, ".githooks"),
    );
    writeFileSync(globalConfig, "");
    if (process.platform !== "win32") {
      const existingHook = join(repo, ".git", "hooks", "pre-commit");
      writeFileSync(existingHook, "#!/bin/sh\n");
      chmodSync(existingHook, 0o755);
      const blocked = setup();
      assert.notEqual(blocked.status, 0);
      assert.match(blocked.stderr, /Refusing to replace executable hooks/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
