import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { checkGhSkill } from "./gh-skill-drift.mjs";

const path = "skills/gh/SKILL.md";
const commit = "a".repeat(40);
const ref = {
  ref: "refs/heads/trunk",
  object: { type: "commit", sha: commit },
};
const vendor = new URL("../vendor/github-cli/", import.meta.url);
const { commit: reviewedCommit } = JSON.parse(
  readFileSync(new URL("source.json", vendor), "utf8"),
);
const reviewedLink = `https://github.com/cli/cli/blob/${reviewedCommit}/${path}`;
const reviewedBlob = execFileSync(
  "git",
  ["hash-object", "--no-filters", fileURLToPath(new URL("SKILL.md", vendor))],
  {
    encoding: "utf8",
  },
).trim();
const file = { path, type: "file", sha: reviewedBlob };

function fakeRequest(...responses) {
  const paths = ["/git/ref/heads/trunk", `/contents/${path}?ref=${commit}`];
  return async (url) => {
    assert.equal(url, `https://api.github.com/repos/cli/cli${paths.shift()}`);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
}

test("weekly gh skill compare is quiet on the reviewed blob at a new trunk commit", async () => {
  const request = fakeRequest(Response.json(ref), Response.json(file));
  assert.equal(await checkGhSkill({ request }), null);
});

test("gh skill drift links to immutable reviewed and observed sources", async () => {
  const observedBlob = "b".repeat(40);
  const request = fakeRequest(
    Response.json(ref),
    Response.json({ ...file, sha: observedBlob }),
  );
  const result = await checkGhSkill({ request });
  assert.ok(result.includes(reviewedLink));
  assert.ok(result.includes(reviewedBlob));
  assert.ok(
    result.includes(`https://github.com/cli/cli/blob/${commit}/${path}`),
  );
  assert.ok(result.includes(observedBlob));
});

test("gh skill checker distinguishes lookup, missing, and invalid responses", async () => {
  const cases = [
    [[new Error("network")], /Lookup failed: trunk ref \(request error\)/],
    [
      [new Response(null, { status: 404 })],
      /Lookup failed: trunk ref \(HTTP 404\)/,
    ],
    [
      [Response.json({ ref: ref.ref })],
      /Invalid upstream response: expected trunk commit/,
    ],
    [
      [Response.json(ref), new Response(null, { status: 403 })],
      /Lookup failed: skill contents \(HTTP 403\)/,
    ],
    [
      [Response.json(ref), new Response(null, { status: 404 })],
      /Missing upstream file/,
    ],
    [
      [Response.json(ref), new Response("not JSON")],
      /Invalid upstream response: skill contents/,
    ],
    [
      [Response.json(ref), Response.json({ ...file, sha: "bad" })],
      /Invalid upstream response: expected exact gh skill file/,
    ],
    [
      [Response.json(ref), Response.json({ ...file, path: "wrong.md" })],
      /Invalid upstream response: expected exact gh skill file/,
    ],
  ];
  for (const [responses, message] of cases) {
    await assert.rejects(
      checkGhSkill({ request: fakeRequest(...responses) }),
      message,
    );
  }
});
