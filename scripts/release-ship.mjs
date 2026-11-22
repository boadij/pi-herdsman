import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repo = "boadij/pi-herdsman";
const root = `repos/${repo}`;
const shaPattern = /^[a-f0-9]{40}$/;
const tagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function requireValue(value, reason) {
  if (!value) throw new Error(reason);
}

/** Read GitHub's actual HTTP status; a CLI failure is never proof of 404. */
export function request(path, { method = "GET", input } = {}) {
  const args = ["api", "--hostname", "github.com", "--include", "--method", method, path];
  if (input !== undefined) args.push("--input", "-");
  const reply = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 45_000,
  });
  if (reply.error) throw new Error(`GitHub request failed: ${reply.error.code ?? "transport"}`);
  const raw = reply.stdout || "";
  const headers = [...raw.matchAll(/^HTTP\/[\d.]+\s+(\d{3})\b[^\r\n]*\r?\n/gm)];
  const last = headers.at(-1);
  requireValue(last, "GitHub HTTP status unavailable");
  const status = Number(last[1]);
  const boundary = /\r?\n\r?\n/g;
  boundary.lastIndex = last.index + last[0].length;
  const separation = boundary.exec(raw);
  requireValue(separation, "GitHub response headers incomplete");
  if (status === 404) return { status, data: null };
  if (reply.status !== 0 || status < 200 || status >= 300)
    throw new Error(`GitHub request failed: HTTP ${status}`);
  let data;
  try {
    data = JSON.parse(raw.slice(separation.index + separation[0].length));
  } catch {
    throw new Error("GitHub returned invalid JSON");
  }
  return { status, data };
}

function get(path) {
  const { status, data } = request(`${root}${path ? `/${path}` : ""}`);
  requireValue(status === 200 && data && typeof data === "object", `Invalid GitHub response: ${path}`);
  return data;
}

function absent(path) {
  const response = request(`${root}${path ? `/${path}` : ""}`);
  if (response.status === 404) return true;
  throw new Error(`Already present: ${path}`);
}

function extract(source, label) {
  const opens = [...source.matchAll(new RegExp(`^BEGIN ${label}\\r?\\n`, "gm"))];
  const closes = [...source.matchAll(new RegExp(`^END ${label}(?:\\r?\\n|$)`, "gm"))];
  requireValue(opens.length === 1 && closes.length === 1, `Ambiguous ${label} markers`);
  const start = opens[0].index + opens[0][0].length;
  const end = closes[0].index;
  requireValue(start < end && source.slice(start, end).endsWith("\n"), `Invalid ${label} boundaries`);
  return { start, end, bytes: Buffer.from(source.slice(start, end), "utf8") };
}

export function artifacts(sourceBytes) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  const body = extract(source, "RELEASE BODY");
  const discord = extract(source, "DISCORD DRAFT");
  requireValue(body.end < discord.start, "Drafts out of order or overlapping");
  requireValue(discord.bytes.toString("utf8").split("{{RELEASE_URL}}").length === 2, "Discord URL marker invalid");
  return { body: body.bytes, discord: discord.bytes };
}

