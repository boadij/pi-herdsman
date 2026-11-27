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

import {
  allowedChange,
  updateVendoredSkills,
} from "./update-vendored-skills.mjs";

const cliCommit = "a".repeat(40);
const stackCommit = "b".repeat(40);
const cliTreeUrl = `https://api.github.com/repos/cli/cli/git/trees/${cliCommit}?recursive=1`;
const stackTreeUrl = `https://api.github.com/repos/github/gh-stack/git/trees/${stackCommit}?recursive=1`;
const cliLicense = Buffer.from("CLI license\n");
const stackLicense = Buffer.from("Stack license\n");
const initial = {
  cli: new Map([["SKILL.md", Buffer.from("cli old\n")]]),
  stack: new Map([
    ["SKILL.md", Buffer.from("stack old\n")],
    ["references/keep.md", Buffer.from("keep\n")],
    ["references/obsolete/remove.md", Buffer.from("remove\n")],
  ]),
};

function blobHash(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function fixture(stack = initial.stack) {
  const root = mkdtempSync(join(tmpdir(), "vendored-skills-"));
  for (const [vendor, files, license, commit] of [
    ["github-cli", initial.cli, cliLicense, "1".repeat(40)],
    ["gh-stack", stack, stackLicense, "2".repeat(40)],
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
  truncateTree = false,
} = {}) {
  const requests = [];
  const blobByHash = new Map(
    [...cli.values(), ...stack.values()].map((bytes) => [
      blobHash(bytes),
      bytes,
    ]),
  );
  const response = (value, status = 200) =>
    new Response(JSON.stringify(value), { status });
  const request = async (url) => {
    requests.push(url);
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
    if (url === cliTreeUrl || url === stackTreeUrl) {
      if (url === stackTreeUrl && failStackTree)
        return response({ message: "failed" }, 503);
      const [root, files] =
        url === cliTreeUrl ? ["skills/gh", cli] : ["skills/gh-stack", stack];
      const directories = new Set([root]);
      for (const path of files.keys()) {
        const segments = path.split("/");
        segments.pop();
        let parent = root;
        for (const segment of segments) {
          parent += `/${segment}`;
          directories.add(parent);
        }
      }
      const tree = [
        ...[...directories].map((path) => ({
          path,
          type: "tree",
          mode: "040000",
        })),
        ...[...files].map(([path, bytes]) => ({
          path: `${root}/${path}`,
          type: "blob",
          mode: "100644",
          sha: blobHash(bytes),
        })),
      ];
      return response({
        tree,
        truncated: url === stackTreeUrl && truncateTree,
      });
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
    existsSync(join(root, "vendor/gh-stack/references/obsolete/remove.md")),
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

test("workflow stages the next update when the checkout has no references directory", async (t) => {
  const stack = new Map([["SKILL.md", initial.stack.get("SKILL.md")]]);
  const root = fixture(stack);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "--no-gpg-sign",
    "-m",
    "accepted snapshot without references",
  );
  assert.equal(existsSync(join(root, "vendor/gh-stack/references")), false);
  assert.equal(git("status", "--porcelain"), "");

  const cli = new Map([["SKILL.md", Buffer.from("cli revised\n")]]);
  const { request } = upstream({ cli, stack });
  await reconcile(root, { request });

  // Read the workflow's literal block rather than duplicating its pathspecs.
  const workflow = readFileSync(
    new URL("../.github/workflows/gh-skill-drift.yml", import.meta.url),
    "utf8",
  );
  const addPaths = workflow.match(
    /^ {10}add-paths: \|\r?\n((?: {12}\S[^\r\n]*\r?\n)+)/mu,
  );
  assert.ok(addPaths, "expected the workflow's add-paths literal block");
  // The pinned create-pull-request action uses one git add for all paths.
  const paths = addPaths[1]
    .split(/[\n,]+/u)
    .map((path) => path.trim())
    .filter(Boolean);
  git("add", "--", ...paths);
  assert.equal(
    git("diff", "--cached", "--name-only").trim(),
    "vendor/github-cli/SKILL.md\nvendor/github-cli/source.json",
  );
});

test("reconciles reference file and directory transitions in both directions", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const topic = "references/topic.md";
  const intro = `${topic}/nested/intro.md`;
  const bytes = Buffer.from("topic\n");
  const stackRoot = join(root, "vendor/gh-stack");
  const untouched = join(stackRoot, "references/unrelated");
  mkdirSync(untouched);
  writeFileSync(join(stackRoot, topic), bytes);
  const stack = new Map([...initial.stack, [topic, bytes]]);
  for (const [from, to] of [
    [topic, intro],
    [intro, topic],
  ]) {
    stack.delete(from);
    stack.set(to, bytes);
    const { request } = upstream({ stack });
    const [, update] = await reconcile(root, { request, checkGit: false });
    assert.deepEqual(update.removed, [from]);
    assert.deepEqual(update.added, [to]);
    assert.deepEqual(readFileSync(join(stackRoot, to)), bytes);
    assert.equal(existsSync(untouched), true);
  }
});

test("rejects unmanaged contents blocking a managed write during preparation and application", async (t) => {
  for (const stage of ["preparation", "application"]) {
    await t.test(stage, async (subtest) => {
      const root = fixture();
      subtest.after(() => rmSync(root, { recursive: true, force: true }));
      const topic = "references/topic.md";
      const destination = join(root, "vendor/gh-stack", topic);
      mkdirSync(destination);
      const blocker = join(destination, "unmanaged directory");
      if (stage === "preparation") mkdirSync(blocker);
      const before = contents(root);
      const bytes = Buffer.from("replacement\n");
      const stack = new Map([...initial.stack, [topic, bytes]]);
      const cli =
        stage === "preparation"
          ? new Map([["SKILL.md", Buffer.from("must not apply\n")]])
          : initial.cli;
      const base = upstream({ cli, stack });
      const request = async (url, init) => {
        if (
          stage === "application" &&
          url.endsWith(`/git/blobs/${blobHash(bytes)}`)
        ) {
          symlinkSync(join(root, "vendor/gh-stack/README.md"), blocker);
        }
        return base.request(url, init);
      };
      await assert.rejects(
        reconcile(root, { request, checkGit: false }),
        /Directory blocks managed write: gh-stack\/references\/topic\.md\/unmanaged directory/,
      );
      assert.equal(existsSync(blocker), true);
      assert.deepEqual(contents(root), before);
    });
  }
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
      "wrong skill root",
      (state) => (state.wrongIdentity = true),
      /Missing upstream skill root: cli\/cli\/skills\/gh/,
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
        if (state.wrongIdentity && url === cliTreeUrl) {
          return Response.json({
            truncated: false,
            tree: [{ type: "tree", mode: "040000", path: "skills/other" }],
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
        if (url !== stackTreeUrl) return result;
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

test("requires a complete CLI tree containing only an ordinary SKILL.md", async (t) => {
  const cases = [
    ...[
      ["executable", { mode: "100755" }],
      ["symlink", { mode: "120000" }],
      ["submodule", { type: "commit", mode: "160000" }],
      ["bad SHA", { sha: "bad" }],
      ["wrong filename", { path: "skills/gh/skill.md" }],
    ].map(([label, override]) => [
      label,
      ({ tree }) => Object.assign(tree[1], override),
      /Unsupported upstream file/,
    ]),
    [
      "truncated",
      (body) => (body.truncated = true),
      /expected complete github-cli tree/,
    ],
    [
      "missing",
      ({ tree }) => tree.pop(),
      /Missing upstream file: github-cli\/SKILL.md/,
    ],
    ["duplicate", ({ tree }) => tree.push(tree[1]), /duplicate tree path/],
    [
      "supporting file",
      ({ tree }) => tree.push({ ...tree[1], path: "skills/gh/README.md" }),
      /Unsupported upstream file: skills\/gh\/README.md/,
    ],
    [
      "reference directory",
      ({ tree }) => tree.push({ ...tree[0], path: "skills/gh/references" }),
      /Unsupported upstream directory/,
    ],
  ];
  for (const [label, mutate, expected] of cases) {
    await t.test(label, async (subtest) => {
      const root = fixture();
      subtest.after(() => rmSync(root, { recursive: true, force: true }));
      const before = contents(root);
      const base = upstream();
      const request = async (url, init) => {
        const result = await base.request(url, init);
        if (url !== cliTreeUrl) return result;
        const body = await result.json();
        mutate(body);
        return Response.json(body);
      };
      await assert.rejects(
        reconcile(root, { request, checkGit: false }),
        expected,
      );
      assert.deepEqual(contents(root), before);
    });
  }
});

test("allows only managed snapshot and provenance paths for publication", () => {
  for (const [path, expected] of [
    ["vendor/gh-stack/references/nested/example.md", true],
    ["vendor/gh-stack/references/nested/my file.md", false],
    ["vendor/gh-stack/references/my folder/example.md", false],
    ["vendor/github-cli/references/example.md", false],
    ["vendor/github-cli/SKILL.md", true],
    ["vendor/github-cli/source.json", true],
  ]) {
    assert.equal(allowedChange(path), expected, path);
  }
});

test("rejects symlinks in existing managed reference paths", async (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const refs = join(root, "vendor/gh-stack/references/obsolete");
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
