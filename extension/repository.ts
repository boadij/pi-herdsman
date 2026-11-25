import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse } from "node:path";
import { gitRepositoryScope, sameDirectory } from "./herdr.ts";
import {
  absolutePath,
  hasControls,
  pathSegments,
  resolveClonePath,
  safeCloneSegment,
} from "./repository-path.ts";

type RemoteSource = {
  kind: "remote";
  url: string;
  pathSegments: readonly string[];
};

export type RepositorySource = { kind: "local"; path: string } | RemoteSource;

export class RepositoryCloneError extends Error {
  readonly stage: "preparation" | "clone" | "verification";
  readonly destination: string;

  constructor(stage: RepositoryCloneError["stage"], destination: string) {
    super(
      stage === "preparation"
        ? `Clone preparation failed before Git ran; created directory was left in place: ${destination}`
        : stage === "clone"
          ? `Git clone did not complete; destination may be partial and was preserved: ${destination}`
          : `Git clone finished but checkout verification failed; destination was preserved: ${destination}`,
    );
    this.name = "RepositoryCloneError";
    this.stage = stage;
    this.destination = destination;
  }
}

export class CloneDestinationExistsError extends Error {
  readonly destination: string;

  constructor(destination: string) {
    super(`Clone destination already exists: ${destination}`);
    this.name = "CloneDestinationExistsError";
    this.destination = destination;
  }
}

