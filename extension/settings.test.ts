import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_BYTE_LIMIT,
  MAX_BYTE_LIMIT,
  MIN_BYTE_LIMIT,
  resolveEffectiveByteLimit,
  updatePiHerdsmanSettingJson,
  validByteLimit,
} from "./settings.ts";

test("byte limits resolve trusted project, global, and default values", () => {
  assert.deepEqual(resolveEffectiveByteLimit(undefined, undefined, true), {
    bytes: DEFAULT_BYTE_LIMIT,
    source: "default",
  });
  assert.deepEqual(resolveEffectiveByteLimit(65536, undefined, true), {
    bytes: 65536,
    source: "global",
  });
  assert.deepEqual(resolveEffectiveByteLimit(65536, 262144, true), {
    bytes: 262144,
    source: "project",
  });
  assert.deepEqual(resolveEffectiveByteLimit(65536, 262144, false), {
    bytes: 65536,
    source: "global",
  });
  assert.deepEqual(resolveEffectiveByteLimit(65536, 0, true), {
    bytes: 65536,
    source: "global",
    invalidSource: "project",
  });
  assert.deepEqual(resolveEffectiveByteLimit("128kb", undefined, true), {
    bytes: DEFAULT_BYTE_LIMIT,
    source: "default",
    invalidSource: "global",
  });
});

test("byte limit validation accepts only integer values from 1 KiB to 1 MiB", () => {
  assert.equal(validByteLimit(MIN_BYTE_LIMIT), true);
  assert.equal(validByteLimit(MAX_BYTE_LIMIT), true);
  for (const value of [0, -1, 1023, 1024.5, 1048577, "1024kb"]) {
    assert.equal(validByteLimit(value), false);
  }
});

test("Pi Herdsman setting updates preserve unrelated settings and support reset", () => {
  const content = JSON.stringify({
    other: true,
    piHerdsman: { spawnAxis: "x" },
  });
  const set = updatePiHerdsmanSettingJson(
    content,
    "mailboxPayloadLimitBytes",
    65536,
  );
  assert.deepEqual(JSON.parse(set), {
    other: true,
    piHerdsman: { spawnAxis: "x", mailboxPayloadLimitBytes: 65536 },
  });
  const reset = updatePiHerdsmanSettingJson(
    set,
    "mailboxPayloadLimitBytes",
    undefined,
  );
  assert.deepEqual(JSON.parse(reset), {
    other: true,
    piHerdsman: { spawnAxis: "x" },
  });
});
