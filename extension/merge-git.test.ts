import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

function awaitFile(root: string, name: string, contents: string) {
  writeFileSync(join(root, name), contents);
}
