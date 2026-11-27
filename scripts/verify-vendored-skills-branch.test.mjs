import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  verifyBranchSnapshot,
  verifyExistingBranch,
} from "./verify-vendored-skills-branch.mjs";

const snapshotPath = "vendor/github-cli/SKILL.md";
const notesPath = "docs/notes.md";
const entry = (sha, mode = "100644") => ({
  type: "blob",
  mode,
  sha: sha.repeat(40),
});

test("accepts the exact intended snapshot while ignoring unrelated main advancement", () => {
  const oldNotes = entry("a");
  const newNotes = entry("b");
  const oldSkill = entry("c");
  const intendedSkill = entry("d");
  const mergeBaseTree = new Map([
    [notesPath, oldNotes],
    [snapshotPath, oldSkill],
  ]);
  const mainTree = new Map([
    [notesPath, newNotes],
    [snapshotPath, oldSkill],
  ]);
  const branchTree = new Map([
    [notesPath, oldNotes],
    [snapshotPath, intendedSkill],
  ]);

  assert.doesNotThrow(() =>
    verifyBranchSnapshot({
      mainTree,
      mergeBaseTree,
      branchTree,
      intendedChanges: new Map([[snapshotPath, intendedSkill]]),
    }),
  );
});

test("rejects injected extra or altered branch content", async (t) => {
  await t.test("extra path", () => {
    const oldSkill = entry("a");
    const intendedSkill = entry("b");
    const injected = entry("c");
    assert.throws(
      () =>
        verifyBranchSnapshot({
          mainTree: new Map([[snapshotPath, oldSkill]]),
          mergeBaseTree: new Map([[snapshotPath, oldSkill]]),
          branchTree: new Map([
            [snapshotPath, intendedSkill],
            ["extension/injected.ts", injected],
          ]),
          intendedChanges: new Map([[snapshotPath, intendedSkill]]),
        }),
      /Unexpected reserved branch change: extension\/injected\.ts/u,
    );
  });

  await t.test("altered managed bytes", () => {
    const oldSkill = entry("a");
    const intendedSkill = entry("b");
    const alteredSkill = entry("c");
    assert.throws(
      () =>
        verifyBranchSnapshot({
          mainTree: new Map([[snapshotPath, oldSkill]]),
          mergeBaseTree: new Map([[snapshotPath, oldSkill]]),
          branchTree: new Map([[snapshotPath, alteredSkill]]),
          intendedChanges: new Map([[snapshotPath, intendedSkill]]),
        }),
      /differs from intended snapshot/u,
    );
  });
});

test("accepts an obsolete PR when main already contains its proposed snapshot", () => {
  const oldSkill = entry("a");
  const proposedSkill = entry("b");
  assert.doesNotThrow(() =>
    verifyBranchSnapshot({
      mainTree: new Map([[snapshotPath, proposedSkill]]),
      mergeBaseTree: new Map([[snapshotPath, oldSkill]]),
      branchTree: new Map([[snapshotPath, proposedSkill]]),
      intendedChanges: new Map(),
    }),
  );
});

test("rejects a stale proposal instead of regenerating it", () => {
  const oldSkill = entry("a");
  const previousProposal = entry("b");
  const currentProposal = entry("c");
  assert.throws(
    () =>
      verifyBranchSnapshot({
        mainTree: new Map([[snapshotPath, oldSkill]]),
        mergeBaseTree: new Map([[snapshotPath, oldSkill]]),
        branchTree: new Map([[snapshotPath, previousProposal]]),
        intendedChanges: new Map([[snapshotPath, currentProposal]]),
      }),
    /differs from intended snapshot/u,
  );
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
  writeFileSync(skillPath, "intended snapshot\n");
  const mainSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const intendedBlob = execFileSync(
    "git",
    ["hash-object", "--no-filters", "--", snapshotPath],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const branchSha = "c".repeat(40);
  const baseTree = [
    { path: snapshotPath, mode: "100644", type: "blob", sha: mainBlob },
  ];
  const intendedTree = [
    { path: snapshotPath, mode: "100644", type: "blob", sha: intendedBlob },
  ];
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
      return response({ truncated: false, tree: intendedTree });
    }
    throw new Error(`Unexpected API request: ${url}`);
  };
  return { root, request, branchTree: intendedTree };
}

test("workflow verifier accepts only the complete reconciler snapshot", async (t) => {
  for (const [label, mutate, expected] of [
    ["exact intended bytes", () => {}, undefined],
    [
      "injected extra file",
      (tree) =>
        tree.push({
          path: "extension/injected.ts",
          mode: "100644",
          type: "blob",
          sha: "d".repeat(40),
        }),
      /Unexpected reserved branch change/,
    ],
    [
      "altered intended bytes",
      (tree) => (tree[0].sha = "e".repeat(40)),
      /differs from intended snapshot/,
    ],
  ]) {
    await t.test(label, async (subtest) => {
      const fixture = integrationFixture();
      subtest.after(() =>
        rmSync(fixture.root, { recursive: true, force: true }),
      );
      mutate(fixture.branchTree);
      const verify = () =>
        verifyExistingBranch({
          request: fixture.request,
          token: "test-token",
          repository: "example/repo",
          branchSha: "c".repeat(40),
          root: fixture.root,
        });
      if (expected) await assert.rejects(verify, expected);
      else await verify();
    });
  }
});
