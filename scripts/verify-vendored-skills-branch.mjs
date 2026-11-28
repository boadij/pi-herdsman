import { execFileSync } from "node:child_process";
import { allowedChange } from "./update-vendored-skills.mjs";

const shaPattern = /^[a-f0-9]{40}$/u;

function sameEntry(left, right) {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.type === right.type &&
      left.mode === right.mode &&
      left.sha === right.sha)
  );
}

function apiJson(request, url, label) {
  return request(url, {
    headers: {
      Accept: "application/vnd.github+json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Lookup failed: ${label} (HTTP ${response.status})`);
      }
      try {
        return await response.json();
      } catch {
        throw new Error(`Invalid GitHub response: ${label} (expected JSON)`);
      }
    })
    .catch((error) => {
      if (
        error instanceof Error &&
        /^(?:Lookup failed|Invalid GitHub response):/u.test(error.message)
      ) {
        throw error;
      }
      throw new Error(`Lookup failed: ${label} (request error)`);
    });
}

function apiTree(tree, label) {
  if (tree?.truncated !== false || !Array.isArray(tree.tree)) {
    throw new Error(`Cannot verify reserved branch: incomplete ${label} tree`);
  }
  const result = new Map();
  const seen = new Set();
  for (const entry of tree.tree) {
    if (
      typeof entry?.path !== "string" ||
      !entry.path ||
      seen.has(entry.path) ||
      typeof entry.sha !== "string" ||
      !shaPattern.test(entry.sha)
    ) {
      throw new Error(`Cannot verify reserved branch: invalid ${label} tree entry`);
    }
    seen.add(entry.path);
    if (entry.type === "tree") {
      if (entry.mode !== "040000") {
        throw new Error(`Cannot verify reserved branch: invalid ${label} tree mode`);
      }
      continue;
    }
    if (
      !(
        (entry.type === "blob" && ["100644", "100755", "120000"].includes(entry.mode)) ||
        (entry.type === "commit" && entry.mode === "160000")
      )
    ) {
      throw new Error(`Cannot verify reserved branch: unsupported ${label} tree entry`);
    }
    result.set(entry.path, {
      type: entry.type,
      mode: entry.mode,
      sha: entry.sha,
    });
  }
  return result;
}

/**
 * Checks only the old proposal's scope. Safe regeneration additionally
 * requires exclusive writer protection on the reserved branch.
 */
export function verifyBranchScope({ mergeBaseTree, branchTree }) {
  const branchPaths = new Set([...mergeBaseTree.keys(), ...branchTree.keys()]);
  for (const path of branchPaths) {
    const baseEntry = mergeBaseTree.get(path);
    const branchEntry = branchTree.get(path);
    if (sameEntry(branchEntry, baseEntry)) continue;
    if (!allowedChange(path)) {
      throw new Error(`Unexpected reserved branch change: ${path}`);
    }
    for (const entry of [baseEntry, branchEntry]) {
      if (entry && (entry.type !== "blob" || entry.mode !== "100644")) {
        throw new Error(`Unsafe reserved branch change: ${path}`);
      }
    }
  }
}

async function reference(request, repository, ref, label) {
  const result = await apiJson(
    request,
    `https://api.github.com/repos/${repository}/git/ref/heads/${encodeURIComponent(ref)}`,
    label,
  );
  const sha = result?.object?.sha;
  if (
    result?.ref !== `refs/heads/${ref}` ||
    result.object?.type !== "commit" ||
    typeof sha !== "string" ||
    !shaPattern.test(sha)
  ) {
    throw new Error(`Invalid GitHub response: expected ${label} commit`);
  }
  return sha;
}

export async function verifyExistingBranch({
  request = fetch,
  token = process.env.GH_TOKEN,
  repository = process.env.GITHUB_REPOSITORY,
  branchSha = process.env.BRANCH_SHA,
  root = process.cwd(),
} = {}) {
  if (!/^[^/]+\/[^/]+$/u.test(repository ?? "") || !shaPattern.test(branchSha ?? "")) {
    throw new Error("Cannot verify reserved branch: missing repository or branch SHA");
  }
  const authenticatedRequest = (url, options) =>
    request(url, {
      ...options,
      headers: {
        ...options.headers,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
  const mainSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  if (!shaPattern.test(mainSha))
    throw new Error("Cannot verify reserved branch: invalid checked-out main SHA");
  const currentMainSha = await reference(authenticatedRequest, repository, "main", "main");
  if (currentMainSha !== mainSha) {
    throw new Error(
      "Cannot verify reserved branch: main advanced during reconciliation; retry on current main",
    );
  }

  const comparison = await apiJson(
    authenticatedRequest,
    `https://api.github.com/repos/${repository}/compare/${mainSha}...${branchSha}`,
    "main-to-reserved-branch comparison",
  );
  const mergeBaseSha = comparison?.merge_base_commit?.sha;
  if (typeof mergeBaseSha !== "string" || !shaPattern.test(mergeBaseSha)) {
    throw new Error("Cannot verify reserved branch: comparison has no valid merge base");
  }
  const [mergeBaseResponse, branchResponse] = await Promise.all([
    apiJson(
      authenticatedRequest,
      `https://api.github.com/repos/${repository}/git/trees/${mergeBaseSha}?recursive=1`,
      "merge-base",
    ),
    apiJson(
      authenticatedRequest,
      `https://api.github.com/repos/${repository}/git/trees/${branchSha}?recursive=1`,
      "reserved branch",
    ),
  ]);
  const mergeBaseTree = apiTree(mergeBaseResponse, "merge-base");
  const branchTree = apiTree(branchResponse, "reserved branch");
  verifyBranchScope({ mergeBaseTree, branchTree });

  const [latestMainSha, latestBranchSha] = await Promise.all([
    reference(authenticatedRequest, repository, "main", "main"),
    reference(authenticatedRequest, repository, "automation/upstream-skills", "reserved branch"),
  ]);
  if (latestMainSha !== mainSha || latestBranchSha !== branchSha) {
    throw new Error(
      "Cannot verify reserved branch: main or reserved branch changed during verification",
    );
  }
}

if (import.meta.main) {
  try {
    await verifyExistingBranch();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
