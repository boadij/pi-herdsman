import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  verifyBranchScope,
  verifyExistingBranch,
} from "./verify-vendored-skills-branch.mjs";

const snapshotPath = "vendor/github-cli/SKILL.md";
const secondSkillPath = "vendor/gh-stack/SKILL.md";
const referencePath = "vendor/gh-stack/references/example.md";
const entry = (sha, mode = "100644", type = "blob") => ({
  type,
  mode,
  sha: sha.repeat(40),
});

test("permits ordinary snapshot additions, replacements and removals", () => {
  const mergeBaseTree = new Map([
    [snapshotPath, entry("a")],
    [referencePath, entry("b")],
    ["docs/notes.md", entry("c", "100755")],
  ]);
  const branchTree = new Map([
    [snapshotPath, entry("d")],
    [secondSkillPath, entry("e")],
    ["docs/notes.md", entry("c", "100755")],
  ]);
  verifyBranchScope({ mergeBaseTree, branchTree });
});

test("rejects changes outside managed ordinary files", async (t) => {
  for (const [label, path, before, after, expected] of [
    [
      "unrelated addition",
      "extension/injected.ts",
      undefined,
      entry("a"),
      /Unexpected/,
    ],
    [
      "unrelated deletion",
      "vendor/gh-stack/README.md",
      entry("a"),
      undefined,
      /Unexpected/,
    ],
    [
      "unsupported reference",
      "vendor/gh-stack/references/space name.md",
      undefined,
      entry("a"),
      /Unexpected/,
    ],
    ["executable", snapshotPath, entry("a"), entry("a", "100755"), /Unsafe/],
    ["symlink", snapshotPath, entry("a"), entry("b", "120000"), /Unsafe/],
    [
      "gitlink",
      snapshotPath,
      entry("a"),
      entry("b", "160000", "commit"),
      /Unsafe/,
    ],
  ]) {
    await t.test(label, () => {
      assert.throws(
        () =>
          verifyBranchScope({
            mergeBaseTree: new Map(before ? [[path, before]] : []),
            branchTree: new Map(after ? [[path, after]] : []),
          }),
        expected,
      );
    });
  }
});

function integrationFixture() {
  const root = mkdtempSync(join(tmpdir(), "verify-skill-branch-"));
  const skillPath = join(root, snapshotPath);
  mkdirSync(join(root, "vendor/github-cli"), { recursive: true });
  writeFileSync(skillPath, "main snapshot\n");
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
    ["add", snapshotPath],
    ["commit", "-m", "main snapshot"],
  ]) {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  }
  const mainBlob = execFileSync("git", ["hash-object", "--stdin"], {
    cwd: root,
    input: "main snapshot\n",
    encoding: "utf8",
  }).trim();
  const mainSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const branchSha = "c".repeat(40);
  const baseTree = [
    { path: snapshotPath, mode: "100644", type: "blob", sha: mainBlob },
  ];
  const branchTree = [{ path: snapshotPath, ...entry("d") }];
  const response = (body) => Response.json(body);
  const request = async (url) => {
    if (url.endsWith("/git/ref/heads/main")) {
      return response({
        ref: "refs/heads/main",
        object: { type: "commit", sha: mainSha },
      });
    }
    if (url.endsWith("/git/ref/heads/automation%2Fupstream-skills")) {
      return response({
        ref: "refs/heads/automation/upstream-skills",
        object: { type: "commit", sha: branchSha },
      });
    }
    if (url.includes(`/compare/${mainSha}...${branchSha}`)) {
      return response({ merge_base_commit: { sha: mainSha } });
    }
    if (url.endsWith(`/git/trees/${mainSha}?recursive=1`)) {
      return response({ truncated: false, tree: baseTree });
    }
    if (url.endsWith(`/git/trees/${branchSha}?recursive=1`)) {
      return response({ truncated: false, tree: branchTree });
    }
    throw new Error(`Unexpected API request: ${url}`);
  };
  return { root, request, skillPath };
}

test("workflow verifies the old proposal independently of the reconciler", async (t) => {
  for (const [label, reconcile] of [
    [
      "successive upstream upgrade",
      ({ skillPath }) => {
        writeFileSync(skillPath, "newer upstream snapshot\n");
      },
    ],
    [
      "second skill joins pending update",
      ({ root, skillPath }) => {
        writeFileSync(skillPath, "newer upstream snapshot\n");
        mkdirSync(join(root, "vendor/gh-stack"));
        writeFileSync(join(root, secondSkillPath), "second skill snapshot\n");
      },
    ],
    ["obsolete proposal after upstream reverts", () => {}],
  ]) {
    await t.test(label, async (subtest) => {
      const fixture = integrationFixture();
      subtest.after(() =>
        rmSync(fixture.root, { recursive: true, force: true }),
      );
      reconcile(fixture);
      await verifyExistingBranch({
        request: fixture.request,
        token: "test-token",
        repository: "example/repo",
        branchSha: "c".repeat(40),
        root: fixture.root,
      });
    });
  }
});
