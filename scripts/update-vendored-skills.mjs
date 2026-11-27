import { createHash } from "node:crypto";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const shaPattern = /^[a-f0-9]{40}$/u;
const sources = [
  {
    name: "github-cli",
    repository: "cli/cli",
    branch: "trunk",
    upstreamPath: "skills/gh",
    destination: "vendor/github-cli",
    includeReferences: false,
  },
  {
    name: "gh-stack",
    repository: "github/gh-stack",
    branch: "main",
    upstreamPath: "skills/gh-stack",
    destination: "vendor/gh-stack",
    includeReferences: true,
  },
];

function blobHash(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function isManagedFile(source, path) {
  return (
    path === "SKILL.md" ||
    (source.includeReferences &&
      /^references\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.md$/u.test(
        path,
      ))
  );
}

function readJson(response, label) {
  return response.json().catch(() => {
    throw new Error(`Invalid upstream response: ${label} (expected JSON)`);
  });
}

async function lookup(source, endpoint, label, { request, token, missing }) {
  let response;
  try {
    response = await request(
      `https://api.github.com/repos/${source.repository}/${endpoint}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new Error(`Lookup failed: ${label} (request error)`);
  }
  if (missing && response.status === 404) {
    throw new Error(`Missing upstream file: ${label}`);
  }
  if (!response.ok) {
    throw new Error(`Lookup failed: ${label} (HTTP ${response.status})`);
  }
  return readJson(response, label);
}

function decodeBase64(value, label, size) {
  if (typeof value !== "string") {
    throw new Error(
      `Invalid upstream response: ${label} (expected base64 content)`,
    );
  }
  const compact = value.replace(/\s/gu, "");
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      compact,
    )
  ) {
    throw new Error(
      `Invalid upstream response: ${label} (malformed base64 content)`,
    );
  }
  const bytes = Buffer.from(compact, "base64");
  if (
    bytes.toString("base64") !== compact ||
    (size !== undefined && size !== bytes.length)
  ) {
    throw new Error(
      `Invalid upstream response: ${label} (invalid content size or encoding)`,
    );
  }
  return bytes;
}

function safeStat(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function checkedPath(root, source, relativePath, { create = false } = {}) {
  if (!isManagedFile(source, relativePath)) {
    throw new Error(`Unsupported managed path: ${source.name}/${relativePath}`);
  }
  const destination = join(root, source.destination);
  const vendorStat = safeStat(join(root, "vendor"));
  if (!vendorStat?.isDirectory() || vendorStat.isSymbolicLink()) {
    throw new Error("Unsafe vendor parent directory: vendor");
  }
  const fullPath = join(destination, ...relativePath.split("/"));
  const rel = relative(destination, fullPath);
  if (rel.startsWith(`..${sep}`) || rel === ".." || rel.includes(`..${sep}`)) {
    throw new Error(`Unsafe destination path: ${source.name}/${relativePath}`);
  }
  let current = destination;
  const rootStat = safeStat(current);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Unsafe vendor directory: ${source.destination}`);
  }
  for (const segment of relativePath.split("/")) {
    current = join(current, segment);
    const stat = safeStat(current);
    if (stat?.isSymbolicLink()) {
      throw new Error(
        `Symlink in managed path: ${source.name}/${relativePath}`,
      );
    }
    if (stat && current !== fullPath && !stat.isDirectory()) {
      throw new Error(
        `Non-directory in managed path: ${source.name}/${relativePath}`,
      );
    }
    if (!stat && create && current !== fullPath) mkdirSync(current);
  }
  const stat = safeStat(fullPath);
  if (stat && !stat.isFile()) {
    throw new Error(`Non-file in managed path: ${source.name}/${relativePath}`);
  }
  return fullPath;
}

function localSnapshot(root, source) {
  const directory = join(root, source.destination);
  const vendorStat = safeStat(join(root, "vendor"));
  if (!vendorStat?.isDirectory() || vendorStat.isSymbolicLink()) {
    throw new Error("Unsafe vendor parent directory: vendor");
  }
  const rootStat = safeStat(directory);
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Unsafe vendor directory: ${source.destination}`);
  }
  const provenancePath = join(directory, "source.json");
  const provenanceStat = safeStat(provenancePath);
  if (!provenanceStat?.isFile() || provenanceStat.isSymbolicLink()) {
    throw new Error(`Invalid vendored provenance: ${source.name}/source.json`);
  }
  let provenance;
  try {
    provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
  } catch {
    throw new Error(`Invalid vendored provenance: ${source.name}/source.json`);
  }
  if (
    typeof provenance?.commit !== "string" ||
    !shaPattern.test(provenance.commit)
  ) {
    throw new Error(
      `Invalid vendored provenance: expected reviewed upstream commit SHA (${source.name})`,
    );
  }

  const files = new Map();
  function visit(directoryPath) {
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const fullPath = join(directoryPath, entry.name);
      const relativePath = relative(directory, fullPath).split(sep).join("/");
      const stat = safeStat(fullPath);
      if (stat?.isSymbolicLink()) {
        if (
          relativePath === "references" ||
          relativePath.startsWith("references/")
        ) {
          throw new Error(
            `Symlink in managed path: ${source.name}/${relativePath}`,
          );
        }
        continue;
      }
      if (stat.isDirectory()) {
        if (
          !source.includeReferences ||
          (relativePath !== "references" &&
            !relativePath.startsWith("references/"))
        ) {
          continue;
        }
        visit(fullPath);
      } else if (stat.isFile() && isManagedFile(source, relativePath)) {
        checkedPath(root, source, relativePath);
        files.set(relativePath, blobHash(readFileSync(fullPath)));
      } else if (
        relativePath === "SKILL.md" ||
        relativePath.startsWith("references/")
      ) {
        throw new Error(
          `Unsupported local managed path: ${source.name}/${relativePath}`,
        );
      }
    }
  }
  visit(directory);
  if (!files.has("SKILL.md"))
    throw new Error(`Missing vendored file: ${source.name}/SKILL.md`);
  return { commit: provenance.commit, files };
}

async function resolveCommit(source, options) {
  const reference = await lookup(
    source,
    `git/ref/heads/${source.branch}`,
    `${source.name} ${source.branch} ref`,
    options,
  );
  const commit = reference?.object?.sha;
  if (
    reference?.ref !== `refs/heads/${source.branch}` ||
    reference.object?.type !== "commit" ||
    typeof commit !== "string" ||
    !shaPattern.test(commit)
  ) {
    throw new Error(
      `Invalid upstream response: expected ${source.name} ${source.branch} commit`,
    );
  }
  return commit;
}

async function upstreamLicense(source, commit, options) {
  const license = await lookup(
    source,
    `contents/LICENSE?ref=${commit}`,
    `${source.name} license`,
    { ...options, missing: true },
  );
  if (
    license?.type !== "file" ||
    license.path !== "LICENSE" ||
    typeof license.sha !== "string" ||
    !shaPattern.test(license.sha)
  ) {
    throw new Error(
      `Invalid upstream response: expected ${source.name} LICENSE at ${commit}`,
    );
  }
  const localLicense = readFileSync(
    join(options.root, source.destination, "LICENSE"),
  );
  if (license.sha !== blobHash(localLicense)) {
    throw new Error(
      `Upstream license changed; review ${source.repository}/blob/${commit}/LICENSE before updating`,
    );
  }
}

async function enumerateUpstream(source, commit, options) {
  const result = new Map();
  const api = { ...options };
  if (!source.includeReferences) {
    const path = `${source.upstreamPath}/SKILL.md`;
    const file = await lookup(
      source,
      `contents/${path}?ref=${commit}`,
      `${source.name} SKILL.md`,
      { ...api, missing: true },
    );
    if (
      file?.type !== "file" ||
      file.path !== path ||
      typeof file.sha !== "string" ||
      !shaPattern.test(file.sha)
    ) {
      throw new Error(
        `Invalid upstream response: expected exact ${source.name} SKILL.md and blob SHA`,
      );
    }
    result.set("SKILL.md", file.sha);
    return result;
  }

  const tree = await lookup(
    source,
    `git/trees/${commit}?recursive=1`,
    `${source.name} skill tree`,
    api,
  );
  if (tree?.truncated !== false || !Array.isArray(tree.tree)) {
    throw new Error(
      `Invalid upstream response: expected complete ${source.name} tree`,
    );
  }
  const rootPath = `${source.upstreamPath}/`;
  let rootFound = false;
  const paths = new Set();
  for (const entry of tree.tree) {
    if (typeof entry?.path !== "string")
      throw new Error("Invalid upstream response: expected tree path");
    if (entry.path === source.upstreamPath) {
      if (rootFound || entry.type !== "tree" || entry.mode !== "040000") {
        throw new Error(
          `Invalid upstream skill root: ${source.repository}/${entry.path}`,
        );
      }
      rootFound = true;
      continue;
    }
    if (!entry.path.startsWith(rootPath)) continue;
    if (paths.has(entry.path))
      throw new Error(
        `Invalid upstream response: duplicate tree path ${entry.path}`,
      );
    paths.add(entry.path);
    const relativePath = entry.path.slice(rootPath.length);
    if (entry.type === "tree") {
      if (
        entry.mode !== "040000" ||
        (relativePath !== "references" &&
          !/^references\/(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u.test(
            relativePath,
          ))
      ) {
        throw new Error(`Unsupported upstream directory: ${entry.path}`);
      }
      continue;
    }
    if (
      entry.type !== "blob" ||
      entry.mode !== "100644" ||
      typeof entry.sha !== "string" ||
      !shaPattern.test(entry.sha) ||
      !isManagedFile(source, relativePath)
    ) {
      throw new Error(`Unsupported upstream file: ${entry.path}`);
    }
    result.set(relativePath, entry.sha);
  }
  if (!rootFound)
    throw new Error(
      `Missing upstream skill root: ${source.repository}/${source.upstreamPath} at ${commit}`,
    );
  if (!result.has("SKILL.md"))
    throw new Error(
      `Missing upstream file: ${source.name}/SKILL.md at ${commit}`,
    );
  return result;
}

async function downloadBlob(source, sha, path, options) {
  const blob = await lookup(
    source,
    `git/blobs/${sha}`,
    `${source.name} blob ${path}`,
    options,
  );
  if (blob?.sha !== sha || blob.encoding !== "base64") {
    throw new Error(
      `Invalid upstream response: expected base64 blob ${sha} for ${source.name}/${path}`,
    );
  }
  const bytes = decodeBase64(blob.content, `${source.name}/${path}`, blob.size);
  if (blobHash(bytes) !== sha)
    throw new Error(`Upstream blob integrity failure: ${source.name}/${path}`);
  return bytes;
}

async function prepare(source, root, options) {
  const local = localSnapshot(root, source);
  const upstreamCommit = await resolveCommit(source, { ...options, root });
  await upstreamLicense(source, upstreamCommit, { ...options, root });
  const upstream = await enumerateUpstream(source, upstreamCommit, {
    ...options,
    root,
  });
  const added = [...upstream.keys()]
    .filter((path) => !local.files.has(path))
    .sort();
  const modified = [...upstream.keys()]
    .filter(
      (path) =>
        local.files.has(path) && local.files.get(path) !== upstream.get(path),
    )
    .sort();
  const removed = [...local.files.keys()]
    .filter((path) => !upstream.has(path))
    .sort();
  const writes = new Map();
  for (const path of [...added, ...modified]) {
    writes.set(
      path,
      await downloadBlob(source, upstream.get(path), path, options),
    );
  }
  return {
    source,
    previousCommit: local.commit,
    upstreamCommit,
    upstream,
    writes,
    added,
    modified,
    removed,
  };
}

function apply(prepared, root) {
  for (const update of prepared) {
    if (
      !update.added.length &&
      !update.modified.length &&
      !update.removed.length
    )
      continue;
    for (const [path, bytes] of update.writes) {
      const destination = checkedPath(root, update.source, path, {
        create: true,
      });
      writeFileSync(destination, bytes);
    }
    for (const path of update.removed) {
      const destination = checkedPath(root, update.source, path);
      rmSync(destination);
    }
    if (update.source.includeReferences) {
      const references = join(root, update.source.destination, "references");
      const prune = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const child = join(directory, entry.name);
          if (entry.isDirectory()) prune(child);
        }
        if (directory !== references && readdirSync(directory).length === 0)
          rmSync(directory, { recursive: false });
      };
      if (safeStat(references)?.isDirectory()) prune(references);
    }
    writeFileSync(
      join(root, update.source.destination, "source.json"),
      `${JSON.stringify({ commit: update.upstreamCommit }, null, 2)}\n`,
    );
  }
}

function verify(prepared, root) {
  for (const update of prepared) {
    const actual = localSnapshot(root, update.source);
    if (actual.files.size !== update.upstream.size) {
      throw new Error(
        `Applied snapshot does not match upstream file set: ${update.source.name}`,
      );
    }
    for (const [path, sha] of update.upstream) {
      if (actual.files.get(path) !== sha) {
        throw new Error(
          `Applied snapshot does not match upstream blob: ${update.source.name}/${path}`,
        );
      }
    }
    const changed =
      update.added.length || update.modified.length || update.removed.length;
    const expectedCommit = changed
      ? update.upstreamCommit
      : update.previousCommit;
    if (actual.commit !== expectedCommit) {
      throw new Error(
        `Applied provenance does not match expected commit: ${update.source.name}`,
      );
    }
  }
}

function changedPaths(root) {
  const tracked = execFileSync("git", ["diff", "--name-only", "-z"], {
    cwd: root,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

export function allowedChange(path) {
  return (
    path === "vendor/github-cli/SKILL.md" ||
    path === "vendor/github-cli/source.json" ||
    path === "vendor/gh-stack/SKILL.md" ||
    path === "vendor/gh-stack/source.json" ||
    /^vendor\/gh-stack\/references\/(?:[^/]+\/)*[^/]+\.md$/u.test(path)
  );
}

function reviewBody(prepared) {
  const rows = prepared.map(
    ({ source, previousCommit, upstreamCommit }) =>
      `| ${source.name} | [\`${previousCommit}\`](https://github.com/${source.repository}/tree/${previousCommit}/${source.upstreamPath}) | [\`${upstreamCommit}\`](https://github.com/${source.repository}/tree/${upstreamCommit}/${source.upstreamPath}) | [diff](https://github.com/${source.repository}/compare/${previousCommit}...${upstreamCommit}) |`,
  );
  const changes = prepared
    .flatMap((update) => [
      ...update.added.map((path) => `- ${update.source.name}/${path}: added`),
      ...update.modified.map(
        (path) => `- ${update.source.name}/${path}: modified`,
      ),
      ...update.removed.map(
        (path) => `- ${update.source.name}/${path}: removed`,
      ),
    ])
    .sort();
  return [
    "## Summary",
    "",
    "Update the official vendored GitHub skills.",
    "",
    "| Skill | Previous revision | Proposed revision | Comparison |",
    "|---|---|---|---|",
    ...rows,
    "",
    "## Changed files",
    "",
    ...(changes.length
      ? changes
      : [
          "- No upstream snapshot changes; this run reconciles any obsolete update PR.",
        ]),
    "",
    "## Validation",
    "",
    "- Verified downloaded upstream Git blob hashes.",
    "- Verified resulting snapshot contents and allowed file scope.",
    "- Normal repository CI and human review remain required.",
    "",
    "Review agent-facing instruction changes before merging.",
    "",
  ].join("\n");
}

export async function updateVendoredSkills({
  request = fetch,
  token,
  root = fileURLToPath(new URL("..", import.meta.url)),
  prBodyPath = process.env.PR_BODY_PATH,
  summaryPath = process.env.GITHUB_STEP_SUMMARY,
  checkGit = true,
} = {}) {
  // Prepare both upstreams completely before applying either one.
  const prepared = [];
  for (const source of sources)
    prepared.push(await prepare(source, root, { request, token }));
  apply(prepared, root);
  verify(prepared, root);
  const unexpected = checkGit
    ? changedPaths(root).filter((path) => !allowedChange(path))
    : [];
  if (unexpected.length)
    throw new Error(`Unexpected changed path(s): ${unexpected.join(", ")}`);
  const body = reviewBody(prepared);
  if (prBodyPath) writeFileSync(prBodyPath, body);
  if (summaryPath) {
    appendFileSync(
      summaryPath,
      [
        "### Vendored GitHub skill update",
        "",
        ...prepared.map(
          (update) =>
            `- ${update.source.name}: ${update.added.length + update.modified.length + update.removed.length ? "snapshot updated" : "unchanged"} at \`${update.upstreamCommit}\``,
        ),
        "",
      ].join("\n"),
    );
  } else {
    process.stdout.write(body);
  }
  return prepared;
}

if (import.meta.main) {
  try {
    await updateVendoredSkills({ token: process.env.GH_TOKEN });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
