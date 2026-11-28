import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { formatRuntimeBuild, type RuntimeBuild } from "../compatibility.ts";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { SelectItem } from "@earendil-works/pi-tui";
import { overrideModelPickerTitle, pickOverrideModels } from "./override-model-picker.ts";
import {
  DEFAULT_CONFIG,
  DEFAULT_MAX_AGENT_DEPTH,
  DEFAULT_STATUS_WIDGET_MAX_ROWS,
  effectiveMergePolicy,
} from "../config.ts";
import {
  discoverGlobalAgentDefinition,
  notifyDefinitionWarning,
  discoverRoleDefinitions,
  expandDefinitionBodyFragments,
  expandDefinitionBodyFragmentsWithSources,
  type ExpandedDefinitionBodyPart,
  selectedAgentContextFiles,
  contextInheritance,
  type DefinitionInspection,
  definitionEditTargets,
  readDefinitionEditSnapshot,
  supportsDefinitionLaunchSettings,
  type DefinitionCategory,
  type DiscoverAgentDefinitionsOptions,
  type AgentDefinition,
  type DefinitionEditScope,
} from "../agent-definitions.ts";
import { isLeadExecutionMode, type LeadExecutionMode, type SpawnPlacement } from "../core.ts";
import {
  compactModelToken,
  managedExecutionLabel,
  summarizeDefinitionLayerChanges,
  type StatusSnapshot,
  type formatStatusCounts,
  type InstructionSection,
} from "../presentation.ts";

type LeadCommandHost = {
  persistStopClosures(
    ctx: ExtensionContext,
    closures: NonNullable<import("../agent-controller.ts").StopOwnedAgentsResult["closures"]>,
  ): Promise<number>;
  collectOwnedSessionUsage(
    ctx: ExtensionContext,
    managedLeads?: readonly { id: string; piSessionFile?: string }[],
  ): ReturnType<typeof import("../agent-controller.ts").collectSessionUsage>;
  formatSessionUsage: typeof import("../presentation.ts").formatSessionUsage;
  runHerdr: typeof import("../herdr.ts").runHerdr;
  presentStopSummary(summary: string): void;
  build: RuntimeBuild;
  selectMenu(
    ctx: ExtensionContext,
    title: string,
    items: readonly (SelectItem & { help?: string })[],
    selectedValue?: string,
  ): Promise<string | undefined>;
  updateConfig(
    key: string,
    value: unknown,
    expectedManagerMergeEnabled?: import("../config.ts").ManagerMergeSetting,
  ): void;
  readConfig: typeof import("../config.ts").readConfig;
  readEffectiveConfig: typeof import("../config.ts").readEffectiveConfig;
  readProjectOverrides: typeof import("../config.ts").readProjectOverrides;
  updateProjectOverride: typeof import("../config.ts").updateProjectOverride;
  reviewPendingRemoval(ctx: ExtensionCommandContext): Promise<void>;
  getRemovalPreauthorization: ReturnType<
    typeof import("./project.ts").createLeadProjectRuntime
  >["getRemovalPreauthorization"];
  setRemovalPreauthorization: ReturnType<
    typeof import("./project.ts").createLeadProjectRuntime
  >["setRemovalPreauthorization"];
  setRepositoryMergeOverride: ReturnType<
    typeof import("./project.ts").createLeadProjectRuntime
  >["setRepositoryMergeOverride"];
  contextAgentDefinitions(
    ctx: ExtensionContext,
    onWarning?: (message: string) => void,
  ): Promise<{
    definitions: AgentDefinition[];
    roleDefinitions: AgentDefinition[];
    projectTrusted: boolean;
  }>;
  getSystemPromptOptions(
    ctx: ExtensionCommandContext,
  ): import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions;
  chiefSystemPrompt(
    options: import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions | undefined,
    body: string,
  ): string;
  chiefGlobalInstructions(
    options: import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions | undefined,
  ): Array<{ path: string; content: string }>;
  roleCharter(ctx: ExtensionContext): string;
  isCurrentChief(ctx: ExtensionContext): boolean;
  supervisoryProfileBody(ctx: ExtensionContext, role: "manager" | "chief"): string;
  executionPrompt(): string | undefined;
  leadExecutionDefinition(): AgentDefinition | undefined;
  resolveDefinition(
    category: DefinitionCategory,
    name: string,
    options?: DiscoverAgentDefinitionsOptions,
  ): AgentDefinition;
  inspectDefinition(
    category: DefinitionCategory,
    name: string,
    options?: DiscoverAgentDefinitionsOptions,
  ): DefinitionInspection;
  expandDefinitionBodyFragments: typeof expandDefinitionBodyFragments;
  expandDefinitionBodyFragmentsWithSources?: typeof expandDefinitionBodyFragmentsWithSources;
  expandAgentBodyFiles: typeof import("../agent-definitions.ts").expandAgentBodyFiles;
  selectedAgentContextFiles: typeof selectedAgentContextFiles;
  setLeadExecutionMode(ctx: ExtensionCommandContext, mode: LeadExecutionMode): Promise<void>;
  leadExecutionPresentation(): {
    managed: boolean;
    mode: LeadExecutionMode;
    nativeOnly?: boolean;
    lifecycle?: "assigned" | "unavailable" | "retired";
  };
  agentDefinitionEnabled(definition: AgentDefinition): boolean;
  agentDefinitionMetadata(definition: AgentDefinition): Record<string, unknown>;
  appendDefinitionsEntry(data: {
    definitions: Record<string, unknown>[];
    inspector: { summary: string[]; sections: InstructionSection[] };
  }): void;
  formatAgentDefinitions(definitions: readonly Record<string, unknown>[]): string[];
  validThinkingLevels: readonly string[];
  updateAgentOverride(
    definition: AgentDefinition,
    field: string,
    value: unknown,
    options?: { scope?: DefinitionEditScope; expectedContent?: string | null },
  ): { changed: boolean; path?: string };
  placementSettings(ctx: ExtensionContext): Promise<{ effective: SpawnPlacement }>;
  updateSpawnPlacement(placement: string): void;
  messageLimits(
    ctx: ExtensionContext,
  ): Promise<{ inline: { bytes: number }; mailbox: { bytes: number } }>;
  formatMessageLimit(bytes: number): string;
  validByteLimit(bytes: number): boolean;
  validStatusWidgetMaxRows: typeof import("../config.ts").validStatusWidgetMaxRows;
  validMaxAgentDepth: typeof import("../config.ts").validMaxAgentDepth;
  input(ctx: ExtensionCommandContext, label: string): Promise<string | undefined>;
  updateMessageLimit(key: string, value: number | undefined): void;
  isLead(): boolean;
  formatStatusCounts: typeof formatStatusCounts;
  openSupervisionOverview(ctx: ExtensionCommandContext): Promise<void>;
  controller: ReturnType<typeof import("../agent-controller.ts").createAgentController>;
  loadStatusSnapshot(ctx: ExtensionContext, signal?: AbortSignal): Promise<StatusSnapshot>;
  roleActive(role: "manager" | "chief"): boolean;
  transitionRole(
    role: "manager" | "chief",
    leave: boolean,
    ctx: ExtensionCommandContext,
  ): Promise<string>;
  maybeFinishHerdRun(ctx: ExtensionContext): Promise<void>;
  getThinkingLevel(): string;
};
export type LeadCommandBaseHost = Omit<
  LeadCommandHost,
  | "isLead"
  | "formatStatusCounts"
  | "openSupervisionOverview"
  | "controller"
  | "loadStatusSnapshot"
  | "roleActive"
  | "transitionRole"
  | "maybeFinishHerdRun"
  | "getThinkingLevel"
>;

const layoutLabels = {
  tab: "Shared tab",
  subtree: "Separate tabs",
  split: "Split panes",
} as const;

const leadModeLabels = {
  flexible: "Flexible",
  orchestrate: "Orchestrate",
} as const;

