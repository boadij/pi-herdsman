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
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import {
  CloneDestinationExistsError,
  cloneRepository,
  defaultCloneDestination,
  parseRepositorySource,
  REPOSITORY_CLONE_TIMEOUT_MS,
  RepositoryCloneError,
  assertSafeLocalRepositoryPath,
  resolveLocalRepositoryPath,
} from "./repository.ts";

test("repository sources parse local, HTTPS, SSH, and scp-style inputs", () => {
  const home = join(tmpdir(), "repository-home");
  assert.deepEqual(parseRepositorySource("/work/project", home), {
    kind: "local",
    path: resolve("/work/project"),
  });
  assert.deepEqual(parseRepositorySource("~/work/project", home), {
    kind: "local",
    path: join(home, "work", "project"),
  });
  assert.equal(resolveLocalRepositoryPath("~", home), home);

  for (const [url, host] of [
    ["https://github.com/owner/team/repo.git", "github.com"],
    ["ssh://git@github.com/owner/team/repo.git", "github.com"],
    ["git@github.com:owner/team/repo.git", "github.com"],
  ]) {
    const source = parseRepositorySource(url);
    assert.deepEqual(source, {
      kind: "remote",
      url,
      host,
      pathSegments: ["owner", "team", "repo.git"],
    });
    assert.equal(
      defaultCloneDestination(source, "~/Projects", home),
      join(home, "Projects", "owner", "team", "repo"),
    );
  }
});

test("source and destination paths reject relative inputs and traversal", () => {
  const root = tmpdir();
  const slashTraversal = `${root.replace(/\\/g, "/")}/../outside`;
  const traversalPaths = [slashTraversal];
  if (sep === "\\") traversalPaths.push(`${root}\\..\\outside`);

  for (const path of [
    "project",
    "~other/project",
    "~/work/../outside",
    "/work/./project",
    ...traversalPaths,
  ]) {
    assert.throws(() => parseRepositorySource(path), /absolute|~|path/i);
  }
  for (const url of [
    "https://github.com/owner/../repo.git",
    "https://github.com/owner/%2e%2e/repo.git",
    "https://github.com/owner%2frepo/repo.git",
    "https://github.com/owner//repo.git",
  ]) {
    assert.throws(() => defaultCloneDestination(url, "/tmp/Projects"));
  }
  for (const segment of [
    "CON",
    "folder.",
    "bad:name",
    "bad\\name",
    "NUL.txt",
    "COM¹",
    "COM².txt",
    "COM³",
    "LPT¹",
    "LPT².txt",
    "LPT³",
  ]) {
    assert.throws(() =>
      defaultCloneDestination(
        `https://example.test/owner/${segment}`,
        "/tmp/Projects",
      ),
    );
  }
});

test(
  "POSIX repository paths keep backslashes literal",
  { skip: sep !== "/" },
  () => {
    const home = join(tmpdir(), "repository-home");
    const absolute = join(tmpdir(), "name\\..\\file");
    assert.equal(resolveLocalRepositoryPath(absolute), resolve(absolute));
    assert.equal(
      resolveLocalRepositoryPath("~/name\\..\\file", home),
      join(home, "name\\..\\file"),
    );
  },
);

