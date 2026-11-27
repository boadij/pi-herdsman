import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { updateVendoredSkills } from "./update-vendored-skills.mjs";

const cliCommit = "a".repeat(40);
const stackCommit = "b".repeat(40);
const cliLicense = Buffer.from("CLI license\n");
const stackLicense = Buffer.from("Stack license\n");
const initial = {
  cli: new Map([["SKILL.md", Buffer.from("cli old\n")]]),
  stack: new Map([
    ["SKILL.md", Buffer.from("stack old\n")],
    ["references/keep.md", Buffer.from("keep\n")],
    ["references/remove.md", Buffer.from("remove\n")],
  ]),
};

function blobHash(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vendored-skills-"));
  for (const [vendor, files, license, commit] of [
    ["github-cli", initial.cli, cliLicense, "1".repeat(40)],
    ["gh-stack", initial.stack, stackLicense, "2".repeat(40)],
  ]) {
    const directory = join(root, "vendor", vendor);
    mkdirSync(directory, { recursive: true });
    for (const [path, bytes] of files) {
      const fullPath = join(directory, path);
      mkdirSync(join(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, bytes);
    }
    writeFileSync(join(directory, "LICENSE"), license);
    writeFileSync(
      join(directory, "README.md"),
      `maintainer data for ${vendor}\n`,
    );
    writeFileSync(join(directory, ".gitattributes"), "local attributes\n");
    writeFileSync(
      join(directory, "source.json"),
      `${JSON.stringify({ commit }, null, 2)}\n`,
    );
  }
  return root;
}

async function reconcile(root, options) {
  const summaryDirectory = mkdtempSync(
    join(tmpdir(), "vendored-skills-summary-"),
  );
  try {
    return await updateVendoredSkills({
      root,
      summaryPath: join(summaryDirectory, "summary.md"),
      ...options,
    });
  } finally {
    rmSync(summaryDirectory, { recursive: true, force: true });
  }
}

function upstream({
  cli = initial.cli,
  stack = initial.stack,
  failStackTree = false,
  license = stackLicense,
  malformed = new Set(),
  truncateTree = false,
} = {}) {
  const requests = [];
  const cliTree = [...cli].map(([path, bytes]) => [path, bytes]);
  const stackTree = [...stack].map(([path, bytes]) => [path, bytes]);
  const blobByHash = new Map(
    [...cliTree, ...stackTree].map(([, bytes]) => [blobHash(bytes), bytes]),
  );
  const response = (value, status = 200) =>
    new Response(JSON.stringify(value), { status });
  const request = async (url) => {
    requests.push(url);
    if (malformed.has(url)) return new Response("not json");
    if (url.endsWith("/repos/cli/cli/git/ref/heads/trunk")) {
      return response({
        ref: "refs/heads/trunk",
        object: { type: "commit", sha: cliCommit },
      });
    }
    if (url.endsWith("/repos/github/gh-stack/git/ref/heads/main")) {
      return response({
        ref: "refs/heads/main",
        object: { type: "commit", sha: stackCommit },
      });
    }
    if (url.includes("/repos/cli/cli/contents/LICENSE?ref=")) {
      return response({
        type: "file",
        path: "LICENSE",
        sha: blobHash(cliLicense),
      });
    }
    if (url.includes("/repos/github/gh-stack/contents/LICENSE?ref=")) {
      return response({
        type: "file",
        path: "LICENSE",
        sha: blobHash(license),
      });
    }
    if (url.includes("/repos/cli/cli/contents/skills/gh/SKILL.md?ref=")) {
      const bytes = cli.get("SKILL.md");
      return response({
        type: "file",
        path: "skills/gh/SKILL.md",
        sha: blobHash(bytes),
      });
    }
    if (url.includes("/repos/github/gh-stack/git/trees/")) {
      if (failStackTree) return response({ message: "failed" }, 503);
      const tree = [
        { path: "skills/gh-stack", type: "tree", mode: "040000" },
        ...stackTree.map(([path, bytes]) => ({
          path: `skills/gh-stack/${path}`,
          type: "blob",
          mode: "100644",
          sha: blobHash(bytes),
        })),
      ];
      return response({ tree, truncated: truncateTree });
    }
    const match = url.match(
      /\/repos\/(cli\/cli|github\/gh-stack)\/git\/blobs\/([a-f0-9]{40})$/u,
    );
    if (match) {
      const bytes = blobByHash.get(match[2]);
      return response({
        sha: match[2],
        encoding: "base64",
        size: bytes.length,
        content: bytes.toString("base64"),
      });
    }
    throw new Error(`Unexpected request ${url}`);
  };
  return { request, requests };
}

function contents(root) {
  const read = (path) => readFileSync(join(root, path));
  return {
    cliSkill: read("vendor/github-cli/SKILL.md"),
    cliProvenance: read("vendor/github-cli/source.json"),
    stackSkill: read("vendor/gh-stack/SKILL.md"),
    stackProvenance: read("vendor/gh-stack/source.json"),
    keep: read("vendor/gh-stack/references/keep.md"),
    readme: read("vendor/gh-stack/README.md"),
  };
}

test("unchanged bytes at newer upstream commits do not change provenance or download content", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = contents(root);
  const { request, requests } = upstream();
  const prepared = await reconcile(root, { request, checkGit: false });
  assert.deepEqual(
    prepared.map((item) => item.writes.size),
    [0, 0],
  );
  assert.deepEqual(contents(root), before);
  assert.equal(
    requests.some((url) => url.includes("/git/blobs/")),
    false,
  );
});

