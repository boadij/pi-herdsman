import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  CloneDestinationExistsError,
  cloneRepository,
  createLocalRepositoryDirectory,
  parseRepositorySource,
  RepositoryCloneError,
  resolveCheckoutCloneSource,
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

function isolatedGit(root: string, overrides: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, "global"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    ...overrides,
  };
  return (args: string[], cwd = root) => {
    const result = spawnSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 16 * 1024,
    });
    return {
      code: result.status ?? 1,
      killed: result.signal !== null,
      truncated:
        result.error !== undefined &&
        "code" in result.error &&
        result.error.code === "ENOBUFS",
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };
}

test("checkout clone source reads only a single supported effective origin fetch URL", async (t) => {
  const root = tempDirectory(t);
  const git = isolatedGit(root);
  const configure = (...args: string[]) => assert.equal(git(args).code, 0);
  configure("init", "-q");
  const exec: Exec = async (command, args, options) => {
    assert.equal(command, "git");
    assert.ok(args[0] === "rev-parse" || args[0] === "remote");
    assert.equal(options?.maxBuffer, 16 * 1024);
    return git(args, options?.cwd);
  };
  const source = (path = root) => resolveCheckoutCloneSource({ exec }, path);
  const message =
    /^Cannot resolve a single supported fetch URL from origin at the exact Git checkout root\. Supply an explicit HTTPS or SSH Git remote URL\.$/;
  const rejected = (path?: string) => assert.rejects(source(path), { message });
  configure("remote", "add", "unrelated", remote);
  await rejected();
  configure("remote", "add", "origin", "fixture:project.git");
  configure(
    "config",
    "url.https://example.test/owner/team/.insteadOf",
    "fixture:",
  );
  configure(
    "remote",
    "set-url",
    "--push",
    "origin",
    "git@example.test:push/project.git",
  );
  assert.deepEqual(await source(), parseRepositorySource(remote));
  const child = join(root, "child");
  mkdirSync(child);
  await rejected(child);

  configure("config", "--add", "remote.origin.url", "fixture:project.git");
  await rejected();
  for (const invalid of [
    root,
    "file:///tmp/source.git",
    "ext::unsupported",
    "https://user:secret@example.test/owner/project.git",
    "",
  ]) {
    configure("config", "--replace-all", "remote.origin.url", invalid);
    await rejected();
  }
});

test("checkout clone source fails closed on incomplete, cancelled or stale observations", async (t) => {
  const root = tempDirectory(t);
  const metadata = join(root, ".git");
  mkdirSync(metadata);
  for (const outcome of [
    "killed",
    "truncated",
    "missing terminator",
    "cancelled",
    "replaced",
  ] as const) {
    const abort = new AbortController();
    let observedOrigin = false;
    const exec: Exec = async (_command, args) => {
      if (args[0] === "rev-parse")
        return success(args.includes("--show-toplevel") ? root : metadata);
      assert.deepEqual(args, ["remote", "get-url", "--all", "origin"]);
      observedOrigin = true;
      if (outcome === "cancelled") abort.abort();
      if (outcome === "replaced") {
        const retired = metadata + "-retired";
        renameSync(metadata, retired);
        mkdirSync(metadata);
      }
      return {
        ...success(outcome === "missing terminator" ? remote : remote + "\n"),
        killed: outcome === "killed",
        truncated: outcome === "truncated",
      };
    };
    await assert.rejects(
      resolveCheckoutCloneSource({ exec }, root, abort.signal),
      outcome === "cancelled"
        ? { name: "AbortError" }
        : /explicit HTTPS or SSH/,
      outcome,
    );
    assert.ok(observedOrigin, outcome);
  }
});

