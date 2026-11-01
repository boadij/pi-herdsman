import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

export const REPOSITORY_CLONE_TIMEOUT_MS = 30 * 60 * 1000;

const GIT_VERIFY_TIMEOUT_MS = 10_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED_NAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;

export type RepositorySource =
  | { kind: "local"; path: string }
  | {
      kind: "remote";
      url: string;
      host: string;
      pathSegments: readonly string[];
    };

export class RepositoryCloneError extends Error {
  readonly stage: "clone" | "verification";
  readonly destination: string;

  constructor(
    stage: "clone" | "verification",
    destination: string,
    message: string,
  ) {
    super(message);
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

export function resolveLocalRepositoryPath(
  value: string,
  homeDirectory = homedir(),
): string {
  if (!value || CONTROL_CHARACTERS.test(value))
    throw new Error("Repository path is empty or contains control characters");

  let path = value;
  if (value === "~") {
    path = homeDirectory;
  } else if (sep === "\\" ? /^~[\\/]/.test(value) : value.startsWith("~/")) {
    rejectTraversal(value.slice(2), "Repository path");
    path = join(homeDirectory, value.slice(2));
  } else if (!isAbsolute(value)) {
    throw new Error("Repository path must be absolute or start with ~/.");
  }

  rejectTraversal(path, "Repository path");
  return resolve(path);
}

export function parseRepositorySource(
  value: string,
  homeDirectory = homedir(),
): RepositorySource {
  if (value.length === 0 || CONTROL_CHARACTERS.test(value))
    throw new Error(
      "Repository source is empty or contains control characters",
    );

  if (/^(?:https|ssh):\/\//i.test(value)) return parseUrlRemote(value);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value))
    throw new Error("Only HTTPS and SSH Git remotes are supported");

  const scp = /^([^/@:\s]+)@([^/:?#\s]+):(.+)$/u.exec(value);
  if (scp) {
    const [, user, host, remotePath] = scp;
    if (!isSafeSshUser(user) || !isSafeSshHost(host))
      throw new Error("SSH Git remote has an unsupported authority");
    return remoteSource(value, host, remotePath.replace(/^\//, ""));
  }

  return {
    kind: "local",
    path: resolveLocalRepositoryPath(value, homeDirectory),
  };
}

function parseUrlRemote(value: string): RepositorySource {
  const match = /^(https|ssh):\/\/([^/?#]+)(\/[^?#]*)$/i.exec(value);
  if (!match || value.includes("\\"))
    throw new Error(
      "Git remote must be an HTTPS or SSH URL with a repository path",
    );

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Git remote URL is invalid");
  }
  if (
    parsed.protocol.toLowerCase() !== `${match[1].toLowerCase()}:` ||
    !parsed.hostname ||
    parsed.password ||
    (parsed.protocol === "https:" &&
      (parsed.username || match[2].includes("@"))) ||
    (parsed.protocol === "ssh:" &&
      ((parsed.username && !isSafeSshUser(parsed.username)) ||
        !isSafeSshHost(parsed.hostname)))
  )
    throw new Error("Git remote URL has an unsupported authority");

  const rawPath = match[3].slice(1);
  return remoteSource(value, parsed.host, rawPath);
}

function remoteSource(
  url: string,
  host: string,
  rawPath: string,
): RepositorySource {
  const pathSegments = rawPath.split("/").map((segment) => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new Error("Git remote path contains invalid URL encoding");
    }
    if (!isSafePathSegment(decoded))
      throw new Error("Git remote contains an unsafe path segment");
    return decoded;
  });
  if (pathSegments.length < 2)
    throw new Error("Git remote must include a namespace and repository");
  return { kind: "remote", url, host, pathSegments };
}

function isSafeSshUser(value: string): boolean {
  return /^[a-z\d_][a-z\d_.-]*$/i.test(value);
}

function isSafeSshHost(value: string): boolean {
  return (
    /^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(value) ||
    /^\[[a-f\d:.]+\]$/i.test(value)
  );
}

export function defaultCloneDestination(
  remote: string | Extract<RepositorySource, { kind: "remote" }>,
  projectsDirectory: string,
  homeDirectory = homedir(),
): string {
  const source =
    typeof remote === "string" ? parseRepositorySource(remote) : remote;
  if (source.kind !== "remote")
    throw new Error("A Git remote is required to derive a clone destination");

  const namespace = source.pathSegments.slice(0, -1);
  const repository = source.pathSegments.at(-1)!.replace(/\.git$/i, "");
  const segments = [...namespace, repository];
  if (
    segments.length < 2 ||
    segments.some((segment) => !isSafePathSegment(segment))
  )
    throw new Error("Cannot derive a safe clone destination");

  const root = resolveClonePath(projectsDirectory, homeDirectory);
  const destination = resolve(root, ...segments);
  assertContained(root, destination);
  return destination;
}

export async function cloneRepository(
  pi: Pick<ExtensionAPI, "exec">,
  remote: string,
  projectsDirectory: string,
  options: {
    destination?: string;
    homeDirectory?: string;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const source = parseRepositorySource(remote, options.homeDirectory);
  if (source.kind !== "remote")
    throw new Error("Only a supported Git remote can be cloned");

  const destination =
    options.destination !== undefined
      ? resolveClonePath(options.destination, options.homeDirectory)
      : defaultCloneDestination(
          source,
          projectsDirectory,
          options.homeDirectory,
        );
  const root =
    options.destination !== undefined
      ? dirname(destination)
      : resolveClonePath(projectsDirectory, options.homeDirectory);
  assertContained(root, destination);
  if (pathExists(destination))
    throw new CloneDestinationExistsError(destination);

  ensureDirectory(root);
  const rootIdentity = directoryIdentity(root);
  const parent = dirname(destination);
  ensureContainedDirectories(root, parent, rootIdentity);

  // shortcut: path checks cannot eliminate TOCTOU races, use directory-handle-relative APIs if hostile concurrent filesystem mutation must be defended against.
  // Git must never receive a destination that changed after path validation.
  assertRootUnchanged(root, rootIdentity);
  ensureContainedDirectories(root, parent, rootIdentity);
  if (pathExists(destination))
    throw new CloneDestinationExistsError(destination);

  const canonicalRoot = rootIdentity.path;
  const target = resolve(canonicalRoot, relative(root, destination));
  const cwd = realpathSync.native(parent);
  // Git accepts an empty existing destination, so reserve it before starting Git.
  try {
    mkdirSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CloneDestinationExistsError(target);
    throw error;
  }
  const reservation = lstatSync(target);
  if (!reservation.isDirectory() || reservation.isSymbolicLink())
    throw new Error("Clone destination could not be safely reserved");

  try {
    const result = await pi.exec("git", ["clone", "--", source.url, target], {
      cwd,
      signal: options.signal,
      timeout: REPOSITORY_CLONE_TIMEOUT_MS,
    });
    if (result.code !== 0 || result.killed)
      throw new Error(`git clone exited with code ${result.code}`);
  } catch {
    throw new RepositoryCloneError(
      "clone",
      target,
      `Git clone did not complete; its destination may be partial and was preserved: ${target}`,
    );
  }

  try {
    await verifyPrimaryCheckout(pi, target, canonicalRoot, options.signal);
  } catch {
    throw new RepositoryCloneError(
      "verification",
      target,
      `Git clone finished, but primary checkout verification failed; destination was preserved: ${target}`,
    );
  }
  return target;
}

/** Create a requested local project directory without following symlinks. */
export function assertSafeLocalRepositoryPath(value: string): string {
  const path = resolveLocalRepositoryPath(value);
  let existing = path;
  while (!pathExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing)
      throw new Error("Cannot find a safe repository path ancestor");
    existing = parent;
  }
  const canonicalExisting = realpathSync.native(existing);
  if (existing !== path && !statSync(canonicalExisting).isDirectory())
    throw new Error("Repository path ancestor is not a directory");
  return resolve(canonicalExisting, relative(existing, path));
}

/** Create a requested local project directory without following symlinks. */
export function ensureSafeLocalRepositoryDirectory(value: string): string {
  const path = assertSafeLocalRepositoryPath(value);
  ensureDirectory(path);
  assertSafeLocalRepositoryPath(path);
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Repository path is not a safe directory");
  return realpathSync.native(path);
}

async function verifyPrimaryCheckout(
  pi: Pick<ExtensionAPI, "exec">,
  destination: string,
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  const checkout = lstatSync(destination);
  if (!checkout.isDirectory() || checkout.isSymbolicLink())
    throw new Error("Clone destination is not a primary checkout directory");
  const canonicalCheckout = realpathSync.native(destination);
  assertContained(root, canonicalCheckout);
  if (canonicalCheckout !== destination)
    throw new Error("Clone destination changed during verification");
  const gitMetadata = lstatSync(join(canonicalCheckout, ".git"));
  if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink())
    throw new Error("Clone metadata is not a primary repository directory");
  const canonicalGitMetadata = realpathSync.native(
    join(canonicalCheckout, ".git"),
  );

  const runGit = (args: string[]) =>
    pi.exec("git", args, {
      cwd: destination,
      signal,
      timeout: GIT_VERIFY_TIMEOUT_MS,
    });
  const [top, gitDir, commonDir] = await Promise.all([
    runGit(["rev-parse", "--show-toplevel"]),
    runGit(["rev-parse", "--path-format=absolute", "--git-dir"]),
    runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ]);
  if (
    [top, gitDir, commonDir].some(
      (result) =>
        result.code !== 0 || result.killed || result.stderr.trim().length > 0,
    ) ||
    realpathSync.native(top.stdout.trim()) !== canonicalCheckout ||
    realpathSync.native(gitDir.stdout.trim()) !==
      realpathSync.native(commonDir.stdout.trim()) ||
    realpathSync.native(gitDir.stdout.trim()) !== canonicalGitMetadata
  )
    throw new Error("Git did not verify a primary checkout");
}

function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[\\/<>:"|?*]/.test(value) &&
    !CONTROL_CHARACTERS.test(value) &&
    !/[. ]$/.test(value) &&
    !WINDOWS_RESERVED_NAME.test(value)
  );
}

function resolveClonePath(value: string, homeDirectory?: string): string {
  const path = resolveLocalRepositoryPath(value, homeDirectory);
  const root = parse(path).root;
  if (
    path
      .slice(root.length)
      .split(sep)
      .some((segment) => !isSafePathSegment(segment))
  )
    throw new Error("Clone path contains an unsafe path segment");
  return path;
}

function rejectTraversal(value: string, label: string): void {
  const root = parse(value).root;
  const segments = value
    .slice(root.length)
    .split(sep === "\\" ? /[\\/]/ : /\//);
  if (segments.some((segment) => segment === "." || segment === ".."))
    throw new Error(`${label} cannot contain . or .. path segments`);
}

function assertContained(root: string, target: string): void {
  const path = relative(resolve(root), resolve(target));
  if (
    path &&
    (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
  )
    throw new Error("Clone destination escapes its allowed directory");
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function ensureDirectory(path: string): void {
  const missing: string[] = [];
  let current = resolve(path);
  while (!pathExists(current)) {
    missing.push(current);
    const parent = dirname(current);
    if (parent === current)
      throw new Error("Cannot find a safe directory ancestor");
    current = parent;
  }
  const anchor = lstatSync(current);
  const anchorPath = realpathSync.native(current);
  if (anchor.isSymbolicLink() || !anchor.isDirectory())
    throw new Error("Clone parent is not a directory");
  if (!statSync(anchorPath).isDirectory())
    throw new Error("Clone parent is not a directory");

  let parent = current;
  for (const directory of missing.reverse()) {
    if (dirname(directory) !== parent)
      throw new Error("Clone parent changed during directory creation");
    try {
      mkdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const created = lstatSync(directory);
    if (!created.isDirectory() || created.isSymbolicLink())
      throw new Error("Clone parent contains a symlink or non-directory");
    parent = directory;
  }
  const final = lstatSync(path);
  if (!final.isDirectory() || final.isSymbolicLink())
    throw new Error("Clone parent is not a directory");
}

type DirectoryIdentity = { path: string; dev: number; ino: number };

function directoryIdentity(path: string): DirectoryIdentity {
  const canonical = realpathSync.native(path);
  const stat = statSync(canonical);
  if (!stat.isDirectory()) throw new Error("Clone parent is not a directory");
  return { path: canonical, dev: stat.dev, ino: stat.ino };
}

function assertRootUnchanged(path: string, expected: DirectoryIdentity): void {
  const current = directoryIdentity(path);
  if (
    current.path !== expected.path ||
    current.dev !== expected.dev ||
    current.ino !== expected.ino
  )
    throw new Error("Clone parent changed during validation");
}

function ensureContainedDirectories(
  root: string,
  target: string,
  expectedRoot: DirectoryIdentity,
): void {
  assertRootUnchanged(root, expectedRoot);
  assertContained(root, target);
  let current = resolve(root);
  const segments = relative(root, target).split(sep).filter(Boolean);
  for (const segment of segments) {
    current = join(current, segment);
    if (pathExists(current)) {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error("Clone path contains a symlink or non-directory");
      assertContained(expectedRoot.path, realpathSync.native(current));
    } else {
      mkdirSync(current);
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Clone path changed during directory creation");
      assertContained(expectedRoot.path, realpathSync.native(current));
    }
    assertRootUnchanged(root, expectedRoot);
  }
}
