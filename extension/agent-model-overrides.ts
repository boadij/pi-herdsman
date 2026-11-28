import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VALID_THINKING_LEVELS } from "./agent-definitions.ts";
import type { HerdsmanConfig } from "./config.ts";

type ModelCatalogContext = Pick<ExtensionContext, "scopedModels"> & {
  modelRegistry: Pick<ExtensionContext["modelRegistry"], "getAvailable">;
};

export const EXPECTED_STARTUP_MODEL_ENV = "PI_HERDSMAN_EXPECTED_STARTUP_MODEL";

export const modelToken = (model: { provider: string; id: string }): string =>
  `${model.provider}/${model.id}`;

export type StartupModelExpectation = {
  provider: string;
  id: string;
  requireCatalog: boolean;
  thinking?: string;
};

export function inheritedStartupModelExpectation(
  registry: ExtensionContext["modelRegistry"],
  { provider, id }: NonNullable<ExtensionContext["model"]>,
): StartupModelExpectation {
  const registered = registry.find(provider, id);
  return {
    provider,
    id,
    requireCatalog: registered?.provider === provider && registered.id === id,
  };
}

export function readStartupModelExpectation(): StartupModelExpectation | undefined {
  const raw = process.env[EXPECTED_STARTUP_MODEL_ENV];
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Report the same bounded error as for an invalid shape.
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const { provider, id, requireCatalog, thinking } = parsed as Record<string, unknown>;
    if (
      typeof provider === "string" &&
      provider.trim() &&
      typeof id === "string" &&
      id.trim() &&
      typeof requireCatalog === "boolean" &&
      (thinking === undefined ||
        (typeof thinking === "string" && VALID_THINKING_LEVELS.some((level) => level === thinking)))
    )
      return { provider, id, requireCatalog, thinking };
  }
  throw new Error("Expected startup model identity is invalid");
}

export function assertStartupModel(
  ctx: Pick<ExtensionContext, "model" | "modelRegistry" | "thinkingLevel">,
  expected: StartupModelExpectation,
): void {
  const { provider, id, requireCatalog, thinking } = expected;
  const actual = ctx.model;
  // Pi may synthesize the exact ID even when a required catalog entry is absent.
  const registered = requireCatalog ? ctx.modelRegistry.find(provider, id) : undefined;
  if (
    actual?.provider !== provider ||
    actual.id !== id ||
    (requireCatalog && (registered?.provider !== provider || registered.id !== id))
  )
    throw new Error(
      `Expected startup model ${modelToken(expected)} was not selected${requireCatalog ? " from the child catalog" : ""}. Pi selected ${actual ? modelToken(actual) : "no model"}.`,
    );
  if (thinking !== undefined && ctx.thinkingLevel !== thinking)
    throw new Error(
      `Expected startup thinking level ${thinking}, but Pi selected ${ctx.thinkingLevel ?? "no level"}.`,
    );
}

export function allowedOverrideModels(ctx: ModelCatalogContext, config: HerdsmanConfig) {
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
            ({ model: scoped }) => scoped.provider === model.provider && scoped.id === model.id,
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

export function agentModelCatalog(ctx: ModelCatalogContext, config: HerdsmanConfig) {
  if (!config.allowAgentModelOverrides) return undefined;
  return allowedOverrideModels(ctx, config).map((model) => ({
    model: modelToken(model),
    thinking: getSupportedThinkingLevels(model),
  }));
}