test("clone of an observed origin is not rewritten again in destination Git config", async (t) => {
  const root = tempDirectory(t);
  const git = isolatedGit(root);
  const destination = join(root, "clone");
  const config = join(root, "conditional");
  const url = "https://example.test/owner/project=fixture.git";
  assert.equal(git(["init", "-q"]).code, 0);
  assert.equal(
    git([
      "config",
      "-f",
      config,
      `url.${pathToFileURL(root).href}.insteadOf`,
      url,
    ]).code,
    0,
  );
  const gitDir = join(destination, ".git").replaceAll("\\", "/");
  assert.equal(
    git(["config", "--global", `includeIf.gitdir:${gitDir}.path`, config]).code,
    0,
  );
  // The same configured URL is rewritten for an ordinary explicit clone.
  await cloneRepository(
    { exec: async (_command, args, options) => git(args, options?.cwd) },
    url,
    root,
    { destination },
  );
  rmSync(destination, { recursive: true });
  let cloneStderr: string | undefined;
  await assert.rejects(
    cloneRepository(
      {
        exec: async (_command, args, options) => {
          const result = git(args, options?.cwd);
          cloneStderr = result.stderr;
          return result;
        },
      },
      url,
      root,
      { destination, effectiveCheckoutOrigin: true },
    ),
    RepositoryCloneError,
  );
  // With only file transport enabled, the protected path makes no network connection.
  assert.match(cloneStderr ?? "", /transport 'https' not allowed/);
});

test("protected clone loads URL-conditioned SSH config and verifies the persisted effective origin", async (t) => {
  const root = tempDirectory(t);
  const fixture = join(root, "transport");
  const auth = join(root, "auth");
  const url = "ssh://git@example.test/owner/project=fixture.git";
  const git = isolatedGit(root, {
    GIT_ALLOW_PROTOCOL: "ssh",
    GIT_SSH_COMMAND: undefined,
    GIT_SSH_VARIANT: "simple",
    HERDSMAN_TEST_REPO: fixture,
  });
  const configure = (...args: string[]) => assert.equal(git(args).code, 0);
  configure("init", "-q", fixture);
  configure("config", "--global", "core.sshCommand", "false");
  configure(
    "config",
    "--global",
    `includeIf.hasconfig:remote.*.url:${url}.path`,
    auth,
  );
  // Only the matching include enables the transport; it never opens a socket.
  configure(
    "config",
    "-f",
    auth,
    "core.sshCommand",
    `sh -c 'test "$1" = git@example.test && exec git upload-pack "$HERDSMAN_TEST_REPO"' --`,
  );
  const exec: Exec = async (_command, args, options) => git(args, options?.cwd);
  const clone = (destination: string) =>
    cloneRepository({ exec }, url, root, {
      destination,
      effectiveCheckoutOrigin: true,
    });
  const destination = join(root, "clone");
  assert.equal((await clone(destination)).checkoutPath, destination);
  assert.equal(git(["remote"], destination).stdout.trim(), "origin");
  assert.equal(
    git(["remote", "get-url", "--all", "origin"], destination).stdout.trim(),
    url,
  );

  // The same include adds a rewrite for the validated URL. Initial transport
  // must still succeed over SSH, but the persisted origin must fail verification.
  const conflicting = pathToFileURL(fixture).href;
  configure("config", "-f", auth, `url.${conflicting}.insteadOf`, url);
  const partial = join(root, "partial");
  await assert.rejects(clone(partial), (error) => {
    assert.ok(error instanceof RepositoryCloneError);
    assert.equal(error.stage, "verification");
    assert.equal(error.destination, partial);
    assert.ok(!error.message.includes(url));
    assert.ok(!error.message.includes(conflicting));
    return true;
  });
  assert.ok(existsSync(join(partial, ".git")));
  assert.equal(
    git(["remote", "get-url", "--all", "origin"], partial).stdout.trim(),
    conflicting,
  );
});

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
  const selection = resolveLocalRepositoryPath(missing);
  assert.equal(selection.path, missing);
  assert.equal(selection.exists, false);
  assert.equal(existsSync(dirname(missing)), false);
  const created = createLocalRepositoryDirectory(selection);
  assert.equal(created.path, missing);
  assert.equal(created.exists, true);
  assert.throws(
    () => createLocalRepositoryDirectory(created),
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
    () => resolveLocalRepositoryPath(join(alias, "child")),
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
    await assert.rejects(
      resolveCheckoutCloneSource({ exec }, root),
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
