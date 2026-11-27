import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const api = "https://api.github.com/repos/cli/cli";
const source = "https://github.com/cli/cli/blob";
const path = "skills/gh/SKILL.md";
const sha = /^[a-f0-9]{40}$/;

const vendor = new URL("../vendor/github-cli/", import.meta.url);

function reviewedCommit(directory) {
  const { commit } = JSON.parse(
    readFileSync(new URL("source.json", directory), "utf8"),
  );
  if (typeof commit !== "string" || !sha.test(commit)) {
    throw new Error(
      "Invalid vendored provenance: expected reviewed upstream commit SHA",
    );
  }
  return commit;
}

function blobHash(file) {
  const bytes = readFileSync(file);
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function reviewedSnapshot() {
  return {
    commit: reviewedCommit(vendor),
    blob: blobHash(new URL("SKILL.md", vendor)),
  };
}

async function lookup(
  endpoint,
  label,
  { request, token, missing, repository = api },
) {
  let response;
  try {
    response = await request(`${repository}/${endpoint}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error(`Lookup failed: ${label} (request error)`);
  }
  if (missing && response.status === 404) {
    throw new Error(
      `Missing upstream file: ${path} at the resolved trunk commit`,
    );
  }
  if (!response.ok) {
    throw new Error(`Lookup failed: ${label} (HTTP ${response.status})`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`Invalid upstream response: ${label} (expected JSON)`);
  }
}

export async function checkGhSkill({ request = fetch, token } = {}) {
  const baseline = reviewedSnapshot();
  const ref = await lookup("git/ref/heads/trunk", "trunk ref", {
    request,
    token,
  });
  const commit = ref?.object?.sha;
  if (
    ref?.ref !== "refs/heads/trunk" ||
    ref.object?.type !== "commit" ||
    typeof commit !== "string" ||
    !sha.test(commit)
  ) {
    throw new Error("Invalid upstream response: expected trunk commit");
  }

  const file = await lookup(
    `contents/${path}?ref=${commit}`,
    "skill contents",
    {
      request,
      token,
      missing: true,
    },
  );
  if (
    file?.type !== "file" ||
    file.path !== path ||
    typeof file.sha !== "string" ||
    !sha.test(file.sha)
  ) {
    throw new Error(
      "Invalid upstream response: expected exact gh skill file and blob SHA",
    );
  }

  if (file.sha === baseline.blob) return null;
  return [
    "### Upstream gh skill drift",
    "",
    `- [Reviewed source](${source}/${baseline.commit}/${path}) — blob \`${baseline.blob}\``,
    `- [Observed trunk source](${source}/${commit}/${path}) — blob \`${file.sha}\``,
    "",
    "Review the upstream change before updating the vendored reference and its provenance.",
    "",
  ].join("\n");
}

const stackRepository = "https://api.github.com/repos/github/gh-stack";
const stackSource = "https://github.com/github/gh-stack/blob";
const stackPath = "skills/gh-stack/";
const stackVendor = new URL("../vendor/gh-stack/", import.meta.url);

export async function checkGhStackSkill({ request = fetch, token } = {}) {
  const baseline = reviewedCommit(stackVendor);
  const root = fileURLToPath(stackVendor);
  const metadata = new Set([
    ".gitattributes",
    "LICENSE",
    "README.md",
    "source.json",
  ]);
  const reviewed = new Map(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"),
      )
      .filter((name) => !metadata.has(name))
      .map((name) => [name, blobHash(join(root, name))]),
  );
  if (!reviewed.has("SKILL.md")) {
    throw new Error("Missing vendored file: gh-stack SKILL.md");
  }

  const options = { request, token, repository: stackRepository };
  const ref = await lookup("git/ref/heads/main", "gh-stack main ref", options);
  const commit = ref?.object?.sha;
  if (
    ref?.ref !== "refs/heads/main" ||
    ref.object?.type !== "commit" ||
    typeof commit !== "string" ||
    !sha.test(commit)
  ) {
    throw new Error("Invalid upstream response: expected gh-stack main commit");
  }
  const tree = await lookup(
    `git/trees/${commit}?recursive=1`,
    "gh-stack skill tree",
    options,
  );
  if (tree?.truncated !== false || !Array.isArray(tree.tree)) {
    throw new Error(
      "Invalid upstream response: expected complete gh-stack tree",
    );
  }

  const observed = new Map();
  for (const entry of tree.tree) {
    if (typeof entry?.path !== "string") {
      throw new Error("Invalid upstream response: expected tree path");
    }
    if (!entry.path.startsWith(stackPath) || entry.type === "tree") continue;
    const name = entry.path.slice(stackPath.length);
    if (
      entry.type !== "blob" ||
      entry.mode !== "100644" ||
      typeof entry.sha !== "string" ||
      !sha.test(entry.sha) ||
      observed.has(name)
    ) {
      throw new Error(
        "Invalid upstream response: expected exact gh-stack file",
      );
    }
    observed.set(name, entry.sha);
  }
  if (!observed.has("SKILL.md")) {
    throw new Error("Missing upstream file: gh-stack SKILL.md");
  }

  const changes = [];
  for (const name of new Set([...reviewed.keys(), ...observed.keys()])) {
    if (reviewed.get(name) === observed.get(name)) continue;
    const before = reviewed.has(name)
      ? `[Reviewed](${stackSource}/${baseline}/${stackPath}${name})`
      : "Not vendored";
    const after = observed.has(name)
      ? `[Observed](${stackSource}/${commit}/${stackPath}${name})`
      : "Removed upstream";
    changes.push(`- \`${name}\`: ${before} → ${after}`);
  }
  if (!changes.length) return null;
  return [
    "### Upstream gh-stack skill drift",
    "",
    ...changes,
    "",
    "Review the upstream changes before updating the vendored reference and its provenance.",
    "",
  ].join("\n");
}

if (import.meta.main) {
  try {
    const options = { token: process.env.GH_TOKEN };
    const summary = (
      await Promise.all([checkGhSkill(options), checkGhStackSkill(options)])
    )
      .filter(Boolean)
      .join("\n");
    if (summary && process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    } else if (summary) {
      process.stdout.write(summary);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
