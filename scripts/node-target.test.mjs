import assert from "node:assert/strict";
import test from "node:test";
import { resolveNodeTarget } from "./node-target.mjs";

test("Node compatibility derives from the engine minimum and rejects drift", () => {
  assert.deepEqual(
    resolveNodeTarget({
      engines: { node: ">=24.3.1" },
      devDependencies: { "@types/node": "24.7.9" },
    }),
    { version: "24.3.1", buildTarget: "node24" },
  );
  assert.throws(
    () =>
      resolveNodeTarget({
        engines: { node: ">=22.19.0" },
        devDependencies: { "@types/node": "26.6.6" },
      }),
    /@types\/node major must match/u,
  );
  assert.throws(
    () =>
      resolveNodeTarget({
        engines: { node: "^22.19.0" },
        devDependencies: { "@types/node": "22.19.19" },
      }),
    /engines\.node must specify/u,
  );
});