const sizeLabel = (bytes: number) => (bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} B`);

const countLabel = (count: number, unit: "line" | "level") =>
  `${count} ${unit}${count === 1 ? "" : "s"}`;

const mergeDescription = (policy: ReturnType<typeof effectiveMergePolicy>) =>
  `${!policy.enabled ? "Off" : policy.allowDivergence ? "Conflict-free" : "Fast-forward"} · ${policy.source === "repository" ? "Repository" : "Global"}`;

export function createLeadCommandRuntime(host: LeadCommandHost) {
  const confirmMergeGrant = (
    ctx: ExtensionCommandContext,
    setting: true | "divergent",
    scope: string,
  ) =>
    ctx.ui.confirm(
      `Allow Manager integration for ${scope}?`,
      setting === "divergent"
        ? "Allow conflict-free divergent merges? Git may create a merge commit and verified integration may automatically remove the exact source worktree."
        : "Allow fast-forward integration and automatic cleanup of successfully integrated source worktrees?",
      { signal: ctx.signal },
    );
  const markCurrent = <T extends SelectItem>(items: T[], current: string): T[] =>
    items.map((item) =>
      item.value === current
        ? {
            ...item,
            description: item.description ? `${item.description} · current` : "current",
          }
        : item,
    );
  const modelToken = (model: { provider: string; id: string }): string =>
    `${model.provider}/${model.id}`;
  return {
    async openPlacementMenu(ctx: ExtensionCommandContext): Promise<void> {
      const current = await host.placementSettings(ctx);
      const selected = await host.selectMenu(
        ctx,
        "Agent terminal layout",
        markCurrent(
          [
            {
              value: "tab",
              label: "Shared Agents tab",
              help: "Directly delegated Agents from this controller share one tab.",
            },
            {
              value: "subtree",
              label: layoutLabels.subtree,
              help: "Each directly delegated Agent gets its own tab.",
            },
            {
              value: "split",
              label: layoutLabels.split,
              help: "Open directly delegated Agents in split panes beside the caller's pane.",
            },
          ].map((item) => ({
            ...item,
            help: `${item.help} Nested Agents still split within their owner's tab.`,
          })),
          current.effective,
        ),
        current.effective,
      );
      if (!selected || selected === current.effective) return;
      host.updateSpawnPlacement(selected);
      const verified = await host.placementSettings(ctx);
      if (verified.effective !== selected)
        throw new Error(`Agent placement did not become effective: ${verified.effective}`);
      ctx.ui.notify(`Agent terminal layout: ${layoutLabels[verified.effective]}`);
    },
    async openMessageLimitsMenu(ctx: ExtensionCommandContext): Promise<void> {
      let selectedLimit = "inlineAttachmentLimitBytes";
      const labels = {
        inlineAttachmentLimitBytes: "Shared file content",
        mailboxPayloadLimitBytes: "Coordination messages",
      } as const;
      while (true) {
        const limits = await host.messageLimits(ctx);
        const setting = await host.selectMenu(
          ctx,
          "Message and file limits",
          [
            {
              value: "inlineAttachmentLimitBytes",
              label: labels.inlineAttachmentLimitBytes,
              description: host.formatMessageLimit(limits.inline.bytes),
              help: "Maximum size of complete text content included from a single attached file. Whether larger files can be referenced depends on the handoff.",
            },
            {
              value: "mailboxPayloadLimitBytes",
              label: labels.mailboxPayloadLimitBytes,
              description: host.formatMessageLimit(limits.mailbox.bytes),
              help: "Maximum payload size for managed Agent requests and other supported coordination messages, including Manager assignments.",
            },
          ],
          selectedLimit,
        );
        if (setting !== "inlineAttachmentLimitBytes" && setting !== "mailboxPayloadLimitBytes")
          return;
        selectedLimit = setting;
        const currentBytes =
          setting === "inlineAttachmentLimitBytes" ? limits.inline.bytes : limits.mailbox.bytes;
        const defaultBytes = DEFAULT_CONFIG[setting];
        const presets = [1, 4, 16, 64, 128]
          .map((kib) => kib * 1024)
          .filter((bytes) => bytes !== defaultBytes);
        const currentChoice =
          currentBytes === defaultBytes
            ? "default"
            : presets.includes(currentBytes)
              ? String(currentBytes)
              : "custom";
        const choice = await host.selectMenu(
          ctx,
          labels[setting],
          markCurrent(
            [
              {
                value: "default",
                label: `Use default (${host.formatMessageLimit(defaultBytes)})`,
              },
              ...presets.map((bytes) => ({
                value: String(bytes),
                label: host.formatMessageLimit(bytes),
              })),
              {
                value: "custom",
                label: "Custom…",
                description:
                  currentChoice === "custom" ? host.formatMessageLimit(currentBytes) : undefined,
                help: "Enter a custom limit in KiB, from 1 through 1024.",
              },
            ],
            currentChoice,
          ),
          currentChoice,
        );
        if (!choice) continue;
        let value: number | undefined;
        if (choice === "default") value = undefined;
        else if (choice === "custom") {
          const input = await host.input(ctx, "Custom limit in KiB (1–1024)");
          if (input === undefined) continue;
          const kib = Number(input);
          if (!/^\d+$/u.test(input.trim()) || !host.validByteLimit(kib * 1024)) {
            ctx.ui.notify("Enter an integer from 1 through 1024 KiB", "error");
            continue;
          }
          value = kib * 1024;
        } else value = Number(choice);
        if (value !== undefined && value === currentBytes) continue;
        try {
          host.updateMessageLimit(setting, value);
          ctx.ui.notify(
            `${labels[setting]}: ${value === undefined ? "default restored" : host.formatMessageLimit(value)}`,
          );
        } catch (error) {
          ctx.ui.notify(`Could not update ${labels[setting]}: ${String(error)}`, "error");
        }
      }
    },
    executionSettings(
      ctx: ExtensionContext,
      definition: AgentDefinition,
    ): { model: string; thinking: string } {
      return {
        model:
          typeof definition.frontmatter.model === "string"
            ? compactModelToken(definition.frontmatter.model)
            : ctx.model
              ? `inherit · ${compactModelToken(modelToken(ctx.model))}`
              : "inherit",
        thinking:
          definition.frontmatter.thinking === false
            ? "off"
            : typeof definition.frontmatter.thinking === "string"
              ? definition.frontmatter.thinking
              : `inherit · ${host.getThinkingLevel()}`,
      };
    },
    resolveConfiguredModel(ctx: ExtensionContext, configured: string): Model<Api> | undefined {
      const models = ctx.modelRegistry.getAll();
      const canonical = models.find(
        (candidate: Model<Api>) => modelToken(candidate) === configured,
      );
      if (canonical) return canonical;
      const compactMatches = models.filter(
        (candidate: Model<Api>) => compactModelToken(modelToken(candidate)) === configured,
      );
      return compactMatches.length === 1 ? compactMatches[0] : undefined;
    },
    async openDefinitionsMenu(
      ctx: ExtensionCommandContext,
      initialSection?: "agents" | "roles",
    ): Promise<void> {
      let selectedSection = "agents";
      const selectedDefinitions: Record<string, string | undefined> = {};
      const loadDefinitions = async (
        section: string,
        includeProject = true,
        onWarning?: (message: string) => void,
      ) =>
        section === "agents"
          ? (await host.contextAgentDefinitions(ctx, onWarning)).definitions
          : discoverRoleDefinitions({
              ...(includeProject && ctx.isProjectTrusted() ? { projectRoot: ctx.cwd } : {}),
              onWarning: (message) => {
                notifyDefinitionWarning(ctx, message);
                onWarning?.(message);
              },
            });
      const definitionKey = ({ category, name }: AgentDefinition) =>
        category === "agent" ? name : `${category}:${name}`;
      const reloadDefinition = async (category: DefinitionCategory, name: string) => {
        const loaded = await loadDefinitions(category === "agent" ? "agents" : "roles");
        return loaded.find(
          (candidate) => candidate.category === category && candidate.name === name,
        );
      };
      while (true) {
        const section =
          initialSection ??
          (await host.selectMenu(
            ctx,
            "Agents & Coordinators",
            [
              {
                value: "agents",
                label: "Agent definitions",
                help: "Definitions available for Agent delegation.",
              },
              {
                value: "roles",
                label: "Coordinator profiles",
                help:
                  "Profiles for existing Lead, Manager, and Chief roles; " +
                  "these do not grant authority.",
              },
            ],
            selectedSection,
          ));
        if (section !== "agents" && section !== "roles") return;

        selectedSection = section;
        definitionList: while (true) {
          const warnings: string[] = [];
          const availableDefinitions = await loadDefinitions(section, true, (message) =>
            warnings.push(message),
          );
          if (!availableDefinitions.length && !warnings.length) {
            ctx.ui.notify(
              `No ${section === "agents" ? "Agent definitions" : "Coordinator profiles"} are available.`,
            );
            break definitionList;
          }
          const options = availableDefinitions.map((definition) => {
            const { model, thinking } = this.executionSettings(ctx, definition);
            const sources = [
              definition.extensionSource ? "bundled" : undefined,
              definition.overrideSource ? "global" : undefined,
              definition.projectSource ? "project" : undefined,
              definition.privateRepositorySource ? "private repo" : undefined,
            ]
              .filter(Boolean)
              .join(" + ");
            const coordinator = definition.category !== "agent";
            const launchSettings = supportsDefinitionLaunchSettings(definition);
            const description = [
              ...(launchSettings ? [model, thinking] : []),
              sources,
              ...(!coordinator && !host.agentDefinitionEnabled(definition) ? ["disabled"] : []),
            ]
              .filter(Boolean)
              .join(" · ");
            return {
              value: definitionKey(definition),
              label: coordinator ? `${definition.name} (${definition.category})` : definition.name,
              description,
              ...(typeof definition.frontmatter.description === "string"
                ? { help: definition.frontmatter.description }
                : {}),
            };
          });
          let warningValue = "__definition_warnings__";
          while (
            availableDefinitions.some((definition) => definitionKey(definition) === warningValue)
          )
            warningValue += "_";
          if (warnings.length)
            options.unshift({
              value: warningValue,
              label: `⚠ ${warnings.length} misplaced definition(s)`,
              description: "Select to inspect paths",
              help: warnings[0],
            });
          const selected = await host.selectMenu(
            ctx,
            section === "agents" ? "Agents" : "Coordinators",
            options,
            selectedDefinitions[section],
          );
          if (selected === undefined) break definitionList;
          if (!selected) continue;
          if (selected === warningValue) {
            for (const warning of warnings) ctx.ui.notify(warning, "warning");
            continue;
          }
          const selectedEntry = availableDefinitions.find(
            (definition) => definitionKey(definition) === selected,
          );
          if (!selectedEntry) continue;
          selectedDefinitions[section] = definitionKey(selectedEntry);
          let definition = selectedEntry;
          const { category, name: selectedName } = definition;
          let selectedScope = definitionEditTargets(definition)[0]?.scope ?? "global";
          let selectedAction = "model";
          while (true) {
            const targets = definitionEditTargets(definition);
            if (!targets.some((candidate) => candidate.scope === selectedScope)) {
              ctx.ui.notify(
                `The ${selectedScope} definition source is no longer available.`,
                "warning",
              );
              break;
            }
            const target = targets.find((candidate) => candidate.scope === selectedScope)!;
            const snapshotResult = (() => {
              try {
                return {
                  snapshot: readDefinitionEditSnapshot(definition, target),
                };
              } catch (error) {
                return { error };
              }
            })();
            const snapshot = "snapshot" in snapshotResult ? snapshotResult.snapshot : undefined;
            const snapshotError = "error" in snapshotResult ? snapshotResult.error : undefined;
            const globalDefinition =
              category !== "agent"
                ? (await loadDefinitions("roles", false)).find(
                    (candidate) =>
                      candidate.category === category && candidate.name === definition.name,
                  )
                : discoverGlobalAgentDefinition(definition.name);
            const projectSnapshot = selectedScope === "project" ? snapshot : undefined;
            const valueAtScope = (field: "model" | "thinking" | "enabled") =>
              selectedScope === "private"
                ? definition.frontmatter[field]
                : selectedScope === "project"
                  ? (projectSnapshot?.frontmatter[field] ?? globalDefinition?.frontmatter[field])
                  : globalDefinition?.frontmatter[field];
            const effectiveHere = (field: "model" | "thinking" | "enabled") =>
              field === "enabled"
                ? host.agentDefinitionEnabled(definition)
                : definition.frontmatter[field];
            const enabledAtScope = valueAtScope("enabled") ?? true;
            const scopeLabel = selectedScope === "private" ? "private repo" : selectedScope;
            const thinkingValue = (value: unknown) =>
              value === false ? "off" : typeof value === "string" ? value : "inherit";
            const localValue = (field: "model" | "thinking" | "enabled") =>
              snapshot ? snapshot.frontmatter[field] : undefined;
            const localValueLabel = (field: "model" | "thinking" | "enabled") =>
              snapshotError
                ? "unavailable"
                : typeof localValue(field) === "string" || typeof localValue(field) === "boolean"
                  ? String(localValue(field))
                  : "inherit";
            const managedDefinition =
              category === "lead" && supportsDefinitionLaunchSettings(definition);
            const launchSettings = supportsDefinitionLaunchSettings(definition);
            const action = await host.selectMenu(
              ctx,
              definition.name,
              [
                ...(targets.length > 1
                  ? [
                      {
                        value: "scope",
                        label: "Edit scope",
                        description: selectedScope,
                      },
                    ]
                  : []),
                ...(launchSettings
                  ? [
                      {
                        value: "model",
                        label: `Model (${scopeLabel})`,
                        description: `${localValueLabel("model")}${typeof effectiveHere("model") === "string" ? ` · Effective here: ${effectiveHere("model")}` : ""}`,
                        help: managedDefinition
                          ? "Model for future managed Lead launches. Changes do not affect a running Lead."
                          : "Model for future Agent generations. When unset, fresh delegation inherits the spawning controller and continuation restores the saved session model.",
                      },
                    ]
                  : []),
                ...(launchSettings
                  ? [
                      {
                        value: "thinking",
                        label: `Thinking (${scopeLabel})`,
                        description: `${snapshotError ? "unavailable" : thinkingValue(localValue("thinking"))}${effectiveHere("thinking") !== undefined ? ` · Effective here: ${thinkingValue(effectiveHere("thinking"))}` : ""}`,
                        help: managedDefinition
                          ? "Thinking level for future managed Lead launches. Changes do not affect a running Lead."
                          : "Thinking level for future Agent generations. When unset, fresh delegation inherits the spawning controller and continuation restores the saved session level.",
                      },
                    ]
                  : []),
                ...(category === "agent"
                  ? [
                      {
                        value: "enabled",
                        label: `Enabled (${scopeLabel})`,
                        description: `${snapshotError ? "unavailable" : localValue("enabled") === undefined ? "inherit" : localValue("enabled") === false ? "off" : "on"} · Effective here: ${effectiveHere("enabled") === false ? "off" : "on"}`,
                        help: "Control whether this Agent definition is available for new assignments. Running Agents are unchanged.",
                      },
                    ]
                  : []),
                {
                  value: "details",
                  label: "Details…",
                  help: "Show effective definition metadata and expanded instructions.",
                },
              ],
              selectedAction,
            );
            if (!action) break;
            selectedAction = action;
            if (action === "scope") {
              const chosen = await host.selectMenu(
                ctx,
                "Edit scope",
                targets.map((candidate) => ({
                  value: candidate.scope,
                  label:
                    candidate.scope === "private"
                      ? "Private repository"
                      : candidate.scope[0].toUpperCase() + candidate.scope.slice(1),
                  description: candidate.path,
                  help:
                    candidate.scope === "project"
                      ? "This worktree's project file may be included in a Git commit."
                      : candidate.scope === "private"
                        ? "Private file shared by trusted linked worktrees in this clone."
                        : "Global user definition.",
                })),
                selectedScope,
              );
              if (chosen === "private" || chosen === "project" || chosen === "global")
                selectedScope = chosen;
              continue;
            }
            if (action === "details") {
              let current;
              try {
                current = await reloadDefinition(category, selectedName);
              } catch (error) {
                ctx.ui.notify(String(error), "error");
                break;
              }
              if (!current) {
                ctx.ui.notify(`Definition ${selectedName} is no longer available.`, "warning");
                break;
              }
              definition = current;
              const metadata = host.agentDefinitionMetadata(current);
              if (ctx.mode === "tui") {
                try {
                  const promptOptions =
                    category !== "agent" ? host.getSystemPromptOptions(ctx) : undefined;
                  const inspection = host.inspectDefinition(
                    category,
                    current.name,
                    ctx.isProjectTrusted() ? { projectRoot: ctx.cwd } : {},
                  );
                  const expandedFragments: ExpandedDefinitionBodyPart[][] =
                    host.expandDefinitionBodyFragmentsWithSources?.(
                      inspection.bodyFragments,
                      [],
                      "definition details",
                    ) ??
                    host
                      .expandDefinitionBodyFragments(
                        inspection.bodyFragments,
                        [],
                        "definition details",
                      )
                      .map((text) => [{ text }]);
                  const fragments = expandedFragments.map((parts) =>
                    parts.map(({ text }) => text).join(""),
                  );
                  const sources = inspection.layers.map(({ scope }) => scope);
                  const roleProfile = category !== "agent";
                  const selectedLead =
                    category === "lead" ? host.leadExecutionDefinition() : undefined;
                  const managedLeadProfile = managedDefinition;
                  let activeRole =
                    (category === "manager" &&
                      current.name === "manager" &&
                      host.roleActive("manager")) ||
                    (category === "chief" && host.isCurrentChief(ctx)) ||
                    (category === "lead" &&
                      selectedLead?.category === category &&
                      selectedLead.name === current.name &&
                      !host.roleActive("manager") &&
                      !host.roleActive("chief"));
                  const activeChief = category === "chief" && activeRole;
                  const currentRoleCharter =
                    activeRole && category !== "chief" ? host.roleCharter(ctx) : undefined;
                  if (
                    currentRoleCharter?.includes(
                      "No active Herdsman role is verified for this Pi session.",
                    )
                  )
                    activeRole = false;
                  const activeExecutionDefinition = activeRole
                    ? host.leadExecutionDefinition()
                    : undefined;
                  const inheritance =
                    !roleProfile || managedLeadProfile ? contextInheritance(current) : undefined;
                  const roleContextFiles =
                    activeRole && category !== "chief"
                      ? (promptOptions?.contextFiles ?? []).map((file) => ({
                          path: file.path,
                          text: file.content,
                        }))
                      : [];
                  const chiefContextFiles =
                    category === "chief"
                      ? host.chiefGlobalInstructions(promptOptions).map((file) => ({
                          path: file.path,
                          text: file.content,
                        }))
                      : [];
                  const futureContextFiles =
                    inheritance && (!roleProfile || !activeRole)
                      ? host.selectedAgentContextFiles(current, ctx.cwd).map((file) => ({
                          path: file.path,
                          text: file.content,
                        }))
                      : [];
                  const contextFiles =
                    category === "chief"
                      ? chiefContextFiles
                      : roleProfile
                        ? activeRole
                          ? roleContextFiles
                          : futureContextFiles
                        : futureContextFiles;
                  const contextCount = inheritance
                    ? String(contextFiles.length)
                    : category === "chief"
                      ? String(chiefContextFiles.length)
                      : activeRole
                        ? String(roleContextFiles.length)
                        : "session-dependent";
                  const contextMode =
                    category === "chief"
                      ? "Chief forced prompt includes only global user instructions; project context excluded"
                      : activeRole
                        ? "Current Pi context from getSystemPromptOptions()"
                        : inheritance
                          ? inheritance.global && inheritance.ancestor && inheritance.project
                            ? "Pi native context: global, ancestor, project"
                            : [
                                  inheritance.global && "global",
                                  inheritance.ancestor && "ancestor",
                                  inheritance.project && "project",
                                ].filter(Boolean).length
                              ? `Selected Pi context: ${[
                                  inheritance.global && "global",
                                  inheritance.ancestor && "ancestor",
                                  inheritance.project && "project",
                                ]
                                  .filter(Boolean)
                                  .join(", ")}`
                              : "Pi context files disabled"
                          : "Coordinator profile context depends on its future session";
                  const rolePreview = activeRole
                    ? "active-session inputs"
                    : managedLeadProfile
                      ? "future Managed Lead launch"
                      : "prospective Coordinator profile";
                  const sections: InstructionSection[] = [];
                  const add = (
                    title: string,
                    content?: string,
                    source?: string,
                    format: "markdown" | "text" = "text",
                    changes?: string[],
                  ) => sections.push({ title, content, source, format, changes });
                  const addContexts = () => {
                    for (const file of contextFiles)
                      add("Pi context", file.text, file.path, "markdown");
                  };
                  const appendDefinition = (title: string) => {
                    const provenance = inspection.layers.flatMap((layer) => [
                      `${layer.scope} · ${basename(layer.path)}`,
                      ...summarizeDefinitionLayerChanges(layer).map((change) => `  ${change}`),
                    ]);
                    const fragments = inspection.bodyFragments;
                    let provenanceAttached = false;
                    fragments.forEach((fragment, index) => {
                      for (const part of expandedFragments[index] ?? []) {
                        if (!part.text.length) continue;
                        add(
                          title,
                          part.text,
                          part.filePath ?? fragment.path,
                          "markdown",
                          provenanceAttached ? undefined : provenance,
                        );
                        provenanceAttached = true;
                      }
                    });
                    if (!provenanceAttached)
                      add(
                        title,
                        undefined,
                        undefined,
                        "text",
                        provenance.length ? provenance : undefined,
                      );
                  };
                  const promptMode = current.frontmatter.systemPromptMode ?? "append";
                  const chiefBody = activeChief
                    ? host.supervisoryProfileBody(ctx, "chief")
                    : fragments.join("\n\n");
                  const chiefPrompt =
                    category === "chief"
                      ? host.chiefSystemPrompt(promptOptions, chiefBody)
                      : undefined;
                  if (!roleProfile) {
                    add(
                      promptMode === "replace" ? "Replacement prompt" : "Pi base instructions",
                      promptMode === "replace"
                        ? "Pi base prefix replaced."
                        : "Native Pi defaults and tool guidance are not reconstructed.",
                    );
                    appendDefinition(
                      promptMode === "replace"
                        ? "Replacement body · Herdsman definition"
                        : "Herdsman definition",
                    );
                    const addGuidance = () =>
                      add("Herdsman shared guidance", "Managed launch input.");
                    if (inheritance?.global && inheritance.ancestor && inheritance.project) {
                      addGuidance();
                      addContexts();
                    } else {
                      addContexts();
                      addGuidance();
                    }
                    add("Pi skills/extensions", "Configured selections; load status unknown.");
                    add("Working directory", ctx.cwd);
                    add("Runtime contributions", "Session-dependent.");
                  } else if (category === "chief") {
                    add(
                      activeChief
                        ? "Active Chief forced prompt"
                        : "Prospective Chief forced prompt",
                      chiefPrompt ?? "",
                      undefined,
                      "text",
                    );
                    appendDefinition(
                      "Effective Chief profile on disk · may differ from active snapshot",
                    );
                    add(
                      "Chief context",
                      `Global user instruction files included: ${chiefContextFiles.length}; project context excluded.`,
                    );
                  } else if (managedLeadProfile) {
                    if (activeRole) {
                      if (activeExecutionDefinition?.name === current.name)
                        add(
                          "Managed Lead body",
                          host.expandAgentBodyFiles(
                            activeExecutionDefinition.body,
                            [],
                            "definition details",
                          ),
                          undefined,
                          "text",
                        );
                      add("Herdsman shared guidance", "Managed launch input.");
                      addContexts();
                      add("Runtime role contract", currentRoleCharter ?? "", undefined, "text");
                    } else {
                      appendDefinition("Managed Lead definition · future launch");
                      add("Herdsman shared guidance", "Managed Lead launch input.");
                      addContexts();
                    }
                    add("Working directory", ctx.cwd);
                    add("Runtime contributions", "Managed session-dependent.");
                  } else if (activeRole) {
                    add("Pi base prompt", "Native and not reconstructed.");
                    addContexts();
                    add("Working directory", ctx.cwd);
                    add(
                      "Herdsman role contract/profile",
                      currentRoleCharter ?? "",
                      undefined,
                      "text",
                    );
                    if (current.name === "flexible-lead" || current.name === "orchestrator-lead") {
                      const activeBody = host.executionPrompt();
                      if (activeBody) add("Lead execution profile", activeBody, undefined, "text");
                      appendDefinition(
                        "Effective Lead profile on disk · active prompt is a session snapshot",
                      );
                    } else if (category === "manager" && current.name === "manager")
                      appendDefinition(
                        "Effective Manager profile on disk · active prompt is a session snapshot",
                      );
                    add("Runtime contributions", "Session-dependent.");
                  } else {
                    appendDefinition("Prospective Coordinator profile contribution");
                    add("Runtime sections", "Depend on active role/session.");
                    add("Exact future prompt", "Unavailable until launch.");
                  }
                  if (roleProfile && !activeRole && !managedLeadProfile && category !== "chief")
                    add("Working directory", ctx.cwd);
                  host.appendDefinitionsEntry({
                    definitions: [metadata],
                    inspector: {
                      summary: [
                        `${roleProfile ? rolePreview : "Future Agent launch"} · ${sources.length} source(s) · ${contextCount} Pi context files`,
                        `${managedLeadProfile && !activeRole ? "Preview cwd" : "Context"}: ${ctx.cwd} · ${contextMode}`,
                        "Known-input preview only; provider/runtime transformations may add inputs.",
                      ],
                      sections,
                    },
                  });
                  return;
                } catch (error) {
                  ctx.ui.notify(
                    `Could not inspect ${current.name}: ${String(error).replace(/^Error: /u, "")}`,
                    "error",
                  );
                }
              } else {
                ctx.ui.notify(host.formatAgentDefinitions([metadata]).join("\n"));
              }
              continue;
            }
            if ("error" in snapshotResult) {
              ctx.ui.notify(String(snapshotResult.error), "warning");
              continue;
            }
            let field: "model" | "thinking" | "enabled";
            let value: string | boolean | undefined;
            if (action === "model") {
              field = "model";
              await ctx.modelRegistry.refresh();
              const models = ctx.modelRegistry.getAvailable();
              const tokens = [
                ...new Set(models.map((item: Model<Api>) => modelToken(item))),
              ].sort();
              const configured =
                typeof localValue("model") === "string"
                  ? (localValue("model") as string)
                  : undefined;
              if (configured && !tokens.includes(configured)) {
                const resolved = this.resolveConfiguredModel(ctx, configured);
                const resolvedToken = resolved ? modelToken(resolved) : configured;
                if (!tokens.includes(resolvedToken)) tokens.push(resolvedToken);
              }
              const idCounts = new Map<string, number>();
              for (const token of tokens) {
                const id = compactModelToken(token);
                idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
              }
              const resolvedConfigured = configured
                ? this.resolveConfiguredModel(ctx, configured)
                : undefined;
              const modelsByToken = new Map(
                models.map((item: Model<Api>) => [modelToken(item), item]),
              );
              if (resolvedConfigured)
                modelsByToken.set(modelToken(resolvedConfigured), resolvedConfigured);
              const modelItems = tokens.map((token) => {
                const id = compactModelToken(token);
                return {
                  value: token,
                  label: idCounts.get(id) === 1 ? id : token,
                  searchText: `${id} ${token} ${modelsByToken.get(token)?.name ?? ""}`,
                };
              });
              const selectedModel = await host.selectMenu(
                ctx,
                "Model",
                [
                  {
                    value: "inherit",
                    label: "Remove local override",
                    searchText: "Remove local override inherit",
                  },
                  ...modelItems,
                ],
                configured
                  ? resolvedConfigured
                    ? modelToken(resolvedConfigured)
                    : configured
                  : "inherit",
              );
              if (!selectedModel) continue;
              value = selectedModel === "inherit" ? undefined : selectedModel;
            } else if (action === "thinking") {
              field = "thinking";
              await ctx.modelRegistry.refresh();
              const configured =
                typeof valueAtScope("model") === "string"
                  ? (valueAtScope("model") as string)
                  : undefined;
              const model = configured ? this.resolveConfiguredModel(ctx, configured) : ctx.model;
              const levels = model
                ? getSupportedThinkingLevels(model)
                : [...host.validThinkingLevels];
              const configuredThinking =
                localValue("thinking") === false
                  ? "off"
                  : typeof localValue("thinking") === "string"
                    ? (localValue("thinking") as string)
                    : undefined;
              const thinkingItems = [
                { value: "inherit", label: "Remove local override" },
                ...levels.map((level: string) => ({
                  value: level,
                  label: level,
                })),
              ];
              if (configuredThinking && !levels.includes(configuredThinking))
                thinkingItems.push({
                  value: configuredThinking,
                  label: configuredThinking,
                });
              const selectedThinking = await host.selectMenu(
                ctx,
                "Thinking",
                thinkingItems,
                configuredThinking ?? "inherit",
              );
              if (!selectedThinking) continue;
              value = selectedThinking === "inherit" ? undefined : selectedThinking;
            } else if (action === "enabled") {
              field = "enabled";
              value = enabledAtScope === false;
            } else continue;
            const latest = await reloadDefinition(category, selectedName);
            if (
              !latest ||
              !definitionEditTargets(latest).some(
                (candidate) => candidate.scope === selectedScope && candidate.path === target.path,
              )
            ) {
              ctx.ui.notify(
                `The ${selectedScope} definition source changed; reopen the setting.`,
                "warning",
              );
              break;
            }
            const result = host.updateAgentOverride(latest, field, value, {
              scope: selectedScope,
              expectedContent: snapshotResult.snapshot.content,
            });
            const verified = await reloadDefinition(category, definition.name);
            if (!verified) throw new Error(`definition ${definition.name} is no longer available`);
            if (
              result.changed &&
              !definitionEditTargets(verified).some(
                (candidate) => candidate.scope === selectedScope && candidate.path === result.path,
              )
            )
              throw new Error(`agent ${definition.name} override verification failed`);
            const effectiveValue =
              field === "enabled"
                ? host.agentDefinitionEnabled(verified)
                : verified.frontmatter[field];
            ctx.ui.notify(
              result.changed
                ? `${value === undefined ? "Removed" : "Updated"} ${selectedScope} ${definition.name} ${field}${value === undefined ? " override" : ` to ${value}`}.${(value === undefined ? effectiveValue !== undefined : effectiveValue !== value) ? ` Effective here: ${effectiveValue ?? "inherited"}.` : ""}`
                : `${definition.name} ${field} is already inherited; no change made.`,
            );
            definition = verified;
          }
        }
        if (initialSection) return;
      }
    },
    async showSessionStats(ctx: ExtensionCommandContext): Promise<void> {
      const managerActive = host.roleActive("manager");
      const stats = host.collectOwnedSessionUsage(ctx);
      ctx.ui.notify(
        host.formatSessionUsage(
          stats.current,
          stats.agents,
          stats.agentSessions,
          stats.complete,
          stats.breakdown,
          managerActive
            ? {
                usage: stats.leads,
                sessions: stats.leadSessions,
              }
            : undefined,
        ),
      );
    },
    async confirmAndStopAll(ctx: ExtensionCommandContext): Promise<void> {
      const snapshot = await host.loadStatusSnapshot(ctx, host.controller.sessionSignal());
      if (!snapshot.agents.length) {
        await host.controller.withQuiescedTree(
          ctx,
          ctx.sessionManager.getSessionId(),
          host.controller.workspaceId(),
          async () => {
            const fresh = await host.controller.agentSnapshotView(
              ctx,
              { kind: "root" },
              host.controller.sessionSignal(),
            );
            if (fresh.stateIssues.length)
              throw new Error("Owned Agent mailbox state is unresolved; stop not verified");
            if (fresh.visible.length) {
              ctx.ui.notify("Agent state changed; reopen Stop all.", "warning");
              return;
            }
            host.presentStopSummary("No owned agents running.");
          },
          host.controller.sessionSignal(),
        );
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Stop all agents?",
        `${host.formatStatusCounts(snapshot.agents)}\n\nActive work or pending results may be discarded.`,
      );
      if (!confirmed) return;
      ctx.abort();
      const sessionId = ctx.sessionManager.getSessionId();
      const workspaceId = host.controller.workspaceId();
      await host.controller.withQuiescedTree(
        ctx,
        sessionId,
        workspaceId,
        async (heldLocks) => {
          const result = await host.controller.stopOwnedAgentsForSession(
            ctx,
            sessionId,
            workspaceId,
            host.controller.sessionSignal(),
            heldLocks,
          );
          let persisted = 0;
          try {
            persisted = await host.persistStopClosures(ctx, result.closures ?? []);
          } catch {
            // A verified stop does not imply that continuation proof was persisted.
          }
          const unavailable = (result.closures?.length ?? 0) - persisted;
          host.presentStopSummary(
            (result.closures?.length ?? 0) > 0
              ? `${result.summary}\nContinuity proof saved for ${persisted} stopped Agent${persisted === 1 ? "" : "s"}; unavailable for ${unavailable}. Agents without saved proof may not be continuable.`
              : result.summary,
          );
        },
        host.controller.sessionSignal(),
      );
      if (host.isLead()) host.maybeFinishHerdRun(ctx);
    },
    async openExecutionMenu(ctx: ExtensionCommandContext): Promise<void> {
      const execution = host.leadExecutionPresentation();
      if (execution.managed) {
        await host.selectMenu(ctx, "Managed orchestration", [
          {
            value: "managed",
            label: managedExecutionLabel(execution.lifecycle),
            help: "Dedicated Managed Lead. Use Pi /fork or /clone to continue independently; the Git checkout is shared.",
          },
        ]);
        return;
      }
      const mode = await host.selectMenu(
        ctx,
        "Lead mode",
        [
          {
            value: "flexible",
            label: "flexible",
            description:
              execution.mode === "flexible"
                ? execution.nativeOnly
                  ? "current · native tools only · delegation unavailable"
                  : "current"
                : undefined,
            help: execution.nativeOnly
              ? "The Flexible Lead profile could not be applied. Native Pi tools remain available, but new Agent delegation is unavailable. Repair the profile and run /lead-flexible to reapply it."
              : undefined,
          },
          {
            value: "orchestrate",
            label: "orchestrate",
            description: execution.mode === "orchestrate" ? "current" : undefined,
          },
        ],
        execution.mode,
      );
      if (mode === "flexible" || mode === "orchestrate") {
        try {
          await host.setLeadExecutionMode(ctx, mode);
        } catch (error) {
          ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
        }
      }
    },
    async openSettingsMenu(ctx: ExtensionCommandContext): Promise<void> {
      let selectedCategory = "sessions";
      while (true) {
        const category = await host.selectMenu(
          ctx,
          "Settings",
          [
            { value: "sessions", label: "Sessions & agents" },
            { value: "manager", label: "Manager & repositories" },
            { value: "interface", label: "Interface" },
            { value: "delegation", label: "Delegation options" },
            { value: "communication", label: "Communication" },
          ],
          selectedCategory,
        );
        if (!category) return;
        selectedCategory = category;
        await this.openSettingsCategory(ctx, category);
      }
    },
    async openSettingsCategory(ctx: ExtensionCommandContext, category: string): Promise<void> {
      let selectedSetting =
        category === "sessions"
          ? "default-lead-execution"
          : category === "manager"
            ? "auto-activate-manager"
            : category === "delegation"
              ? "max-agent-depth"
              : category === "communication"
                ? "peer-communication"
                : "agent-layout";
      const loadProjectState = () => {
        if (!ctx.isProjectTrusted()) return { trusted: false as const, overrides: {} };
        try {
          return {
            trusted: true as const,
            overrides: host.readProjectOverrides(ctx),
          };
        } catch (error) {
          return {
            trusted: true as const,
            error: String(error),
            overrides: {},
          };
        }
      };
      while (true) {
        const config = host.readConfig();
        const project = loadProjectState();
        let repository: Awaited<ReturnType<typeof host.getRemovalPreauthorization>> | undefined;
        if (category === "manager") {
          try {
            repository = await host.getRemovalPreauthorization(ctx);
          } catch {
            /* Repository settings remain unavailable. */
          }
        }
        const merge = repository ? effectiveMergePolicy(config, repository.repoKey) : undefined;
        let messageSummary: string | undefined;
        if (category === "sessions") {
          try {
            const limits = await host.messageLimits(ctx);
            messageSummary = `Files ${sizeLabel(limits.inline.bytes)} · Messages ${sizeLabel(limits.mailbox.bytes)}`;
          } catch {
            messageSummary = "Unavailable";
          }
        }
        const projectDescription = (key: "autoActivateManager" | "contextRetirement") => {
          if ("error" in project) return "Project unavailable";
          const overridden = project.trusted && Object.hasOwn(project.overrides, key);
          const enabled = overridden ? project.overrides[key] : config[key];
          return `${enabled ? "On" : "Off"} · ${overridden ? "Project" : "Global"}`;
        };
        const selected = await host.selectMenu(
          ctx,
          category === "sessions"
            ? "Sessions & agents"
            : category === "manager"
              ? "Manager & repositories"
              : category === "delegation"
                ? "Delegation options"
                : category === "communication"
                  ? "Communication"
                  : "Interface",
          [
            {
              value: "agent-layout",
              category: "interface",
              label: "Agent terminal layout",
              description:
                category === "interface"
                  ? layoutLabels[(await host.placementSettings(ctx)).effective]
                  : undefined,
              help: "Choose how directly delegated Agents appear in the terminal. Nested Agents still split within their owner's tab.",
            },
            {
              value: "default-lead-execution",
              category: "sessions",
              label: "Default Lead mode",
              description: leadModeLabels[config.defaultLeadExecution],
              help: "Mode used for new ordinary Lead sessions without a saved choice. Existing sessions keep their mode.",
            },
            {
              value: "auto-activate-manager",
              category: "manager",
              label: "Start Manager automatically",
              description: projectDescription("autoActivateManager"),
              help: "Try to start Manager when a new eligible session opens in a primary workspace. Does not change the current session or initialize Git.",
            },
            {
              value: "manager-git-bootstrap-confirmation",
              category: "manager",
              label: "Confirm Git initialization",
              description: config.managerGitBootstrapWithoutConfirmation ? "Skipped" : "Required",
              help: "Ask before initializing Git when Manager is started explicitly in a directory without a Git repository.",
            },
            {
              value: "context-retirement",
              category: "sessions",
              label: "Finish Agents near context limit",
              description: projectDescription("contextRetirement"),
              help: "Ask managed Agents to finish their assignments as context fills up, instead of compacting their sessions. Follow-up work needs a new Agent.",
            },
            {
              value: "manager-merge",
              category: "manager",
              label: "Merge accepted branches",
              description: merge ? mergeDescription(merge) : "Repository unavailable",
              help: "Control whether Manager can merge accepted local branches, using fast-forward only or conflict-free divergent merges.",
            },
            {
              value: "projects-directory",
              category: "manager",
              label: "Projects directory",
              description: config.projectsDirectory,
              help: "Set the global projects root for this Pi profile. Enter an absolute or ~/ path. Changing this setting does not move or create repositories.",
            },
            {
              value: "status-widget-rows",
              category: "interface",
              label: "Status widget lines",
              description: countLabel(config.statusWidgetMaxRows, "line"),
              help: "Maximum number of lines in the compact status display, including its header and overflow line.",
            },
            {
              value: "max-agent-depth",
              category: "delegation",
              label: "Agent nesting limit",
              description: countLabel(config.maxAgentDepth, "level"),
              help: "Maximum Agent levels below a Lead, Manager or Chief. 1 = no nested Agents; 2 = one nested level.",
            },
            {
              value: "message-limits",
              category: "sessions",
              label: "Message and file limits",
              description: messageSummary,
              help: "Set the maximum size of shared file contents and coordination messages.",
            },
            {
              value: "cwd-override",
              category: "delegation",
              label: "Delegate Agents to other directories (cwd)",
              description: config.allowAgentCwdOverride ? "On" : "Off",
              help: "Allow ordinary Leads to select another directory using `cwd` in `delegate_agent`. Without it, Agents use the Lead's directory. Global setting; changes apply to subsequent model turns without `/reload`.",
            },
            {
              value: "model-overrides",
              category: "delegation",
              label: "Agent model overrides",
              description: config.allowAgentModelOverrides ? "On" : "Off",
              help: "Allow authorized owners to choose a model or thinking level for one fresh Agent assignment.",
            },
            {
              value: "allowed-override-models",
              category: "delegation",
              label: overrideModelPickerTitle,
              description: config.allowedAgentModels.length
                ? `Custom selection · ${config.allowedAgentModels.length} selected`
                : "Using Pi scoped models",
              help: "Preview inherited Pi scoped models or save a custom selection. Use Pi scoped models to restore inheritance.",
            },
            {
              value: "removal-confirmation",
              category: "manager",
              label: "Confirm worktree removal",
              description: repository
                ? `${repository.enabled ? "Skipped" : "Required"} · Repository`
                : "Repository unavailable",
              help: "Require separate approval for explicit worktree removal. Other safety checks always apply.",
            },
            {
              value: "peer-communication",
              category: "communication",
              label: "Peer communication",
              description: config.peerCommunicationEnabled ? "On" : "Off",
              help: "Allow horizontal peer communication. Does not affect supervision or Agent delegation.",
            },
            {
              value: "peer-federation",
              category: "communication",
              label: "Peer federation",
              description: `${config.peerFederationEnabled ? "On" : "Off"}${config.peerCommunicationEnabled ? "" : " (inactive)"}`,
              help: "Allow communication with peers on other machines when peer communication is on.",
            },
          ]
            .filter((item) => item.category === category)
            .map(({ category: _category, ...item }) => item),
          selectedSetting,
        );
        if (!selected) return;
        selectedSetting = selected;
        if (selected === "agent-layout") {
          await this.openPlacementMenu(ctx);
        } else if (selected === "model-overrides") {
          const current = config.allowAgentModelOverrides ? "on" : "off";
          const choice = await host.selectMenu(
            ctx,
            "Agent model overrides",
            markCurrent(
              [
                { value: "off", label: "Off" },
                { value: "on", label: "On" },
              ],
              current,
            ),
            current,
          );
          if ((choice !== "on" && choice !== "off") || choice === current || ctx.signal?.aborted)
            continue;
          try {
            host.updateConfig("allowAgentModelOverrides", choice === "on");
            ctx.ui.notify(
              `Agent model overrides: ${choice === "on" ? "On" : "Off"}. Applies to subsequent delegations and model turns.`,
            );
          } catch (error) {
            ctx.ui.notify(`Could not update “Agent model overrides”: ${String(error)}`, "error");
          }
        } else if (selected === "allowed-override-models") {
          try {
            const models = await pickOverrideModels(
              ctx,
              config.allowedAgentModels,
              (title, items) => host.selectMenu(ctx, title, items),
            );
            if (models !== undefined && !ctx.signal?.aborted) {
              host.updateConfig("allowedAgentModels", models);
            }
          } catch (error) {
            ctx.ui.notify(
              `Could not update “${overrideModelPickerTitle}”: ${String(error)}`,
              "error",
            );
          }
        } else if (selected === "cwd-override") {
          const current = config.allowAgentCwdOverride ? "on" : "off";
          const choice = await host.selectMenu(
            ctx,
            "Delegate Agents to other directories (cwd)",
            markCurrent(
              [
                { value: "off", label: "Off" },
                { value: "on", label: "On" },
              ],
              current,
            ),
            current,
          );
          if ((choice !== "on" && choice !== "off") || choice === current || ctx.signal?.aborted)
            continue;
          try {
            host.updateConfig("allowAgentCwdOverride", choice === "on");
            ctx.ui.notify(
              `Delegate Agents to other directories (cwd): ${choice === "on" ? "On" : "Off"}. Applies to subsequent delegations and model turns.`,
            );
          } catch (error) {
            ctx.ui.notify(
              `Could not update “Delegate Agents to other directories (cwd)”: ${String(error)}`,
              "error",
            );
          }
        } else if (selected === "peer-communication" || selected === "peer-federation") {
          const federation = selected === "peer-federation";
          const key = federation ? "peerFederationEnabled" : "peerCommunicationEnabled";
          const inactiveMessage =
            "Peer federation is inactive while peer communication is off. Its saved setting is unchanged.";
          try {
            const current = host.readConfig();
            if (federation && !current.peerCommunicationEnabled) {
              ctx.ui.notify(inactiveMessage, "info");
              continue;
            }
            const currentChoice = current[key] ? "on" : "off";
            const choice = await host.selectMenu(
              ctx,
              federation ? "Peer federation" : "Peer communication",
              markCurrent(
                [
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ],
                currentChoice,
              ),
              currentChoice,
            );
            if ((choice !== "on" && choice !== "off") || ctx.signal?.aborted) continue;
            const latest = host.readConfig();
            if (federation && !latest.peerCommunicationEnabled) {
              ctx.ui.notify(inactiveMessage, "info");
              continue;
            }
            const enabled = choice === "on";
            if (enabled !== latest[key]) host.updateConfig(key, enabled);
          } catch (error) {
            ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
          }
        } else if (selected === "manager-git-bootstrap-confirmation") {
          const choice = await host.selectMenu(
            ctx,
            "Confirm Git initialization",
            markCurrent(
              [
                { value: "required", label: "Require confirmation" },
                {
                  value: "skip",
                  label: "Skip confirmation on explicit Manager start",
                },
              ],
              config.managerGitBootstrapWithoutConfirmation ? "skip" : "required",
            ),
            config.managerGitBootstrapWithoutConfirmation ? "skip" : "required",
          );
          if (choice && (choice === "skip") !== config.managerGitBootstrapWithoutConfirmation) {
            if (
              choice === "skip" &&
              !(await ctx.ui.confirm(
                "Skip Manager Git setup confirmation?",
                "Explicit Manager activation may initialize a non-Git workspace without asking again.",
                { signal: ctx.signal },
              ))
            )
              continue;
            if (ctx.signal?.aborted) continue;
            host.updateConfig("managerGitBootstrapWithoutConfirmation", choice === "skip");
            ctx.ui.notify(
              `Confirm Git initialization: ${choice === "skip" ? "Skipped" : "Required"}.`,
            );
          }
        } else if (selected === "status-widget-rows") {
          while (true) {
            const currentChoice =
              config.statusWidgetMaxRows === DEFAULT_STATUS_WIDGET_MAX_ROWS
                ? "default"
                : [3, 5, 8, 12, 20].includes(config.statusWidgetMaxRows)
                  ? String(config.statusWidgetMaxRows)
                  : "custom";
            const choice = await host.selectMenu(
              ctx,
              "Status widget lines",
              markCurrent(
                [
                  {
                    value: "default",
                    label: `Use default (${DEFAULT_STATUS_WIDGET_MAX_ROWS})`,
                  },
                  ...[3, 5, 8, 12, 20]
                    .filter((rows) => rows !== DEFAULT_STATUS_WIDGET_MAX_ROWS)
                    .map((rows) => ({
                      value: String(rows),
                      label: countLabel(rows, "line"),
                    })),
                  {
                    value: "custom",
                    label: "Custom…",
                    description:
                      currentChoice === "custom"
                        ? countLabel(config.statusWidgetMaxRows, "line")
                        : undefined,
                  },
                ],
                currentChoice,
              ),
              currentChoice,
            );
            if (!choice) break;
            let value: number | undefined;
            if (choice === "default") value = undefined;
            else if (choice === "custom") {
              const input = await host.input(ctx, "Custom status widget lines (1–100)");
              if (input === undefined) continue;
              value = Number(input.trim());
              if (!/^\d+$/u.test(input.trim()) || !host.validStatusWidgetMaxRows(value)) {
                ctx.ui.notify("Enter an integer from 1 through 100", "error");
                continue;
              }
            } else value = Number(choice);
            if (value !== undefined && value === config.statusWidgetMaxRows) break;
            try {
              host.updateConfig("statusWidgetMaxRows", value);
              ctx.ui.notify(
                `Status widget lines: ${value === undefined ? "default restored" : countLabel(value, "line")}`,
              );
              break;
            } catch (error) {
              ctx.ui.notify(`Could not update Status widget lines: ${String(error)}`, "error");
            }
          }
        } else if (selected === "max-agent-depth") {
          while (true) {
            const currentChoice =
              config.maxAgentDepth === DEFAULT_MAX_AGENT_DEPTH
                ? "default"
                : [1, 2, 3, 4, 5].includes(config.maxAgentDepth)
                  ? String(config.maxAgentDepth)
                  : "custom";
            const choice = await host.selectMenu(
              ctx,
              "Agent nesting limit",
              markCurrent(
                [
                  {
                    value: "default",
                    label: `Use default (${DEFAULT_MAX_AGENT_DEPTH})`,
                  },
                  ...[1, 2, 3, 4, 5]
                    .filter((depth) => depth !== DEFAULT_MAX_AGENT_DEPTH)
                    .map((depth) => ({
                      value: String(depth),
                      label: countLabel(depth, "level"),
                    })),
                  {
                    value: "custom",
                    label: "Custom…",
                    description:
                      currentChoice === "custom"
                        ? countLabel(config.maxAgentDepth, "level")
                        : undefined,
                  },
                ],
                currentChoice,
              ),
              currentChoice,
            );
            if (!choice) break;
            let value: number | undefined;
            if (choice === "default") value = undefined;
            else if (choice === "custom") {
              const input = await host.input(ctx, "Custom Agent nesting limit (positive integer)");
              if (input === undefined) continue;
              value = Number(input.trim());
              if (!/^\d+$/u.test(input.trim()) || !host.validMaxAgentDepth(value)) {
                ctx.ui.notify("Enter a positive integer", "error");
                continue;
              }
            } else value = Number(choice);
            if (value !== undefined && value === config.maxAgentDepth) break;
            try {
              host.updateConfig("maxAgentDepth", value);
              ctx.ui.notify(
                `Agent nesting limit: ${value === undefined ? "default restored" : countLabel(value, "level")}`,
              );
              break;
            } catch (error) {
              ctx.ui.notify(`Could not update Agent nesting limit: ${String(error)}`, "error");
            }
          }
        } else if (selected === "message-limits") await this.openMessageLimitsMenu(ctx);
        else if (selected === "default-lead-execution") {
          const mode = await host.selectMenu(
            ctx,
            "Default Lead mode",
            markCurrent(
              [
                {
                  value: "flexible",
                  label: leadModeLabels.flexible,
                  help: "Work directly or delegate tasks when useful.",
                },
                {
                  value: "orchestrate",
                  label: leadModeLabels.orchestrate,
                  help: "Delegate execution work and focus on coordination and review.",
                },
              ],
              config.defaultLeadExecution,
            ),
            config.defaultLeadExecution,
          );
          if (mode && isLeadExecutionMode(mode) && mode !== config.defaultLeadExecution) {
            host.updateConfig("defaultLeadExecution", mode);
            ctx.ui.notify(`Default Lead mode: ${leadModeLabels[mode]}`);
          }
        } else if (selected === "context-retirement" || selected === "auto-activate-manager") {
          await this.openProjectSetting(
            ctx,
            selected === "context-retirement" ? "contextRetirement" : "autoActivateManager",
          );
        } else if (selected === "projects-directory") {
          const defaultPath = DEFAULT_CONFIG.projectsDirectory;
          const input = await host.input(ctx, `Projects directory (default: ${defaultPath})`);
          if (input === undefined || ctx.signal?.aborted) continue;
          try {
            host.updateConfig("projectsDirectory", input === defaultPath ? undefined : input);
          } catch (error) {
            ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
          }
        } else if (selected === "manager-merge") {
          await this.openMergeSetting(ctx);
        } else if (selected === "removal-confirmation") {
          await this.openRemovalSetting(ctx);
        }
      }
    },
    async openProjectSetting(
      ctx: ExtensionCommandContext,
      key: "autoActivateManager" | "contextRetirement",
    ): Promise<void> {
      const title =
        key === "autoActivateManager"
          ? "Start Manager automatically"
          : "Finish Agents near context limit";
      let selectedScope = "global";
      while (true) {
        const global = host.readConfig()[key];
        let overrides: ReturnType<typeof host.readProjectOverrides> | undefined;
        let unavailable: string | undefined;
        if (!ctx.isProjectTrusted()) unavailable = "Project is not trusted";
        else
          try {
            overrides = host.readProjectOverrides(ctx);
          } catch (error) {
            unavailable = `Project settings unavailable: ${String(error).replace(/^Error: /, "")}`;
          }
        const projectValue =
          overrides && Object.hasOwn(overrides, key) ? overrides[key] : undefined;
        const scope = await host.selectMenu(
          ctx,
          title,
          [
            {
              value: "global",
              label: "Global default",
              description: global ? "On" : "Off",
            },
            {
              value: "project",
              label: "Current project",
              description:
                unavailable ??
                (projectValue === undefined
                  ? `Use global setting (${global ? "On" : "Off"})`
                  : projectValue
                    ? "On"
                    : "Off"),
            },
          ],
          selectedScope,
        );
        if (!scope) return;
        selectedScope = scope;
        if (scope === "project" && unavailable) {
          ctx.ui.notify(unavailable, "warning");
          continue;
        }
        const currentChoice =
          scope === "global"
            ? global
              ? "on"
              : "off"
            : projectValue === undefined
              ? "inherit"
              : projectValue
                ? "on"
                : "off";
        const choice = await host.selectMenu(
          ctx,
          `${scope === "global" ? "Global" : "Project"} · ${title}`,
          markCurrent(
            [
              ...(scope === "project"
                ? [
                    {
                      value: "inherit",
                      label: `Use global setting (${global ? "On" : "Off"})`,
                    },
                  ]
                : []),
              { value: "on", label: "On" },
              { value: "off", label: "Off" },
            ],
            currentChoice,
          ),
          currentChoice,
        );
        if (!choice) continue;
        const value = choice === "inherit" ? undefined : choice === "on";
        try {
          if (scope === "global") {
            if (value === global || value === undefined) continue;
            host.updateConfig(key, value);
          } else {
            if (value === projectValue) continue;
            host.updateProjectOverride(ctx, key, value);
          }
          ctx.ui.notify(
            `${title}: ${value === undefined ? "Uses global setting" : value ? "On" : "Off"} (${scope}).`,
          );
        } catch (error) {
          ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
        }
      }
    },
    async openMergeSetting(ctx: ExtensionCommandContext): Promise<void> {
      let selectedScope = "global";
      while (true) {
        const config = host.readConfig();
        const global = config.managerMergeEnabled;
        let policy: Awaited<ReturnType<typeof host.getRemovalPreauthorization>> | undefined;
        let unavailable = "";
        try {
          policy = await host.getRemovalPreauthorization(ctx);
        } catch (error) {
          unavailable = String(error).replace(/^Error: /, "");
        }
        const repositoryPolicy = policy ? effectiveMergePolicy(config, policy.repoKey) : undefined;
        const label = (value: false | true | "divergent") =>
          value === false ? "Off" : value === true ? "Fast-forward" : "Conflict-free merges";
        const scope = await host.selectMenu(
          ctx,
          "Merge accepted branches",
          [
            {
              value: "global",
              label: "Global default",
              description: label(global),
            },
            {
              value: "repository",
              label: "Current repository",
              description: repositoryPolicy ? mergeDescription(repositoryPolicy) : "Unavailable",
            },
          ],
          selectedScope,
        );
        if (!scope) return;
        selectedScope = scope;
        if (scope === "repository") {
          if (!policy || !repositoryPolicy) {
            ctx.ui.notify(`Repository unavailable: ${unavailable}`, "warning");
            continue;
          }
          const override = config.managerMergeOverrides[policy.repoKey];
          const currentChoice =
            override === undefined
              ? "inherit"
              : override === false
                ? "off"
                : override === true
                  ? "fast-forward"
                  : "divergent";
          const choice = await host.selectMenu(
            ctx,
            `Repository · Merge accepted branches · ${policy.repoKey}`,
            markCurrent(
              [
                {
                  value: "inherit",
                  label: `Use global setting (${label(global)})`,
                },
                { value: "off", label: "Off" },
                { value: "fast-forward", label: "Fast-forward only" },
                { value: "divergent", label: "Conflict-free merges" },
              ],
              currentChoice,
            ),
            currentChoice,
          );
          if (!choice) continue;
          const value =
            choice === "inherit"
              ? undefined
              : choice === "off"
                ? false
                : choice === "fast-forward"
                  ? true
                  : "divergent";
          if (value === override) continue;
          try {
            const stored = await host.setRepositoryMergeOverride(value, ctx, policy.identity, {
              global,
              override,
            });
            if (stored)
              ctx.ui.notify(
                `Merge accepted branches: ${value === undefined ? "Uses global setting" : label(value)} (${policy.repoKey}).`,
              );
          } catch (error) {
            ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
          }
          continue;
        }
        const current = host.readConfig().managerMergeEnabled;
        const currentChoice =
          current === false ? "off" : current === true ? "fast-forward" : "divergent";
        const choice = await host.selectMenu(
          ctx,
          "Global · Merge accepted branches",
          markCurrent(
            [
              { value: "off", label: "Off" },
              { value: "fast-forward", label: "Fast-forward only" },
              { value: "divergent", label: "Conflict-free merges" },
            ],
            currentChoice,
          ),
          currentChoice,
        );
        if (!choice) continue;
        const setting = choice === "off" ? false : choice === "fast-forward" ? true : "divergent";
        if (setting === current) continue;
        if (
          setting !== false &&
          (current === false || (setting === "divergent" && current !== "divergent"))
        ) {
          if (!(await confirmMergeGrant(ctx, setting, "global settings")) || ctx.signal?.aborted)
            continue;
        }
        if (ctx.signal?.aborted) continue;
        if (host.readConfig().managerMergeEnabled !== current) {
          ctx.ui.notify(
            "Global Manager integration policy changed; reopen the selector.",
            "warning",
          );
          continue;
        }
        try {
          host.updateConfig("managerMergeEnabled", setting, current);
        } catch (error) {
          ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
          continue;
        }
        ctx.ui.notify(`Merge accepted branches: ${label(setting)} (global).`);
      }
    },
    async openRemovalSetting(ctx: ExtensionCommandContext): Promise<void> {
      try {
        const policy = await host.getRemovalPreauthorization(ctx);
        const choice = await host.selectMenu(
          ctx,
          `Repository · Confirm worktree removal · ${policy.repoKey}`,
          markCurrent(
            [
              { value: "required", label: "Require approval for each removal" },
              {
                value: "skip",
                label: "Allow explicit removals without individual approval",
              },
            ],
            policy.enabled ? "skip" : "required",
          ),
          policy.enabled ? "skip" : "required",
        );
        if (!choice || (choice === "skip") === policy.enabled) return;
        const stored = await host.setRemovalPreauthorization(
          choice === "skip",
          ctx,
          policy.identity,
        );
        if (stored)
          ctx.ui.notify(
            `Confirm worktree removal: ${choice === "skip" ? "Skipped" : "Required"} (${policy.repoKey}).`,
          );
      } catch (error) {
        ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
      }
    },
    async openAgentsMenu(ctx: ExtensionCommandContext): Promise<void> {
      let selectedSection = "agent-definitions";
      while (!ctx.signal?.aborted) {
        const selected = await host.selectMenu(
          ctx,
          "Agents & definitions",
          [
            { value: "agent-definitions", label: "Agent definitions" },
            { value: "coordinator-profiles", label: "Coordinator profiles" },
            {
              value: "stop-all",
              label: "Stop all agents…",
              help: "Emergency stop for the owned Agent tree. Active work or pending results may be discarded.",
            },
          ],
          selectedSection,
        );
        if (!selected) return;
        selectedSection = selected;
        if (selected === "agent-definitions") await this.openDefinitionsMenu(ctx, "agents");
        else if (selected === "coordinator-profiles") await this.openDefinitionsMenu(ctx, "roles");
        else if (selected === "stop-all") await this.confirmAndStopAll(ctx);
      }
    },
    async openHerdsmanMenu(ctx: ExtensionCommandContext): Promise<void> {
      let selectedSection = "execution";
      while (true) {
        const execution = host.leadExecutionPresentation();
        const showLeadMode = host.isLead() && !execution.managed;
        if (!showLeadMode && selectedSection === "execution") selectedSection = "agents";
        const selected = await host.selectMenu(
          ctx,
          `Pi Herdsman · ${formatRuntimeBuild(host.build)}`,
          [
            ...(showLeadMode
              ? [
                  {
                    value: "execution",
                    label: "Lead mode",
                    description: execution.nativeOnly
                      ? `${execution.mode} · native tools only`
                      : execution.mode,
                    help: execution.nativeOnly
                      ? "The Flexible Lead profile could not be applied. Native Pi tools remain available, but new Agent delegation is unavailable. Repair the profile and run /lead-flexible to reapply it."
                      : "Choose whether this Lead works directly or primarily delegates tasks.",
                  },
                ]
              : []),
            {
              value: "agents",
              label: "Agents & definitions",
              help: "Configure Agent definitions and Coordinator profiles, or stop owned Agents in an emergency.",
            },
            {
              value: "manager",
              label: "Project management",
              description: host.roleActive("manager") ? "Active" : "Inactive",
              help: "Coordinate independent project work across Git branches.",
            },
            {
              value: "chief",
              label: "Chief coordination",
              description: host.roleActive("chief") ? "Active" : "Inactive",
              help: "Supervise Managers and unassigned Leads across Herdsman.",
            },
            {
              value: "settings",
              label: "Settings",
              help: "Change Herdsman preferences.",
            },
            {
              value: "stats",
              label: "Usage & costs",
              help: "View token usage and model costs for this session and its managed work.",
            },
          ],
          selectedSection,
        );
        if (!selected) return;
        selectedSection = selected;
        if (selected === "execution") await this.openExecutionMenu(ctx);
        else if (selected === "agents") await this.openAgentsMenu(ctx);
        else if (selected === "manager") await this.openRoleMenu("manager", ctx);
        else if (selected === "stats") await this.showSessionStats(ctx);
        else if (selected === "settings") await this.openSettingsMenu(ctx);
        else if (selected === "chief") await this.openRoleMenu("chief", ctx);
      }
    },
    async openRoleMenu(role: "manager" | "chief", ctx: ExtensionCommandContext): Promise<void> {
      const name = role === "manager" ? "Manager" : "Chief";
      const title = role === "manager" ? "Project management" : "Chief mode";
      let selectedAction: string | undefined;
      while (true) {
        const active = host.roleActive(role);
        const selected = await host.selectMenu(
          ctx,
          title,
          active
            ? [
                {
                  value: "overview",
                  label: role === "manager" ? "Project overview" : "Overview",
                },
                ...(role === "manager"
                  ? [
                      {
                        value: "pending-removals",
                        label: "Pending removal requests",
                      },
                    ]
                  : []),
                {
                  value: "refresh",
                  label: role === "manager" ? "Refresh Manager profile" : "Refresh profile",
                  help: "Apply definition changes after the current turn becomes idle.",
                },
                { value: "leave", label: `Leave ${name} mode` },
              ]
            : [{ value: "start", label: `Start ${name} mode` }],
          selectedAction,
        );
        if (!selected) return;
        selectedAction = selected;
        if (selected === "overview" || selected === "start")
          await this.runRoleCommand(role, "open", ctx);
        else if (selected === "pending-removals") await host.reviewPendingRemoval(ctx);
        else if (selected === "refresh") await this.runRoleCommand(role, "refresh", ctx);
        else if (selected === "leave") await this.runRoleCommand(role, "leave", ctx);
      }
    },
    async runRoleCommand(
      role: "manager" | "chief",
      action: "open" | "refresh" | "leave",
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      try {
        if (action === "open" && host.roleActive(role)) {
          await host.openSupervisionOverview(ctx);
          return;
        }
        if (action === "refresh" && !host.roleActive(role)) {
          ctx.ui.notify(`/${role}-refresh requires active ${role} mode`, "error");
          return;
        }
        ctx.ui.notify(await host.transitionRole(role, action === "leave", ctx));
      } catch (error) {
        ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
      }
    },
    async setPlacement(placement: SpawnPlacement, ctx: ExtensionCommandContext): Promise<void> {
      host.updateConfig("spawnPlacement", placement);
      const verified = await host.placementSettings(ctx);
      if (verified.effective !== placement)
        throw new Error(`Agent placement did not become effective: ${verified.effective}`);
      ctx.ui.notify(`placement: ${verified.effective}`);
    },
    async setLeadMode(mode: LeadExecutionMode, ctx: ExtensionCommandContext): Promise<void> {
      try {
        await host.setLeadExecutionMode(ctx, mode);
        ctx.ui.notify(`Lead execution: ${mode}`);
      } catch (error) {
        ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
      }
    },
  };
}