export function parseRepositorySource(
  value: string,
  homeDirectory = homedir(),
): RepositorySource {
  if (hasControls(value))
    throw new Error("Repository source contains control characters");

  const url = /^(https|ssh):\/\/([^/?#]+)\/([^?#]+)$/.exec(value);
  const scp =
    /^([a-z\d_][a-z\d_.-]*)@(\[[a-f\d:.]+\]|[a-z\d.-]+):\/?(.+)$/i.exec(value);
  if (!url && !scp) {
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(value))
      throw new Error(
        "Expected an HTTPS or SSH Git remote with a repository path",
      );
    return { kind: "local", path: absolutePath(value, homeDirectory) };
  }

  // Native Git receives the original string. Check its raw authority, not only
  // the authority normalized by the URL parser.
  const authority = url ? url[2]! : `${scp![1]}@${scp![2]}`;
  const remotePath = url ? url[3]! : scp![3]!;
  const parts =
    /^(?:([a-z\d_][a-z\d_.-]*)@)?(\[[a-f\d:.]+\]|[a-z\d](?:[a-z\d.-]*[a-z\d])?)(?::(\d+))?$/i.exec(
      authority,
    );
  if (
    !parts ||
    (url?.[1] === "https" && parts[1]) ||
    (parts[3] && (+parts[3] < 1 || +parts[3] > 65535)) ||
    /[\s\\]/.test(value)
  )
    throw new Error("Git remote has an unsupported authority or path");
  const host = parts[2]!;
  if (host.startsWith("[")) {
    try {
      // Validate IPv6 literals without normalizing the input passed to Git.
      new URL(`https://${host}/`);
    } catch {
      throw new Error("Git remote has an unsupported host");
    }
  } else if (
    !host
      .split(".")
      .every((label) => /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(label))
  ) {
    throw new Error("Git remote has an unsupported host");
  }
  const segments = remotePath.split("/").map((segment) => {
    let decoded: string;
    try {
      decoded = url ? decodeURIComponent(segment) : segment;
    } catch {
      throw new Error("Git remote path contains invalid URL encoding");
    }
    if (!safeCloneSegment(decoded))
      throw new Error("Git remote contains an unsafe path segment");
    return decoded;
  });
  return { kind: "remote", url: value, pathSegments: segments };
}

function directoryEntry(path: string) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

/** Walk every component; lstat on only the leaf misses redirected ancestors. */
function inspectDirectory(path: string) {
  let current = parse(path).root;
  const segments = pathSegments(path);
  for (const [index, segment] of segments.entries()) {
    const next = join(current, segment);
    const info = directoryEntry(next);
    if (!info) {
      const anchor = realpathSync.native(current);
      return {
        path: join(anchor, ...segments.slice(index)),
        exists: false,
        anchor,
      };
    }
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(
        `Repository path contains a symlink or non-directory: ${next}`,
      );
    current = next;
  }
  const anchor = realpathSync.native(current);
  return { path: anchor, exists: true, anchor };
}

/** Inspect only; the caller owns approval for creation and Git bootstrap. */
export function resolveLocalRepositoryPath(value: string) {
  const selected = inspectDirectory(absolutePath(value, homedir()));
  const identity = directoryEntry(selected.anchor);
  if (!identity?.isDirectory() || identity.dev === 0n || identity.ino === 0n)
    throw new Error("Cannot verify local repository directory identity");
  return { ...selected, dev: identity.dev, ino: identity.ino };
}

type LocalSelection = ReturnType<typeof resolveLocalRepositoryPath>;

export function verifyLocalRepositoryPath(selected: LocalSelection): void {
  const current = resolveLocalRepositoryPath(selected.path);
  if (
    current.exists !== selected.exists ||
    current.anchor !== selected.anchor ||
    current.dev !== selected.dev ||
    current.ino !== selected.ino
  )
    throw new Error("Approved local repository path changed");
}

/** Create a missing, previously approved local path; never adopt a new leaf. */
export function createLocalRepositoryDirectory(
  target: LocalSelection,
): LocalSelection {
  if (target.exists)
    throw new Error(
      `Local repository directory already exists: ${target.path}`,
    );
  verifyLocalRepositoryPath(target);
  const missing = [];
  for (let path = target.path; path !== target.anchor; path = dirname(path)) {
    if (dirname(path) === path)
      throw new Error("Approved local repository ancestor is unavailable");
    missing.push(path);
  }
  let parent = resolveLocalRepositoryPath(target.anchor);
  if (parent.dev !== target.dev || parent.ino !== target.ino)
    throw new Error("Approved local repository ancestor changed");
  for (const path of missing.reverse()) {
    verifyLocalRepositoryPath(parent);
    // Exclusive mkdir: never adopt a directory created while approval was pending.
    mkdirSync(path);
    parent = resolveLocalRepositoryPath(path);
    if (!parent.exists)
      throw new Error("New local repository directory disappeared");
  }
  return parent;
}

function ensureParentDirectory(
  path: string,
  onCreated?: (path: string) => void,
): string {
  const current = inspectDirectory(path);
  if (current.exists) return current.path;
  ensureParentDirectory(dirname(current.path), onCreated);
  // Fail rather than adopt an entry created concurrently.
  mkdirSync(current.path);
  onCreated?.(current.path);
  return inspectDirectory(current.path).path;
}

function cloneDestination(
  source: RemoteSource,
  projectsDirectory: string,
  options: { destination?: string; homeDirectory?: string },
): string {
  const path = resolveClonePath(
    options.destination ?? projectsDirectory,
    options.homeDirectory,
  );
  if (options.destination !== undefined) {
    if (dirname(path) === path)
      throw new Error("A filesystem root cannot be a clone destination");
    return path;
  }
  const segments = [...source.pathSegments];
  const repository = segments.pop()!.replace(/\.git$/i, "");
  if (!safeCloneSegment(repository))
    throw new Error("Cannot derive a safe clone destination");
  return join(path, ...segments, repository);
}

/** Clone without changing Git trust or accepting an occupied destination. */
export async function cloneRepository(
  pi: Pick<ExtensionAPI, "exec">,
  remote: string,
  projectsDirectory: string,
  options: {
    destination?: string;
    homeDirectory?: string;
    signal?: AbortSignal;
  } = {},
): Promise<Awaited<ReturnType<typeof gitRepositoryScope>>> {
  const source = parseRepositorySource(remote, options.homeDirectory);
  if (source.kind !== "remote")
    throw new Error("Only supported HTTPS and SSH Git remotes can be cloned");
  const target = cloneDestination(source, projectsDirectory, options);
  options.signal?.throwIfAborted();
  if (
    [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    ].some((key) => process.env[key] !== undefined)
  )
    throw new Error(
      "Cannot clone while Git repository redirection variables are set",
    );

  let cwd: string;
  let destination: string;
  let createdParent: string | undefined;
  try {
    // Check parents before reserving the leaf so a symlink cannot redirect it.
    cwd = ensureParentDirectory(dirname(target), (path) => {
      createdParent = path;
    });
    destination = join(cwd, pathSegments(target).at(-1)!);
    try {
      // Git accepts existing empty directories, so reserve the leaf ourselves.
      mkdirSync(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new CloneDestinationExistsError(destination);
      throw error;
    }
  } catch (error) {
    if (createdParent)
      throw new RepositoryCloneError("preparation", createdParent);
    throw error;
  }

  let stage: RepositoryCloneError["stage"] = "clone";
  try {
    const reserved = directoryEntry(destination);
    const assertReservation = () => {
      // Path checks cannot eliminate races with hostile concurrent filesystem
      // mutations while a separate native Git process is using the path.
      const inspected = inspectDirectory(destination);
      const current = directoryEntry(destination);
      if (
        !reserved ||
        !inspected.exists ||
        !current?.isDirectory() ||
        reserved.dev !== current.dev ||
        reserved.ino !== current.ino
      )
        throw new Error("Clone destination changed after reservation");
    };
    assertReservation();
    const result = await pi.exec(
      "git",
      ["clone", "--", source.url, destination],
      {
        cwd,
        signal: options.signal,
        timeout: 30 * 60 * 1000,
      },
    );
    if (result.code !== 0 || result.killed || options.signal?.aborted)
      throw new Error("Git clone did not complete");

    stage = "verification";
    assertReservation();
    const metadata = join(destination, ".git");
    const gitDir = directoryEntry(metadata);
    if (!gitDir?.isDirectory() || gitDir.isSymbolicLink())
      throw new Error("Clone metadata is not a primary repository directory");
    const scope = await gitRepositoryScope(pi, destination, options.signal);
    assertReservation();
    const verifiedGitDir = directoryEntry(metadata);
    if (
      !verifiedGitDir?.isDirectory() ||
      verifiedGitDir.isSymbolicLink() ||
      verifiedGitDir.dev !== gitDir.dev ||
      verifiedGitDir.ino !== gitDir.ino ||
      !scope.isPrimary ||
      !sameDirectory(scope.checkoutPath, destination) ||
      !sameDirectory(scope.canonicalRepoKey, metadata)
    )
      throw new Error("Git did not verify the expected primary checkout");
    options.signal?.throwIfAborted();
    return scope;
  } catch {
    // Do not remove our reservation or any contents Git left there.
    throw new RepositoryCloneError(stage, destination);
  }
}
