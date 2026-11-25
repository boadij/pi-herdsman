import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import {
  CloneDestinationExistsError,
  cloneRepository,
  createLocalRepositoryDirectory,
  parseRepositorySource,
  RepositoryCloneError,
  resolveLocalRepositoryPath,
} from "./repository.ts";

const remote = "https://example.test/owner/team/project.git";
const success = (stdout = "") => ({
  code: 0,
  killed: false,
  truncated: false,
  stdout,
  stderr: "",
});

function tempDirectory(t: { after: (fn: () => void) => void }) {
  const path = mkdtempSync(join(realpathSync.native(tmpdir()), "repository-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

type Exec = ExtensionAPI["exec"];

test("repository source accepts explicit local paths and supported Git remotes", () => {
  const home = join(tmpdir(), "home");
  const local = join(home, "projects", "repo");
  for (const path of [local, "~/projects/repo"]) {
    assert.deepEqual(parseRepositorySource(path, home), {
      kind: "local",
      path: local,
    });
  }
  for (const url of [
    remote,
    "ssh://git@example.test:2222/owner/team/project.git",
    "ssh://git@[::1]:2222/owner/team/project.git",
    "git@example.test:owner/team/project.git",
  ]) {
    assert.deepEqual(parseRepositorySource(url), {
      kind: "remote",
      url,
      pathSegments: ["owner", "team", "project.git"],
    });
  }

  if (sep === "/") {
    assert.equal(parseRepositorySource("~/name\\..\\file", home).kind, "local");
  } else {
    for (const path of [
      "C:repo",
      "\\repo",
      "\\\\?\\C:\\repo",
      "~/dir\\..\\repo",
      "~/repo:stream",
    ]) {
      assert.throws(() => parseRepositorySource(path, home), /path/i, path);
    }
  }
});

test("repository sources reject ambiguous paths, unsafe remote authorities, and unsafe segments", () => {
  for (const input of [
    "relative/project",
    "~someone/project",
    "~/../outside",
    "~/project/./child",
    "file:///local/repo",
    "ext::git-receive-pack",
    "https://@example.test/owner/project",
    "https://user:password@example.test/owner/project",
    "ssh://git:@example.test/owner/project",
    "ssh://git@example.test:/owner/project",
    "ssh://git@example.test:65536/owner/project",
    "ssh://git@[bad]/owner/project",
    "https://example..test/owner/project",
    "https://example.-test/owner/project",
    "ssh://-option@example.test/owner/project",
    "git@-option:owner/project",
    "https://example.test/a?query",
    "https://example.test/owner//project",
    "https://example.test/owner/%2e%2e/project",
    "https://example.test/owner/%2Fproject",
    "https://example.test/owner/%5cproject",
    "https://example.test/owner/%00project",
    "https://example.test/owner/.git/project",
    "https://example.test/owner/COM¹.txt",
    "https://example.test/owner/CON%20.txt",
    "https://example.test/owner/project.",
  ]) {
    assert.throws(() => parseRepositorySource(input), input);
  }
});

test("local resolution is non-mutating and rejects redirected ancestors and non-directories", (t) => {
  const root = tempDirectory(t);
  const missing = join(root, "missing", "project");
  assert.deepEqual(resolveLocalRepositoryPath(missing), {
    path: missing,
    exists: false,
  });
  assert.equal(existsSync(dirname(missing)), false);
  assert.equal(createLocalRepositoryDirectory(missing), missing);
  assert.deepEqual(resolveLocalRepositoryPath(missing), {
    path: missing,
    exists: true,
  });
  assert.throws(
    () => createLocalRepositoryDirectory(missing),
    /already exists/,
  );

  const file = join(root, "file");
  writeFileSync(file, "");
  assert.throws(() => resolveLocalRepositoryPath(file), /non-directory/);
  assert.throws(
    () => resolveLocalRepositoryPath(join(file, "child")),
    /non-directory/,
  );

  const alias = join(root, "alias");
  symlinkSync(missing, alias, "junction");
  assert.throws(() => resolveLocalRepositoryPath(alias), /symlink/);
  assert.throws(
    () => createLocalRepositoryDirectory(join(alias, "child")),
    /symlink/,
  );
  assert.equal(existsSync(join(missing, "child")), false);
});

test("clone reserves the safe default or explicit destination and returns verified Git identity", async (t) => {
  const home = tempDirectory(t);
  const signal = new AbortController().signal;
  for (const override of [undefined, join(home, "custom", "checkout")]) {
    const destination =
      override ?? join(home, "Projects", "owner", "team", "project");
    const metadata = join(destination, ".git");
    const commands: string[] = [];
    const exec: Exec = async (command, args, options) => {
      assert.equal(command, "git");
      assert.equal(options?.signal, signal);
      commands.push(args[0]!);
      if (args[0] === "clone") {
        assert.deepEqual(args, ["clone", "--", remote, destination]);
        assert.equal(options?.cwd, dirname(destination));
        assert.equal(options?.timeout, 30 * 60 * 1000);
        assert.throws(() => mkdirSync(destination), { code: "EEXIST" });
        mkdirSync(metadata);
        return success();
      }
      assert.equal(options?.cwd, destination);
      return success(args.includes("--show-toplevel") ? destination : metadata);
    };
    assert.deepEqual(
      await cloneRepository(
        { exec },
        remote,
        override ? "unused" : "~/Projects",
        {
          destination: override,
          homeDirectory: home,
          signal,
        },
      ),
      {
        checkoutPath: destination,
        canonicalRepoKey: metadata,
        isPrimary: true,
      },
    );
    assert.deepEqual(commands, [
      "clone",
      "rev-parse",
      "rev-parse",
      "rev-parse",
    ]);
  }
});

test("clone refuses occupied leaves, unsafe overrides, and symlinked parents without running Git", async (t) => {
  const root = tempDirectory(t);
  const occupied = join(root, "occupied");
  mkdirSync(occupied);
  const alias = join(root, "alias");
  symlinkSync(occupied, alias, "junction");
  let invoked = false;
  const exec: Exec = async () => {
    invoked = true;
    return success();
  };
  for (const destination of [occupied, alias]) {
    await assert.rejects(
      cloneRepository({ exec }, remote, root, { destination }),
      CloneDestinationExistsError,
    );
  }
  for (const destination of [
    join(alias, "project"),
    `${root}/../project`,
    join(root, "Aux.txt"),
  ]) {
    await assert.rejects(
      cloneRepository({ exec }, remote, root, { destination }),
      /symlink|unsafe/,
    );
  }
  await assert.rejects(cloneRepository({ exec }, remote, alias), /symlink/);
  await assert.rejects(
    cloneRepository({ exec }, "https://example.test/owner/aux.git", root),
    /unsafe/,
  );
  assert.equal(invoked, false);
  assert.equal(existsSync(join(occupied, "project")), false);
});

test("clone reports the directory left behind if preparation fails after mkdir", async (t) => {
  const root = tempDirectory(t);
  const oversize = "x".repeat(1024);
  const exec: Exec = async () => assert.fail("Git must not run");
  for (const at of ["parent", "leaf"]) {
    const created = join(root, at);
    const destination =
      at === "parent"
        ? join(created, oversize, "repo")
        : join(created, oversize);
    await assert.rejects(
      cloneRepository({ exec }, remote, root, { destination }),
      (error) =>
        error instanceof RepositoryCloneError &&
        error.stage === "preparation" &&
        error.destination === created,
    );
    assert.equal(existsSync(created), true);
  }
});

test("a redirected Git environment fails before filesystem mutation", async (t) => {
  const root = tempDirectory(t);
  const old = process.env.GIT_WORK_TREE;
  process.env.GIT_WORK_TREE = join(root, "redirected");
  try {
    const exec: Exec = async () => assert.fail("Git must not run");
    await assert.rejects(
      cloneRepository({ exec }, remote, join(root, "Projects")),
      /redirection/,
    );
    assert.equal(existsSync(join(root, "Projects")), false);
  } finally {
    if (old === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = old;
  }
});

test("clone classifies failures and preserves files at the exact reported destination", async (t) => {
  const root = tempDirectory(t);
  for (const stage of ["clone", "verification"] as const) {
    const destination = join(root, stage);
    const exec: Exec = async (_command, args) => {
      if (args[0] === "clone") {
        writeFileSync(join(destination, "partial"), "preserve me");
        mkdirSync(join(destination, ".git"));
        return { ...success(), code: stage === "clone" ? 1 : 0 };
      }
      // Native Git output pointing outside the requested checkout is not enough.
      return success(
        args.includes("--show-toplevel") ? root : join(destination, ".git"),
      );
    };
    await assert.rejects(
      cloneRepository({ exec }, remote, root, { destination }),
      (error) =>
        error instanceof RepositoryCloneError &&
        error.stage === stage &&
        error.destination === destination,
    );
    assert.equal(existsSync(join(destination, "partial")), true);
  }
});