export function prepare(record, resultBytes) {
  const keys = [
    "base_sha", "body_sha256", "commit_message", "commit_title", "drafter_result_ref",
    "expected_stored_message", "head_sha", "pr", "tag",
  ];
  assert.deepEqual(Object.keys(record).sort(), [...keys].sort(), "Invalid release record fields");
  requireValue(Number.isSafeInteger(record.pr) && record.pr > 0, "Invalid PR");
  requireValue(shaPattern.test(record.base_sha) && shaPattern.test(record.head_sha), "Invalid pinned SHA");
  requireValue(tagPattern.test(record.tag), "Invalid stable tag");
  requireValue(typeof record.commit_title === "string" && record.commit_title.length > 0, "Invalid title");
  requireValue(typeof record.commit_message === "string", "Invalid API commit message");
  requireValue(typeof record.expected_stored_message === "string", "Missing expected stored Git message");
  requireValue(record.expected_stored_message === record.commit_title +
    (record.commit_message ? `\n\n${record.commit_message}` : ""), "Stored message projection differs from API fields");
  requireValue(/^result:[a-z0-9-]+#[1-9]\d*$/.test(record.drafter_result_ref), "Invalid drafter ref");
  requireValue(/^[0-9a-f]{64}$/.test(record.body_sha256), "Invalid approved body digest");
  const { body, discord } = artifacts(resultBytes);
  const digest = createHash("sha256").update(body).digest("hex");
  requireValue(digest === record.body_sha256, "Release body differs from approved bytes");
  const url = `https://github.com/${repo}/releases/tag/${record.tag}`;
  requireValue(discord.toString("utf8").replace("{{RELEASE_URL}}", url).length <= 1600, "Discord draft exceeds limit");
  const merge = Buffer.from(JSON.stringify({
    sha: record.head_sha,
    merge_method: "squash",
    commit_title: record.commit_title,
    commit_message: record.commit_message,
  }));
  const payload = JSON.parse(merge.toString("utf8"));
  requireValue(payload.commit_message === record.commit_message && payload.commit_title === record.commit_title, "Merge payload changed");
  const bodyPayload = Buffer.from(JSON.stringify({ body: body.toString("utf8") }));
  requireValue(Buffer.from(JSON.parse(bodyPayload.toString("utf8")).body).equals(body), "Body JSON lost bytes");
  return { body, merge, bodyPayload, url, digest };
}

function assertCandidate(record) {
  const branch = get("branches/main");
  requireValue(branch.commit?.sha === record.base_sha, "Main changed since approval");
  const pr = get(`pulls/${record.pr}`);
  requireValue(pr.state === "open" && pr.draft === false, "PR is not open and ready");
  requireValue(pr.head?.repo?.full_name === repo && pr.base?.repo?.full_name === repo, "PR repository changed");
  requireValue(pr.base.ref === "main" && pr.base.sha === record.base_sha, "PR base changed");
  requireValue(pr.head.sha === record.head_sha, "PR head changed");
  requireValue(pr.mergeable === true && ["clean", "unstable"].includes(pr.mergeable_state), "PR not mergeable");
  requireValue(get("").allow_squash_merge === true, "Repository disallows squash merges");
  absent(`git/ref/tags/${record.tag}`);
  absent(`releases/tags/${record.tag}`);
}

function verifyMerge(record, responseSha) {
  const pr = get(`pulls/${record.pr}`);
  requireValue(pr.merged === true && pr.state === "closed" && pr.head?.sha === record.head_sha, "Merge not verified");
  const sha = pr.merge_commit_sha;
  requireValue(shaPattern.test(sha) && (!responseSha || responseSha === sha), "Merge SHA mismatch");
  const commit = get(`git/commits/${sha}`);
  requireValue(commit.sha === sha && commit.parents?.length === 1 && commit.parents[0].sha === record.base_sha, "Squash parent mismatch");
  requireValue(commit.message === record.expected_stored_message, "Stored squash message differs");
  return sha;
}

function peelTag(tag, sha) {
  let object = get(`git/ref/tags/${tag}`).object;
  const seen = new Set();
  for (let i = 0; i < 8; i++) {
    requireValue(object && shaPattern.test(object.sha) && !seen.has(object.sha), "Invalid or cyclic tag");
    if (object.type === "commit") {
      requireValue(object.sha === sha, "Release tag does not point to squash commit");
      return;
    }
    requireValue(object.type === "tag", "Unknown tag object");
    seen.add(object.sha);
    object = get(`git/tags/${object.sha}`).object;
  }
  throw new Error("Tag nesting too deep");
}

function assertRelease(release, record, url) {
  requireValue(Number.isSafeInteger(release.id) && release.id > 0, "Invalid release ID");
  requireValue(release.tag_name === record.tag && release.html_url === url, "Release identity changed");
  requireValue(release.draft === false && release.prerelease === false && typeof release.published_at === "string", "Release not published");
  requireValue(release.body === null || typeof release.body === "string", "Invalid release body");
}

async function publishedRelease(record, url) {
  const deadline = Date.now() + 120_000;
  while (true) {
    const result = request(`${root}/releases/tags/${record.tag}`);
    if (result.status === 200) {
      assertRelease(result.data, record, url);
      return result.data;
    }
    if (result.status !== 404 || Date.now() >= deadline) throw new Error("Release publication not verified");
    await sleep(Math.min(10_000, deadline - Date.now()));
  }
}

export async function ship(record, prepared) {
  const report = { pr: record.pr, tag: record.tag, stage: "not-merged", merge_sha: null, release_url: null, body_sha256: prepared.digest, body_verified: false };
  try {
    // The ship Agent must separately verify effective rulesets, required checks, reviews,
    // workflow approvals, exact human grants and absence of a competing writer.
    assertCandidate(record);
    report.stage = "merge-unknown";
    let response;
    try {
      response = request(`${root}/pulls/${record.pr}/merge`, { method: "PUT", input: prepared.merge });
    } catch {
      // A failed response may follow a successful write. Read state; never retry PUT.
      response = null;
    }
    if (response && (response.status !== 200 || response.data?.merged !== true))
      throw new Error("Unexpected merge response");
    const sha = verifyMerge(record, response?.data?.sha);
    report.stage = "verified-squash";
    report.merge_sha = sha;
    const release = await publishedRelease(record, prepared.url);
    peelTag(record.tag, sha);
    report.stage = "verified-publication";
    report.release_url = prepared.url;
    const original = get(`releases/${release.id}`);
    assertRelease(original, record, prepared.url);
    if (original.body !== prepared.body.toString("utf8")) {
      try {
        request(`${root}/releases/${release.id}`, { method: "PATCH", input: prepared.bodyPayload });
      } catch {
        // One write maximum. Reconciliation below decides whether it took effect.
      }
    }
    const final = get(`releases/${release.id}`);
    assertRelease(final, record, prepared.url);
    requireValue(final.id === release.id, "Release ID changed");
    peelTag(record.tag, sha);
    requireValue(typeof final.body === "string" && Buffer.from(final.body).equals(prepared.body), "Published body differs from approved bytes");
    report.stage = "verified-notes";
    report.body_verified = true;
  } catch (error) {
    report.error = error.message;
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    requireValue(process.argv.length === 4, "Usage: node scripts/release-ship.mjs <record.json> <drafter-result.txt>");
    const record = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const prepared = prepare(record, readFileSync(process.argv[3]));
    const result = await ship(record, prepared);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.body_verified) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
