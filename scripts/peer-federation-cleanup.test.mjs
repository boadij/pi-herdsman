import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cleanupSmokeFixture } from "./peer-federation-cleanup.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "peer-cleanup-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runId = "peer474-12345678-1234-1234-1234-123456789abc";
  const root = join(directory, runId);
  mkdirSync(root);
  const manifestPath = join(root, "resources.json");
  writeFileSync(manifestPath, "{}");
  const resources = {
    runId,
    root,
    containers: ["a".repeat(64), "b".repeat(64)],
    volumes: [
      `ph-a-home-${runId}`,
      `ph-a-ssh-${runId}`,
      `ph-b-home-${runId}`,
      `ph-b-ssh-${runId}`,
    ],
    network: "c".repeat(64),
    imageTag: `${runId}:fixture`,
    image: `sha256:${"d".repeat(64)}`,
  };
  const events = [];
  const options = {
    fixtureBase: directory,
    canonicalize: realpathSync,
    inspectResource(kind, id) {
      events.push(["inspect", kind, id]);
      return {
        id: kind === "image" ? resources.image : undefined,
        labels: {
          "pi-herdsman.run": runId,
          ...(kind === "container"
            ? { "pi-herdsman.side": id === resources.containers[0] ? "a" : "b" }
            : {}),
        },
      };
    },
    removeResource(kind, id) {
      events.push(["remove", kind, id]);
    },
    removeRoot(path) {
      events.push(["removeRoot", path]);
    },
  };
  return { directory, root, manifestPath, resources, events, options };
}

test("untrusted cleanup root cannot remove outside the expected smoke fixture", (t) => {
  const f = fixture(t);
  const outside = join(f.directory, "outside");
  mkdirSync(outside);
  const sentinel = join(outside, "sentinel");
  writeFileSync(sentinel, "keep");
  f.resources.root = outside;

  assert.throws(
    () => cleanupSmokeFixture(f.resources, f.manifestPath, f.options),
    /canonical smoke fixture root/u,
  );
  assert.equal(f.events.length, 0);
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
});

test("untrusted Docker IDs and unowned valid IDs are rejected before deletion", (t) => {
  const f = fixture(t);
  f.resources.containers = ["../../unrelated"];
  assert.throws(
    () => cleanupSmokeFixture(f.resources, f.manifestPath, f.options),
    /invalid smoke fixture Docker resources/u,
  );
  assert.equal(f.events.length, 0);

  f.resources.containers = ["e".repeat(64)];
  f.options.inspectResource = () => ({ labels: {} });
  assert.throws(
    () => cleanupSmokeFixture(f.resources, f.manifestPath, f.options),
    /unowned smoke fixture container/u,
  );
  assert.equal(
    f.events.some(([event]) => event === "remove"),
    false,
  );
  assert.equal(
    f.events.some(([event]) => event === "removeRoot"),
    false,
  );
});

test("cleanup preflights all fixture resources before deleting the owned set", (t) => {
  const f = fixture(t);
  cleanupSmokeFixture(f.resources, f.manifestPath, f.options);
  assert.equal(f.events.filter(([event]) => event === "inspect").length, 8);
  assert.deepEqual(
    f.events
      .slice(-9)
      .map(([event, kind]) => [
        event,
        event === "removeRoot" ? undefined : kind,
      ]),
    [
      ["remove", "container"],
      ["remove", "container"],
      ["remove", "volume"],
      ["remove", "volume"],
      ["remove", "volume"],
      ["remove", "volume"],
      ["remove", "network"],
      ["remove", "image"],
      ["removeRoot", undefined],
    ],
  );
  assert.equal(f.events.at(-1)[1], realpathSync(f.root));
  assert.deepEqual(
    f.events.findLast(
      ([event, kind]) => event === "remove" && kind === "image",
    ),
    ["remove", "image", f.resources.imageTag],
  );
});
