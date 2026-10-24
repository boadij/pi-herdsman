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
import {
  cleanupSmokeFixture,
  isMissingDockerResource,
} from "./peer-federation-cleanup.mjs";

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
  const active = new Set([
    ...resources.containers.map((id) => `container:${id}`),
    ...resources.volumes.map((id) => `volume:${id}`),
    `network:${resources.network}`,
    `image:${resources.imageTag}`,
  ]);
  const events = [];
  const options = {
    fixtureBase: directory,
    canonicalize: realpathSync,
    inspectResource(kind, id) {
      events.push(["inspect", kind, id]);
      if (!active.has(`${kind}:${id}`)) return undefined;
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
      active.delete(`${kind}:${id}`);
    },
    removeRoot(path) {
      events.push(["removeRoot", path]);
    },
  };
  return { directory, root, manifestPath, resources, active, events, options };
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
  const firstRemoval = f.events.findIndex(([event]) => event === "remove");
  assert.equal(firstRemoval, 8);
  assert.equal(
    f.events
      .slice(firstRemoval + 8, -1)
      .filter(([event]) => event === "inspect").length,
    8,
  );
  assert.deepEqual(
    f.events.filter(([event]) => event === "remove").map(([, kind]) => kind),
    [
      "container",
      "container",
      "volume",
      "volume",
      "volume",
      "volume",
      "network",
      "image",
    ],
  );
  assert.equal(f.events.at(-1)[0], "removeRoot");
  assert.equal(f.events.at(-1)[1], realpathSync(f.root));
  assert.deepEqual(
    f.events.findLast(
      ([event, kind]) => event === "remove" && kind === "image",
    ),
    ["remove", "image", f.resources.imageTag],
  );
});

test("failed removal preserves the recovery manifest and fixture root", (t) => {
  const f = fixture(t);
  const remainingVolume = f.resources.volumes[0];
  f.options.removeResource = (kind, id) => {
    f.events.push(["remove", kind, id]);
    if (kind !== "volume" || id !== remainingVolume)
      f.active.delete(`${kind}:${id}`);
  };

  assert.throws(
    () => cleanupSmokeFixture(f.resources, f.manifestPath, f.options),
    /cleanup left exact volume/u,
  );
  assert.equal(f.events.filter(([event]) => event === "inspect").length, 16);
  assert.equal(
    f.events.some(([event]) => event === "removeRoot"),
    false,
  );
  assert.equal(readFileSync(f.manifestPath, "utf8"), "{}");
});

test("inspection failure preserves the recovery manifest and fixture root", (t) => {
  const f = fixture(t);
  const inspectBeforeRemoval = f.options.inspectResource;
  let removalStarted = false;
  f.options.removeResource = (kind, id) => {
    removalStarted = true;
    f.events.push(["remove", kind, id]);
    f.active.delete(`${kind}:${id}`);
  };
  f.options.inspectResource = (...args) => {
    if (removalStarted) throw new Error("inspection unavailable");
    return inspectBeforeRemoval(...args);
  };

  assert.throws(
    () => cleanupSmokeFixture(f.resources, f.manifestPath, f.options),
    /inspection unavailable/u,
  );
  assert.equal(
    f.events.some(([event]) => event === "removeRoot"),
    false,
  );
  assert.equal(readFileSync(f.manifestPath, "utf8"), "{}");
});

test("misleading not found inspection error preserves the recovery manifest and fixture root", (t) => {
  const f = fixture(t);
  const inspectBeforeRemoval = f.options.inspectResource;
  let removalStarted = false;
  const remainingVolume = f.resources.volumes[0];
  f.options.removeResource = (kind, id) => {
    removalStarted = true;
    f.events.push(["remove", kind, id]);
    if (kind !== "volume" || id !== remainingVolume)
      f.active.delete(`${kind}:${id}`);
  };
  f.options.inspectResource = (kind, id) => {
    if (removalStarted && kind === "volume" && id === remainingVolume) {
      const stderr = "daemon plugin not found";
      if (isMissingDockerResource(kind, id, stderr)) return undefined;
      throw new Error(`unable to inspect smoke fixture ${kind}`);
    }
    return inspectBeforeRemoval(kind, id);
  };

  assert.throws(
    () => cleanupSmokeFixture(f.resources, f.manifestPath, f.options),
    /unable to inspect smoke fixture volume/u,
  );
  assert.equal(f.active.has(`volume:${remainingVolume}`), true);
  assert.equal(
    f.events.some(([event]) => event === "removeRoot"),
    false,
  );
  assert.equal(readFileSync(f.manifestPath, "utf8"), "{}");
});

test("missing-resource diagnostics require the exact resource type and ID", () => {
  assert.equal(
    isMissingDockerResource("volume", "target-volume", "resource not found"),
    false,
  );
  assert.equal(
    isMissingDockerResource(
      "volume",
      "target-volume",
      "Error response from daemon: get target-volume: no such volume",
    ),
    true,
  );
});
