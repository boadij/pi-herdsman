import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HerdsmanConfig } from "./config.ts";

type ModelCatalogContext = Pick<ExtensionContext, "scopedModels"> & {
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAvailable">;
};

export const EXPECTED_STARTUP_MODEL_ENV = "PI_HERDSMAN_EXPECTED_STARTUP_MODEL";

export const modelToken = (model: { provider: string; id: string }): string =>
  `${model.provider}/${model.id}`;

export function allowedOverrideModels(
  ctx: ModelCatalogContext,
  config: HerdsmanConfig,
) {
  if (!config.allowAgentModelOverrides) return [];

  const available = ctx.modelRegistry.getAvailable();
  const configured = config.allowedAgentModels;
  const configuredTokens = new Set(configured);
  // Reject collisions before applying scope; a scoped subset cannot disambiguate
  // the public token. Pi's CLI also compares model references case-insensitively.
  const tokenCounts = new Map<string, number>();
  for (const model of available) {
    const token = modelToken(model).toLowerCase();
    tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  }
  return available.filter((model) => {
    const token = modelToken(model);
    if (tokenCounts.get(token.toLowerCase()) !== 1) return false;
    return configuredTokens.size > 0
      ? configuredTokens.has(token)
      : ctx.scopedModels.length === 0 ||
          ctx.scopedModels.some(
            ({ model: scoped }) =>
              scoped.provider === model.provider && scoped.id === model.id,
          );
  });
}

export function sessionAgentModelCatalog(
  ctx: ModelCatalogContext,
  config: HerdsmanConfig,
): string | undefined {
  const catalog = agentModelCatalog(ctx, config);
  if (!catalog) return undefined;
  return (
    `${JSON.stringify(catalog)}\n\n` +
    "This is a fixed session model catalog snapshot. Use list_agents for current choices."
  );
}

export function agentModelCatalog(
  ctx: ModelCatalogContext,
  config: HerdsmanConfig,
) {
  if (!config.allowAgentModelOverrides) return undefined;
  return allowedOverrideModels(ctx, config).map((model) => ({
    model: modelToken(model),
    thinking: getSupportedThinkingLevels(model),
  }));
}