test("local paths canonicalize symlinked ancestors and missing suffixes", () => {
  const root = mkdtempSync(join(tmpdir(), "repository-local-path-"));
  const actual = join(root, "actual");
  const alias = join(root, "alias");
  mkdirSync(actual);
  symlinkSync(actual, alias, "dir");
  try {
    assert.equal(
      assertSafeLocalRepositoryPath(alias),
      realpathSync.native(actual),
    );
    assert.equal(
      assertSafeLocalRepositoryPath(join(alias, "new", "project")),
      join(realpathSync.native(actual), "new", "project"),
    );
    assert.equal(
      assertSafeLocalRepositoryPath(tmpdir()),
      realpathSync.native(tmpdir()),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clone uses a bounded native git invocation and verifies a primary checkout", async () => {
  const root = mkdtempSync(join(tmpdir(), "repository-clone-"));
  const projects = join(root, "Projects");
  const calls: { command: string; args: string[]; options: any }[] = [];
  try {
    const pi = {
      async exec(command: string, args: string[], options: any) {
        calls.push({ command, args, options });
        if (args[0] === "clone") {
          const destination = args[3]!;
          mkdirSync(join(destination, ".git"), { recursive: true });
          return execResult();
        }
        if (args[0] === "rev-parse") {
          const destination = calls[0]!.args[3]!;
          if (args[1] === "--show-toplevel") return execResult(destination);
          return execResult(join(destination, ".git"));
        }
        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
    };

    const checkout = await cloneRepository(
      pi as any,
      "https://github.com/owner/team/repo.git",
      projects,
    );
    assert.equal(
      checkout,
      join(realpathSync.native(projects), "owner", "team", "repo"),
    );
    assert.deepEqual(calls[0]!.args, [
      "clone",
      "--",
      "https://github.com/owner/team/repo.git",
      checkout,
    ]);
    assert.equal(calls[0]!.command, "git");
    assert.equal(calls[0]!.options.cwd, dirname(checkout));
    assert.equal(calls[0]!.options.timeout, REPOSITORY_CLONE_TIMEOUT_MS);
    assert.ok(calls.every((call) => call.command === "git"));
    assert.equal(calls.length, 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clone reserves its destination before Git so a racing creator cannot claim it", async () => {
  const root = mkdtempSync(join(tmpdir(), "repository-clone-race-"));
  const projects = join(root, "Projects");
  const destination = join(
    realpathSync.native(root),
    "Projects",
    "owner",
    "race",
  );
  let competitorCreatedDestination = false;
  try {
    const pi = {
      async exec(_command: string, args: string[]) {
        if (args[0] === "clone") {
          try {
            mkdirSync(args[3]!);
            competitorCreatedDestination = true;
            writeFileSync(
              join(args[3]!, "competitor"),
              "must not be populated",
            );
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, "EEXIST");
          }
          writeFileSync(join(args[3]!, "partial"), "uncertain clone output");
          return execResult("", 128);
        }
        throw new Error("verification must not run after clone failure");
      },
    };

    await assert.rejects(
      cloneRepository(pi as any, "https://github.com/owner/race.git", projects),
      (error) =>
        error instanceof RepositoryCloneError &&
        error.stage === "clone" &&
        error.destination === destination,
    );
    assert.equal(competitorCreatedDestination, false);
    assert.equal(exists(join(destination, "competitor")), false);
    assert.equal(exists(join(destination, "partial")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit destinations are validated and existing destinations collide", async () => {
  const root = mkdtempSync(join(tmpdir(), "repository-destination-"));
  const projects = join(root, "Projects");
  const existing = join(root, "chosen", "checkout");
  mkdirSync(existing, { recursive: true });
  let calls = 0;
  const pi = {
    async exec() {
      calls++;
      return execResult();
    },
  };
  try {
    await assert.rejects(
      cloneRepository(pi as any, "git@github.com:owner/repo.git", projects, {
        destination: existing,
      }),
      CloneDestinationExistsError,
    );
    await assert.rejects(
      cloneRepository(pi as any, "git@github.com:owner/repo.git", projects, {
        destination: "relative/checkout",
      }),
      /absolute|~/i,
    );
    await assert.rejects(
      cloneRepository(pi as any, "git@github.com:owner/repo.git", projects, {
        destination: `${root}/chosen/../outside`,
      }),
      /\. or \.\./,
    );
    if (sep === "\\") {
      await assert.rejects(
        cloneRepository(pi as any, "git@github.com:owner/repo.git", projects, {
          destination: `${root}\\chosen\\..\\outside`,
        }),
        /\. or \.\./,
      );
    }
    await assert.rejects(
      cloneRepository(pi as any, "git@github.com:owner/repo.git", projects, {
        destination: `${root}/bad:name/checkout`,
      }),
      /unsafe path segment/i,
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("clone rejects symlinked namespace ancestors without invoking git", async () => {
  const root = mkdtempSync(join(tmpdir(), "repository-symlink-"));
  const projects = join(root, "Projects");
  const outside = join(root, "outside");
  mkdirSync(projects);
  mkdirSync(outside);
  symlinkSync(outside, join(projects, "owner"), "dir");
  let calls = 0;
  try {
    await assert.rejects(
      cloneRepository(
        {
          async exec() {
            calls++;
            return execResult();
          },
        } as any,
        "https://github.com/owner/repo.git",
        projects,
      ),
      /symlink|directory/i,
    );
    assert.equal(calls, 0);
    assert.equal(exists(join(outside, "repo")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed and unverifiable clones retain any partial destination", async () => {
  const root = mkdtempSync(join(tmpdir(), "repository-failure-"));
  const projects = join(root, "Projects");
  const remote = "https://github.com/owner/repo.git";
  const target = join(realpathSync.native(root), "Projects", "owner", "repo");
  try {
    const failed = {
      async exec(_command: string, args: string[]) {
        if (args[0] === "clone") {
          mkdirSync(args[3]!, { recursive: true });
          writeFileSync(join(args[3]!, "partial"), "uncertain");
          return execResult("", 128);
        }
        throw new Error("verification must not run after clone failure");
      },
    };
    await assert.rejects(
      cloneRepository(failed as any, remote, projects),
      (error) =>
        error instanceof RepositoryCloneError &&
        error.stage === "clone" &&
        error.destination === target,
    );
    assert.equal(exists(join(target, "partial")), true);

    const unverifiable = {
      async exec(_command: string, args: string[]) {
        if (args[0] === "clone") {
          mkdirSync(args[3]!, { recursive: true });
          return execResult();
        }
        return execResult("", 128);
      },
    };
    const unverifiableRemote = "https://github.com/owner/unverifiable.git";
    const unverifiableTarget = join(
      realpathSync.native(root),
      "Projects",
      "owner",
      "unverifiable",
    );
    await assert.rejects(
      cloneRepository(unverifiable as any, unverifiableRemote, projects),
      (error) =>
        error instanceof RepositoryCloneError &&
        error.stage === "verification" &&
        error.destination === unverifiableTarget,
    );
    assert.equal(exists(unverifiableTarget), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function execResult(stdout = "", code = 0) {
  return { stdout, stderr: "", code, killed: false };
}

function exists(path: string): boolean {
  return existsSync(path);
}
