import { strict as assert } from "node:assert";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { agentModelCatalog, allowedOverrideModels } from "./agent-model-overrides.ts";
import { DEFAULT_CONFIG } from "./config.ts";

test("Agent model catalog follows the live Pi scope unless a custom list is configured", () => {
  const fast = {
    provider: "extension/provider",
    id: "fast/variant",
    reasoning: false,
  } as Model<Api>;
  const strong = {
    provider: "vendor",
    id: "strong",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh" },
  } as Model<Api>;
  const missing = { ...fast, id: "missing" };
  const ctx = {
    modelRegistry: { getAvailable: () => [fast, strong] },
    scopedModels: [{ model: fast }, { model: missing }],
  };
  const enabled = { ...DEFAULT_CONFIG, allowAgentModelOverrides: true };
  const explicit = {
    ...enabled,
    allowedAgentModels: ["vendor/strong", "extension/provider/missing"],
  };

  assert.deepEqual(
    allowedOverrideModels(ctx, {
      ...explicit,
      allowAgentModelOverrides: false,
    }),
    [],
  );
  assert.equal(agentModelCatalog(ctx, DEFAULT_CONFIG), undefined);
  assert.deepEqual(allowedOverrideModels(ctx, enabled), [fast]);
  assert.deepEqual(agentModelCatalog(ctx, enabled), [
    { model: "extension/provider/fast/variant", thinking: ["off"] },
  ]);
  assert.deepEqual(allowedOverrideModels(ctx, explicit), [strong]);

  ctx.scopedModels = [{ model: strong }];
  assert.deepEqual(allowedOverrideModels(ctx, enabled), [strong]);
  ctx.scopedModels = [{ model: missing }];
  assert.deepEqual(agentModelCatalog(ctx, enabled), []);
  ctx.scopedModels = [];
  assert.deepEqual(allowedOverrideModels(ctx, enabled), [fast, strong]);

  const sameToken = {
    ...fast,
    provider: "extension",
    id: "provider/fast/variant",
  };
  ctx.scopedModels = [{ model: sameToken }];
  assert.deepEqual(allowedOverrideModels(ctx, enabled), []);
});
