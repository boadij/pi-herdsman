import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensureManagerGitRepository } from "./manager-git.ts";

function gitExec() {
  return {
    async exec(_command: string, args: string[], options: { cwd: string }) {
      const result = spawnSync("git", args, {
        cwd: options.cwd,
        encoding: "utf8",
      });
      return {
        code: result.status ?? 1,
        killed: !!result.error,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.error?.message ?? "",
      };
    },
  };
}

test("Manager Git setup confirms before creating a requested directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "manager-git-test-"));
  const target = join(root, "new", "project");
  try {
    const declined = await ensureManagerGitRepository(gitExec(), target, {
      createIfMissing: true,
      confirm: async () => false,
    });
    assert.equal(declined, undefined);
    assert.equal(existsSync(target), false);

    const approved = await ensureManagerGitRepository(gitExec(), target, {
      createIfMissing: true,
      confirm: async () => true,
    });
    assert.equal(approved?.checkoutPath, realpathSync.native(target));
    assert.equal(existsSync(join(target, ".git", "HEAD")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Manager Git bootstrap keeps existing files out of its empty commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "manager-git-test-"));
  const target = join(root, "project");
  mkdirSync(target);
  writeFileSync(join(target, "keep.txt"), "not committed\n");
  try {
    const initialized = await ensureManagerGitRepository(gitExec(), target, {
      confirm: async () => true,
    });
    assert.equal(initialized?.checkoutPath, realpathSync.native(target));
    const tree = spawnSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], {
      cwd: target,
      encoding: "utf8",
    });
    assert.equal(tree.status, 0);
    assert.equal(tree.stdout, "");
    assert.equal(existsSync(join(target, "keep.txt")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Manager Git startup does not prompt for a verified primary repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "manager-git-test-"));
  const target = join(root, "project");
  mkdirSync(target);
  try {
    assert.equal(
      spawnSync("git", ["init", "--initial-branch=main"], {
        cwd: target,
      }).status,
      0,
    );
    assert.equal(
      spawnSync("git", ["config", "user.name", "Test"], {
        cwd: target,
      }).status,
      0,
    );
    assert.equal(
      spawnSync("git", ["config", "user.email", "test@example.invalid"], {
        cwd: target,
      }).status,
      0,
    );
    assert.equal(
      (
        await gitExec().exec(
          "git",
          ["commit", "--allow-empty", "-m", "test primary repository"],
          { cwd: target },
        )
      ).code,
      0,
    );
    let prompts = 0;
    const repository = await ensureManagerGitRepository(gitExec(), target, {
      confirm: async () => {
        prompts++;
        return false;
      },
    });
    assert.equal(repository?.checkoutPath, realpathSync.native(target));
    assert.equal(prompts, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
