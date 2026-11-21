import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

const api = "https://api.github.com/repos/cli/cli";
const source = "https://github.com/cli/cli/blob";
const path = "skills/gh/SKILL.md";
const sha = /^[a-f0-9]{40}$/;

const vendor = new URL("../vendor/github-cli/", import.meta.url);

function reviewedSnapshot() {
  const { commit } = JSON.parse(
    readFileSync(new URL("source.json", vendor), "utf8"),
  );
  if (typeof commit !== "string" || !sha.test(commit)) {
    throw new Error(
      "Invalid vendored provenance: expected reviewed upstream commit SHA",
    );
  }
  const bytes = readFileSync(new URL("SKILL.md", vendor));
  const blob = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  return { commit, blob };
}

async function lookup(endpoint, label, { request, token, missing }) {
  let response;
  try {
    response = await request(`${api}/${endpoint}`, {
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

if (import.meta.main) {
  try {
    const summary = await checkGhSkill({ token: process.env.GH_TOKEN });
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
