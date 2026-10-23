import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { managerProjectionSource } from "./peer-federation-manager-projection.mjs";

function project(rows) {
  const directory = mkdtempSync(join(tmpdir(), "peer-manager-projection-"));
  try {
    const session = join(directory, "session.jsonl");
    writeFileSync(
      session,
      typeof rows === "string"
        ? rows
        : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    return spawnSync(
      process.execPath,
      ["-e", managerProjectionSource, session, "target"],
      { encoding: "utf8", maxBuffer: 4096 },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("Manager projection counts all matches but returns only bounded selected evidence", () => {
  const result = project([
    {
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "list_peers" }],
      },
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      type: "custom_message",
      customType: "pi-herdsman-peer_message",
      details: {
        id: `first-${index}`,
        toSessionId: "target",
        content: "PEER_E2E_REQUEST: PEER_E2E_MANAGER_FILE_CONTENT_V1",
      },
      rawTranscriptField: "PRIVATE_RAW_TRANSCRIPT_SENTINEL",
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      type: "custom_message",
      customType: "pi-herdsman-peer_message",
      details: {
        id: `second-${index}`,
        toSessionId: "target",
        content: "PEER_E2E_REQUEST_SECOND:",
      },
    })),
  ]);
  assert.equal(result.status, 0, result.stderr);
  const evidence = JSON.parse(result.stdout);
  assert.equal(evidence.listPeersCalls, 1);
  assert.equal(evidence.firstDeliveryCount, 3);
  assert.equal(evidence.secondDeliveryCount, 2);
  assert.deepEqual(evidence.firstDelivery, { id: "first-0", file: true });
  assert.deepEqual(evidence.secondDelivery, { id: "second-0" });
  assert.equal(Object.hasOwn(evidence, "deliveries"), false);
  assert.ok(result.stdout.length < 1024);
  assert.equal(
    result.stdout.includes("PRIVATE_RAW_TRANSCRIPT_SENTINEL"),
    false,
  );
});

test("Manager projection fails closed when the session line cap is exceeded", () => {
  const result = project(Array.from({ length: 100_001 }, () => ({})));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /projection line cap/u);
  assert.equal(result.stdout, "");
});

test("Manager projection fails closed when the session byte cap is exceeded", () => {
  const result = project(" ".repeat(16 * 1024 * 1024 + 1));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /projection byte cap/u);
  assert.equal(result.stdout, "");
});

test("Manager projection fails closed when a selected ID exceeds its output limit", () => {
  const result = project([
    {
      type: "custom_message",
      customType: "pi-herdsman-peer_message",
      details: {
        id: "x".repeat(257),
        toSessionId: "target",
        content: "PEER_E2E_REQUEST:",
      },
    },
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /output limit/u);
  assert.equal(result.stdout, "");
});