test("reconciles bytes, additions, removals and provenance; repeat is idempotent", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cli = new Map([["SKILL.md", Buffer.from("cli revised\n")]]);
  const stack = new Map([
    ["SKILL.md", Buffer.from("stack revised\n")],
    ["references/keep.md", Buffer.from("keep\n")],
    ["references/nested/new.md", Buffer.from("new reference\0bytes")],
  ]);
  const first = upstream({ cli, stack });
  const bodyPath = join(root, "review.md");
  await reconcile(root, {
    request: first.request,
    checkGit: false,
    prBodyPath: bodyPath,
  });
  assert.deepEqual(
    readFileSync(join(root, "vendor/github-cli/SKILL.md")),
    cli.get("SKILL.md"),
  );
  assert.deepEqual(
    readFileSync(join(root, "vendor/gh-stack/SKILL.md")),
    stack.get("SKILL.md"),
  );
  assert.deepEqual(
    readFileSync(join(root, "vendor/gh-stack/references/nested/new.md")),
    stack.get("references/nested/new.md"),
  );
  assert.equal(
    existsSync(join(root, "vendor/gh-stack/references/remove.md")),
    false,
  );
  assert.equal(
    readFileSync(join(root, "vendor/gh-stack/README.md"), "utf8"),
    "maintainer data for gh-stack\n",
  );
  assert.equal(
    readFileSync(join(root, "vendor/gh-stack/source.json"), "utf8"),
    `${JSON.stringify({ commit: stackCommit }, null, 2)}\n`,
  );
  const body = readFileSync(bodyPath, "utf8");
  assert.match(
    body,
    new RegExp(
      `https://github\\.com/cli/cli/compare/${"1".repeat(40)}\\.\\.\\.${cliCommit}`,
    ),
  );
  assert.match(body, /gh-stack\/references\/nested\/new\.md: added/u);
  const after = contents(root);
  const second = upstream({ cli, stack });
  const prepared = await reconcile(root, {
    request: second.request,
    checkGit: false,
  });
  assert.deepEqual(
    prepared.map((item) => [item.added, item.modified, item.removed]),
    [
      [[], [], []],
      [[], [], []],
    ],
  );
  assert.deepEqual(contents(root), after);
  assert.equal(
    second.requests.some((url) => url.includes("/git/blobs/")),
    false,
  );
});

test("does not apply either source when preparation of the second source fails", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = contents(root);
  const changedCli = new Map([["SKILL.md", Buffer.from("must not apply\n")]]);
  const { request } = upstream({ cli: changedCli, failStackTree: true });
  await assert.rejects(
    reconcile(root, { request, checkGit: false }),
    /HTTP 503/,
  );
  assert.deepEqual(contents(root), before);
});

