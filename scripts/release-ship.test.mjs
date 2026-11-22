import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { artifacts, prepare, request } from "./release-ship.mjs";

const source = Buffer.from(
  "BEGIN RELEASE BODY\n# 🐑 Release  \n\nEND RELEASE BODY\nBEGIN DISCORD DRAFT\nA release: {{RELEASE_URL}}\nEND DISCORD DRAFT\n",
);
const body = artifacts(source).body;
const digest = createHash("sha256").update(body).digest("hex");
const sha = "a".repeat(40);
const head = "b".repeat(40);
const title = "chore(main): release 0.54.0 (#100)";
const record = {
  base_sha: sha,
  body_sha256: digest,
  commit_message: "",
  commit_title: title,
  drafter_result_ref: "result:release-drafter#15",
  expected_stored_message: title,
  head_sha: head,
  pr: 100,
  tag: "v0.54.0",
};

function withGh(code, fn) {
  const dir = mkdtempSync(join(tmpdir(), "release-ship-test-"));
  const path = join(dir, "gh");
  writeFileSync(path, `#!/bin/sh\n${code}\n`);
  chmodSync(path, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  try {
    return fn(dir);
  } finally {
    process.env.PATH = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("only an explicit HTTP 404 counts as absent", () => {
  for (const status of [200, 401, 403, 404, 429, 500]) {
    withGh(
      `printf 'HTTP/2 ${status} response\\r\\ncontent-type: application/json\\r\\n\\r\\n{}'; exit ${status === 200 ? 0 : 1}`,
      () => {
        if (status === 404)
          assert.deepEqual(
            request("repos/boadij/pi-herdsman/git/ref/tags/v0.54.0"),
            { status, data: null },
          );
        else if (status === 200)
          assert.equal(
            request("repos/boadij/pi-herdsman/git/ref/tags/v0.54.0").status,
            200,
          );
        else
          assert.throws(
            () => request("repos/boadij/pi-herdsman/git/ref/tags/v0.54.0"),
            /HTTP/,
          );
      },
    );
  }
  withGh("echo 'connection failed' >&2; exit 1", () => {
    assert.throws(
      () => request("repos/boadij/pi-herdsman/git/ref/tags/v0.54.0"),
      /HTTP status unavailable/,
    );
  });
});

test("approved bytes, newlines and empty squash API message are preserved", () => {
  const input = prepare(record, source);
  assert.deepEqual(input.body, Buffer.from("# 🐑 Release  \n\n"));
  assert.equal(
    JSON.parse(input.bodyPayload.toString()).body,
    input.body.toString(),
  );
  assert.deepEqual(JSON.parse(input.merge.toString()), {
    sha: head,
    merge_method: "squash",
    commit_title: title,
    commit_message: "",
  });
  assert.throws(
    () => prepare({ ...record, body_sha256: "0".repeat(64) }, source),
    /approved bytes/,
  );
  assert.throws(
    () => prepare({ ...record, expected_stored_message: title + "\n" }, source),
    /projection differs/,
  );
  assert.throws(
    () =>
      artifacts(
        Buffer.from(source.toString().replace("END RELEASE BODY", "END OTHER")),
      ),
    /Ambiguous/,
  );
});

test("end-to-end fake GitHub merger verifies tag and notes without extra writes", () => {
  const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const endpoint = args.find(s => s.startsWith('repos/'));
const method = args[args.indexOf('--method') + 1];
const statePath = process.env.GH_STATE;
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const base='${sha}', head='${head}', title=${JSON.stringify(title)}, tag='v0.54.0';
let value, status=200;
if(endpoint.endsWith('/branches/main')) value={commit:{sha:base}};
else if(endpoint.endsWith('/pulls/100') && method==='GET') value={state:state.merged?'closed':'open',merged:state.merged,draft:false,head:{repo:{full_name:'boadij/pi-herdsman'},sha:head},base:{repo:{full_name:'boadij/pi-herdsman'},ref:'main',sha:base},mergeable:true,mergeable_state:'clean',merge_commit_sha:state.merged?'${"c".repeat(40)}':null};
else if(endpoint==='repos/boadij/pi-herdsman') value={allow_squash_merge:true};
else if(endpoint.endsWith('/git/ref/tags/v0.54.0')) {if (!state.merged) {status=Number(process.env.GH_TAG_STATUS || 404); value={message:'Not Found'};} else value={object:{type:'commit',sha:'${"c".repeat(40)}'}};}
else if(endpoint.endsWith('/releases/tags/v0.54.0')) {if (!state.merged) status=404; else value={id:27,tag_name:tag,html_url:'https://github.com/boadij/pi-herdsman/releases/tag/v0.54.0',draft:false,prerelease:false,published_at:'2026-11-22T12:00:00Z',body:state.body};}
else if(endpoint.endsWith('/pulls/100/merge') && method==='PUT') { const data=JSON.parse(fs.readFileSync(0,'utf8'));if(data.commit_message!=='' || data.sha!==head) process.exit(6);state.merged=true;value={merged:true,sha:'${"c".repeat(40)}'}; }
else if(endpoint.endsWith('/git/commits/${"c".repeat(40)}')) value={sha:'${"c".repeat(40)}',parents:[{sha:base}],message:title};
else if(endpoint.endsWith('/releases/27') && method==='GET') value={id:27,tag_name:tag,html_url:'https://github.com/boadij/pi-herdsman/releases/tag/v0.54.0',draft:false,prerelease:false,published_at:'2026-11-22T12:00:00Z',body:state.body};
else if(endpoint.endsWith('/releases/27') && method==='PATCH') {state.body=JSON.parse(fs.readFileSync(0,'utf8')).body;state.patches++;value={id:27};}
else { console.error(endpoint,method);process.exit(7); }
fs.writeFileSync(statePath,JSON.stringify(state));
process.stdout.write('HTTP/2 '+status+' OK\\r\\ncontent-type: application/json\\r\\n\\r\\n'+JSON.stringify(status===404?{message:'Not Found'}:value));
if(status>=400) process.exit(1);
`;
  const dir = mkdtempSync(join(tmpdir(), "ship-flow-"));
  try {
    writeFileSync(join(dir, "gh"), fake);
    chmodSync(join(dir, "gh"), 0o755);
    const inputPath = join(dir, "input.json"),
      resultPath = join(dir, "result.txt"),
      statePath = join(dir, "state.json");
    writeFileSync(inputPath, JSON.stringify(record));
    writeFileSync(resultPath, source);
    writeFileSync(
      statePath,
      JSON.stringify({ merged: false, body: null, patches: 0 }),
    );
    const run = spawnSync(
      process.execPath,
      [
        new URL("./release-ship.mjs", import.meta.url).pathname,
        inputPath,
        resultPath,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GH_STATE: statePath,
          PATH: `${dir}:${process.env.PATH}`,
        },
      },
    );
    assert.equal(run.status, 0, run.stderr + "\n" + run.stdout);
    assert.equal(JSON.parse(run.stdout).stage, "verified-notes");
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).patches, 1);
    for (const denied of [200, 403, 429, 500]) {
      writeFileSync(
        statePath,
        JSON.stringify({ merged: false, body: null, patches: 0 }),
      );
      const refused = spawnSync(
        process.execPath,
        [
          new URL("./release-ship.mjs", import.meta.url).pathname,
          inputPath,
          resultPath,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            GH_STATE: statePath,
            GH_TAG_STATUS: String(denied),
            PATH: `${dir}:${process.env.PATH}`,
          },
        },
      );
      assert.notEqual(refused.status, 0, `status ${denied} must block`);
      assert.equal(JSON.parse(readFileSync(statePath, "utf8")).merged, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
