import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("local merge strategy fast-forwards offline and refuses divergence unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "herdsman-merge-"));
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    const primary = join(root, "primary");
    run(root, "init", "-b", "main", primary);
    run(primary, "config", "user.name", "Test");
    run(primary, "config", "user.email", "test@example.invalid");
    awaitFile(primary, "base", "base");
    run(primary, "add", "base");
    run(primary, "commit", "-m", "base");
    const base = run(primary, "rev-parse", "HEAD");
    run(primary, "branch", "feature");
    awaitFile(primary, "feature", "feature");
    run(primary, "add", "feature");
    run(primary, "commit", "-m", "feature");
    const feature = run(primary, "rev-parse", "HEAD");
    run(primary, "checkout", "main");
    run(
      primary,
      "merge",
      "--ff-only",
      "--no-autostash",
      "--no-overwrite-ignore",
      feature,
    );
    assert.equal(run(primary, "rev-parse", "HEAD"), feature);

    run(primary, "checkout", "-b", "independent", base);
    awaitFile(primary, "independent", "independent");
    run(primary, "add", "independent");
    run(primary, "commit", "-m", "independent");
    const independent = run(primary, "rev-parse", "HEAD");
    run(primary, "checkout", "main");
    const before = run(primary, "rev-parse", "HEAD");
    assert.throws(() =>
      run(
        primary,
        "merge",
        "--ff-only",
        "--no-autostash",
        "--no-overwrite-ignore",
        independent,
      ),
    );
    assert.equal(run(primary, "rev-parse", "HEAD"), before);
    assert.equal(run(primary, "remote"), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clean divergent merge matches merge-tree and conflicts leave Git state unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "herdsman-divergent-"));
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    const repo = join(root, "repo");
    run(root, "init", "-b", "main", repo);
    run(repo, "config", "user.name", "Test");
    run(repo, "config", "user.email", "test@example.invalid");
    awaitFile(repo, "base", "base");
    run(repo, "add", "base");
    run(repo, "commit", "-m", "base");
    const base = run(repo, "rev-parse", "HEAD");
    awaitFile(repo, "first", "first");
    run(repo, "add", "first");
    run(repo, "commit", "-m", "first");
    const first = run(repo, "rev-parse", "HEAD");
    run(repo, "checkout", "-b", "second", base);
    awaitFile(repo, "second", "second");
    run(repo, "add", "second");
    run(repo, "commit", "-m", "second");
    const second = run(repo, "rev-parse", "HEAD");
    run(repo, "checkout", "main");
    run(repo, "merge", "--ff-only", first);
    const expectedTree = run(repo, "merge-tree", "--write-tree", first, second);
    run(
      repo,
      "merge",
      "--no-ff",
      "--no-edit",
      "--no-autostash",
      "--no-overwrite-ignore",
      "-s",
      "ort",
      second,
    );
    assert.equal(run(repo, "rev-parse", "HEAD^{tree}"), expectedTree);
    assert.deepEqual(
      run(repo, "show", "-s", "--format=%P", "HEAD").split(" "),
      [first, second],
    );
    assert.equal(readFileSync(join(repo, "first"), "utf8"), "first");
    assert.equal(readFileSync(join(repo, "second"), "utf8"), "second");
    assert.equal(run(repo, "merge-base", "--is-ancestor", second, "HEAD"), "");
    assert.equal(run(repo, "status", "--porcelain"), "");

    awaitFile(repo, "base", "target edit");
    run(repo, "add", "base");
    run(repo, "commit", "-m", "target edit");
    run(repo, "checkout", "-b", "conflict", base);
    awaitFile(repo, "base", "source edit");
    run(repo, "add", "base");
    run(repo, "commit", "-m", "conflict");
    const conflict = run(repo, "rev-parse", "HEAD");
    run(repo, "checkout", "main");
    const head = run(repo, "rev-parse", "HEAD");
    const index = run(repo, "ls-files", "--stage");
    const status = run(repo, "status", "--porcelain");
    let code = 0;
    try {
      execFileSync("git", ["merge-tree", "--write-tree", head, conflict], {
        cwd: repo,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      code = (error as { status?: number }).status ?? -1;
    }
    assert.equal(code, 1);
    assert.equal(run(repo, "rev-parse", "HEAD"), head);
    assert.equal(run(repo, "ls-files", "--stage"), index);
    assert.equal(run(repo, "status", "--porcelain"), status);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function awaitFile(root: string, name: string, contents: string) {
  writeFileSync(join(root, name), contents);
}