test("rejects invalid upstream data", async (t) => {
  const cases = [
    [
      "malformed JSON",
      (state) =>
        state.malformed.add(
          "https://api.github.com/repos/cli/cli/git/ref/heads/trunk",
        ),
      /expected JSON/,
    ],
    [
      "truncated tree",
      (state) => (state.truncateTree = true),
      /expected complete gh-stack tree/,
    ],
    [
      "bad source SHA",
      (state) => (state.badRefSha = true),
      /expected github-cli trunk commit/,
    ],
    [
      "wrong content identity",
      (state) => (state.wrongIdentity = true),
      /expected exact github-cli SKILL.md/,
    ],
  ];
  for (const [label, configure, expected] of cases) {
    await t.test(label, async (subtest) => {
      const root = fixture();
      subtest.after(() => rmSync(root, { recursive: true, force: true }));
      const before = contents(root);
      const state = { malformed: new Set(), truncateTree: false };
      configure(state);
      const base = upstream({ truncateTree: state.truncateTree });
      const request = async (url, init) => {
        if (state.malformed.has(url)) return new Response("not json");
        if (
          state.badRefSha &&
          url.endsWith("/repos/cli/cli/git/ref/heads/trunk")
        ) {
          return Response.json({
            ref: "refs/heads/trunk",
            object: { type: "commit", sha: "bad" },
          });
        }
        if (
          state.wrongIdentity &&
          url.includes("/repos/cli/cli/contents/skills/gh/SKILL.md?ref=")
        ) {
          return Response.json({
            type: "file",
            path: "other/SKILL.md",
            sha: blobHash(initial.cli.get("SKILL.md")),
          });
        }
        return base.request(url, init);
      };
      await assert.rejects(
        reconcile(root, { request, checkGit: false }),
        expected,
      );
      assert.deepEqual(contents(root), before);
    });
  }
});

test("rejects executable, unsupported and metadata-overwriting upstream paths", async (t) => {
  const cases = [
    [
      "executable",
      {
        path: "skills/gh-stack/references/run.md",
        type: "blob",
        mode: "100755",
        sha: "c".repeat(40),
      },
    ],
    [
      "unsupported extension",
      {
        path: "skills/gh-stack/references/run.txt",
        type: "blob",
        mode: "100644",
        sha: "c".repeat(40),
      },
    ],
    [
      "metadata overwrite",
      {
        path: "skills/gh-stack/source.json",
        type: "blob",
        mode: "100644",
        sha: "c".repeat(40),
      },
    ],
  ];
  for (const [label, unsafe] of cases) {
    await t.test(label, async (subtest) => {
      const root = fixture();
      subtest.after(() => rmSync(root, { recursive: true, force: true }));
      const before = contents(root);
      const base = upstream();
      const request = async (url, init) => {
        const result = await base.request(url, init);
        if (!url.includes("/repos/github/gh-stack/git/trees/")) return result;
        const body = await result.json();
        body.tree.push(unsafe);
        return Response.json(body);
      };
      await assert.rejects(
        reconcile(root, { request, checkGit: false }),
        /Unsupported upstream file/,
      );
      assert.deepEqual(contents(root), before);
    });
  }
});

test("rejects symlinks in existing managed reference paths", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const refs = join(root, "vendor/gh-stack/references");
  rmSync(join(refs, "remove.md"));
  symlinkSync(join(root, "vendor/gh-stack/SKILL.md"), join(refs, "remove.md"));
  const { request } = upstream();
  await assert.rejects(
    reconcile(root, { request, checkGit: false }),
    /Symlink in managed path/,
  );
});

test("stops when a pinned upstream license differs", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const before = contents(root);
  const { request } = upstream({ license: Buffer.from("changed license\n") });
  await assert.rejects(
    reconcile(root, { request, checkGit: false }),
    /Upstream license changed/,
  );
  assert.deepEqual(contents(root), before);
});

test("rejects changes outside the managed snapshots before publication", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const args of [
    ["init"],
    ["config", "user.name", "Test"],
    ["config", "user.email", "test@example.invalid"],
    ["add", "."],
    ["commit", "-m", "fixture"],
  ]) {
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  }
  writeFileSync(join(root, "unexpected.txt"), "must not publish\n");
  const { request } = upstream();
  await assert.rejects(
    reconcile(root, { request }),
    /Unexpected changed path\(s\): unexpected\.txt/,
  );
});
