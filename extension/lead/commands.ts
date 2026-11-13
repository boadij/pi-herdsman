import type {
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import {
  getSupportedThinkingLevels,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import type { SelectItem } from "@earendil-works/pi-tui";
import {
  DEFAULT_MAX_AGENT_DEPTH,
  DEFAULT_STATUS_WIDGET_MAX_ROWS,
  effectiveMergePolicy,
  setManagerMergeOverride,
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
  isReservedRoleDefinition,
  isRuntimeRoleDefinition,
  MANAGED_LEAD_DEFINITION_NAME,
  type AgentDefinition,
  type DefinitionEditScope,
  type RoleDefinitionName,
} from "../agent-definitions.ts";
import { isLeadExecutionMode, type LeadExecutionMode } from "../core.ts";
import {
  compactModelToken,
  managedExecutionLabel,
  summarizeDefinitionLayerChanges,
  type StatusSnapshot,
  type buildStatusRows,
  type renderRunningOptions,
  type formatStatusCounts,
} from "../presentation.ts";

type LeadCommandHost = {
  pi: import("@earendil-works/pi-coding-agent").ExtensionAPI;
  persistStopClosures(
    ctx: ExtensionContext,
    closures: NonNullable<
      import("../agent-controller.ts").StopOwnedAgentsResult["closures"]
    >,
  ): Promise<number>;
  collectOwnedSessionUsage(
    ctx: ExtensionContext,
    managedLeads?: readonly { id: string; piSessionFile?: string }[],
  ): ReturnType<typeof import("../agent-controller.ts").collectSessionUsage>;
  formatSessionUsage: typeof import("../presentation.ts").formatSessionUsage;
  runHerdr: typeof import("../herdr.ts").runHerdr;
  presentStopSummary(summary: string): void;
  version: string;
  selectMenu(
    ctx: ExtensionContext,
    title: string,
    items: readonly (SelectItem & { help?: string })[],
    selectedValue?: string,
  ): Promise<string | undefined>;
  updateConfig(key: string, value: unknown): void;
  readConfig: typeof import("../config.ts").readConfig;
  readEffectiveConfig: typeof import("../config.ts").readEffectiveConfig;
  readProjectOverrides: typeof import("../config.ts").readProjectOverrides;
  updateProjectOverride: typeof import("../config.ts").updateProjectOverride;
  getRemovalPreauthorization(ctx: ExtensionContext): Promise<{
    repoKey: string;
    enabled: boolean;
  }>;
  setRemovalPreauthorization(
    enabled: boolean,
    ctx: ExtensionContext,
  ): Promise<boolean>;
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
    options:
      | import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions
      | undefined,
    body: string,
  ): string;
  chiefGlobalInstructions(
    options:
      | import("@earendil-works/pi-coding-agent").BuildSystemPromptOptions
      | undefined,
  ): Array<{ path: string; content: string }>;
  roleCharter(ctx: ExtensionContext): string;
  isCurrentChief(ctx: ExtensionContext): boolean;
  supervisoryProfileBody(
    ctx: ExtensionContext,
    role: "manager" | "chief",
  ): string;
  executionPrompt(): string | undefined;
  leadExecutionDefinition(): AgentDefinition | undefined;
  discoverRoleDefinition(
    name: RoleDefinitionName,
    options?: {
      projectRoot?: string;
      onWarning?: (message: string) => void;
    },
  ): AgentDefinition;
  inspectAgentDefinition(
    name: string,
    options?: { projectRoot?: string; onWarning?: (message: string) => void },
  ): DefinitionInspection;
  inspectRoleDefinition(
    name: RoleDefinitionName,
    options?: { projectRoot?: string; onWarning?: (message: string) => void },
  ): DefinitionInspection;
  expandDefinitionBodyFragments: typeof expandDefinitionBodyFragments;
  expandDefinitionBodyFragmentsWithSources?: typeof expandDefinitionBodyFragmentsWithSources;
  expandAgentBodyFiles: typeof import("../agent-definitions.ts").expandAgentBodyFiles;
  selectedAgentContextFiles: typeof selectedAgentContextFiles;
  setLeadExecutionMode(
    ctx: ExtensionCommandContext,
    mode: LeadExecutionMode,
  ): Promise<void>;
  leadExecutionPresentation(): {
    managed: boolean;
    mode: LeadExecutionMode;
    lifecycle?: "assigned" | "unavailable" | "retired";
  };
  agentDefinitionEnabled(definition: AgentDefinition): boolean;
  agentDefinitionMetadata(definition: AgentDefinition): Record<string, unknown>;
  showDefinitionDetails(
    ctx: ExtensionContext,
    title: string,
    lines: readonly string[],
  ): Promise<void>;
  formatAgentDefinitions(
    definitions: readonly Record<string, unknown>[],
  ): string[];
  validThinkingLevels: readonly string[];
  updateAgentOverride(
    definition: AgentDefinition,
    field: string,
    value: unknown,
    options?: { scope?: DefinitionEditScope; expectedContent?: string | null },
  ): { changed: boolean; path?: string };
  placementSettings(ctx: ExtensionContext): Promise<{ effective: string }>;
  updateSpawnPlacement(placement: string): void;
  messageLimits(
    ctx: ExtensionContext,
  ): Promise<{ inline: { bytes: number }; mailbox: { bytes: number } }>;
  formatMessageLimit(bytes: number): string;
  validByteLimit(bytes: number): boolean;
  validStatusWidgetMaxRows: typeof import("../config.ts").validStatusWidgetMaxRows;
  validMaxAgentDepth: typeof import("../config.ts").validMaxAgentDepth;
  input(
    ctx: ExtensionCommandContext,
    label: string,
  ): Promise<string | undefined>;
  updateMessageLimit(key: string, value: number | undefined): void;
  isSpawnPlacement(value: string): boolean;
  isLead(): boolean;
  buildStatusRows: typeof buildStatusRows;
  renderRunningOptions: typeof renderRunningOptions;
  formatStatusCounts: typeof formatStatusCounts;
  openSupervisionOverview(ctx: ExtensionCommandContext): Promise<void>;
  controller: ReturnType<
    typeof import("../agent-controller.ts").createAgentController
  >;
  loadStatusSnapshot(
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<StatusSnapshot>;
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
  | "buildStatusRows"
  | "renderRunningOptions"
  | "formatStatusCounts"
  | "openSupervisionOverview"
  | "controller"
  | "loadStatusSnapshot"
  | "roleActive"
  | "transitionRole"
  | "maybeFinishHerdRun"
  | "getThinkingLevel"
>;

export function createLeadCommandRuntime(host: LeadCommandHost) {
  const modelToken = (model: { provider: string; id: string }): string =>
    `${model.provider}/${model.id}`;
  return {
    async openPlacementMenu(ctx: ExtensionCommandContext): Promise<void> {
      const current = await host.placementSettings(ctx);
      const selected = await host.selectMenu(
        ctx,
        "Layout",
        [
          {
            value: "tab",
            label: "Lead agents tab",
            description: current.effective === "tab" ? "current" : undefined,
            help: "Place Lead-direct Agents in one lead-owned agents tab.",
          },
          {
            value: "subtree",
            label: "Subtree tabs",
            description:
              current.effective === "subtree" ? "current" : undefined,
            help: "Give each Lead-direct Agent its own tab. Nested delegation still splits in its owner's current tab.",
          },
          {
            value: "split",
            label: "Split from caller",
            description: current.effective === "split" ? "current" : undefined,
            help: "Split Lead-direct Agents from the caller's pane. Nested delegation still splits in its owner's current tab.",
          },
        ],
        current.effective,
      );
      if (!selected) return;
      host.updateSpawnPlacement(selected);
      const verified = await host.placementSettings(ctx);
      if (verified.effective !== selected)
        throw new Error(
          `Agent placement did not become effective: ${verified.effective}`,
        );
      ctx.ui.notify(`placement: ${verified.effective}`);
    },
    async openMessageLimitsMenu(ctx: ExtensionCommandContext): Promise<void> {
      let selectedLimit = "inlineAttachmentLimitBytes";
      const presets = [1, 4, 16, 64, 128].map((kib) => ({
        label: host.formatMessageLimit(kib * 1024),
        bytes: kib * 1024,
      }));
      while (true) {
        const limits = await host.messageLimits(ctx);
        const setting = await host.selectMenu(
          ctx,
          "Message limits",
          [
            {
              value: "inlineAttachmentLimitBytes",
              label: "Inline attachments",
              description: host.formatMessageLimit(limits.inline.bytes),
              help: "Per-file limit for embedding complete strict UTF-8 file contents. Larger or ineligible files remain references.",
            },
            {
              value: "mailboxPayloadLimitBytes",
              label: "Mailbox payload",
              description: host.formatMessageLimit(limits.mailbox.bytes),
              help: "Limit new managed-Agent request and ask payloads and new Manager project assignments.",
            },
          ],
          selectedLimit,
        );
        if (!setting) return;
        selectedLimit = setting;
        const choice = await host.selectMenu(ctx, "Limit", [
          ...presets.map(({ label, bytes }: any) => ({
            value: String(bytes),
            label,
          })),
          {
            value: "custom",
            label: "Custom…",
            help: "Enter a custom limit in KiB, from 1 through 1024.",
          },
          {
            value: "reset",
            label: "Reset",
            help: "Remove the configured override and use the default.",
          },
        ]);
        if (!choice) continue;
        let value: number | undefined;
        if (choice === "reset") value = undefined;
        else if (choice === "custom") {
          const input = await host.input(ctx, "Custom limit in KiB (1–1024)");
          if (input === undefined) continue;
          const kib = Number(input);
          if (
            !/^\d+$/u.test(input.trim()) ||
            !host.validByteLimit(kib * 1024)
          ) {
            ctx.ui.notify("Enter an integer from 1 through 1024 KiB", "error");
            continue;
          }
          value = kib * 1024;
        } else value = Number(choice);
        host.updateMessageLimit(selectedLimit, value);
        ctx.ui.notify(
          `${selectedLimit}: ${value === undefined ? "reset" : host.formatMessageLimit(value)}`,
        );
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
    resolveConfiguredModel(
      ctx: ExtensionContext,
      configured: string,
    ): Model<Api> | undefined {
      const models = ctx.modelRegistry.getAll();
      const canonical = models.find(
        (candidate: Model<Api>) => modelToken(candidate) === configured,
      );
      if (canonical) return canonical;
      const compactMatches = models.filter(
        (candidate: Model<Api>) =>
          compactModelToken(modelToken(candidate)) === configured,
      );
      return compactMatches.length === 1 ? compactMatches[0] : undefined;
    },
    async openDefinitionsMenu(ctx: ExtensionCommandContext): Promise<void> {
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
              ...(includeProject && ctx.isProjectTrusted()
                ? { projectRoot: ctx.cwd }
                : {}),
              onWarning: (message) => {
                notifyDefinitionWarning(ctx, message);
                onWarning?.(message);
              },
            });
      const resolveDefinition = async (name: string) => {
        const loaded = await loadDefinitions(
          isReservedRoleDefinition(name) ? "roles" : "agents",
        );
        return loaded.find((candidate) => candidate.name === name);
      };
      while (true) {
        const section = await host.selectMenu(
          ctx,
          "Agents & Coordinators",
          [
            {
              value: "agents",
              label: "Agents",
              help: "Definitions available for Agent delegation.",
            },
            {
              value: "roles",
              label: "Coordinators",
              help:
                "Profiles for existing Lead, Manager, and Chief roles; " +
                "these do not grant authority.",
            },
          ],
          selectedSection,
        );
        if (section !== "agents" && section !== "roles") return;
        selectedSection = section;
        definitionList: while (true) {
          const warnings: string[] = [];
          const availableDefinitions = await loadDefinitions(
            section,
            true,
            (message) => warnings.push(message),
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
            const reservedLead = isReservedRoleDefinition(definition.name);
            const runtimeProfile = isRuntimeRoleDefinition(definition.name);
            const description = [
              ...(!runtimeProfile ? [model, thinking] : []),
              sources,
              ...(!reservedLead && !host.agentDefinitionEnabled(definition)
                ? ["disabled"]
                : []),
            ]
              .filter(Boolean)
              .join(" · ");
            return {
              value: definition.name,
              label: definition.name,
              description,
              ...(typeof definition.frontmatter.description === "string"
                ? { help: definition.frontmatter.description }
                : {}),
            };
          });
          let warningValue = "__definition_warnings__";
          while (availableDefinitions.some(({ name }) => name === warningValue))
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
            (definition) => definition.name === selected,
          );
          if (!selectedEntry) continue;
          selectedDefinitions[section] = selectedEntry.name;
          let definition = selectedEntry;
          const selectedName = definition.name;
          let selectedScope =
            definitionEditTargets(definition)[0]?.scope ?? "global";
          let selectedAction = "model";
          while (true) {
            const targets = definitionEditTargets(definition);
            if (
              !targets.some((candidate) => candidate.scope === selectedScope)
            ) {
              ctx.ui.notify(
                `The ${selectedScope} definition source is no longer available.`,
                "warning",
              );
              break;
            }
            const target = targets.find(
              (candidate) => candidate.scope === selectedScope,
            )!;
            const snapshotResult = (() => {
              try {
                return {
                  snapshot: readDefinitionEditSnapshot(definition, target),
                };
              } catch (error) {
                return { error };
              }
            })();
            const snapshot =
              "snapshot" in snapshotResult
                ? snapshotResult.snapshot
                : undefined;
            const snapshotError =
              "error" in snapshotResult ? snapshotResult.error : undefined;
            const globalDefinition = isReservedRoleDefinition(definition.name)
              ? (await loadDefinitions("roles", false)).find(
                  (candidate) => candidate.name === definition.name,
                )
              : discoverGlobalAgentDefinition(definition.name);
            const projectSnapshot =
              selectedScope === "project" ? snapshot : undefined;
            const valueAtScope = (field: "model" | "thinking" | "enabled") =>
              selectedScope === "private"
                ? definition.frontmatter[field]
                : selectedScope === "project"
                  ? (projectSnapshot?.frontmatter[field] ??
                    globalDefinition?.frontmatter[field])
                  : globalDefinition?.frontmatter[field];
            const effectiveHere = (field: "model" | "thinking" | "enabled") =>
              field === "enabled"
                ? host.agentDefinitionEnabled(definition)
                : definition.frontmatter[field];
            const enabledAtScope = valueAtScope("enabled") ?? true;
            const scopeLabel =
              selectedScope === "private" ? "private repo" : selectedScope;
            const thinkingValue = (value: unknown) =>
              value === false
                ? "off"
                : typeof value === "string"
                  ? value
                  : "inherit";
            const localValue = (field: "model" | "thinking" | "enabled") =>
              snapshot ? snapshot.frontmatter[field] : undefined;
            const localValueLabel = (
              field: "model" | "thinking" | "enabled",
            ) =>
              snapshotError
                ? "unavailable"
                : typeof localValue(field) === "string" ||
                    typeof localValue(field) === "boolean"
                  ? String(localValue(field))
                  : "inherit";
            const managedDefinition =
              definition.name === MANAGED_LEAD_DEFINITION_NAME;
            const runtimeProfile = isRuntimeRoleDefinition(definition.name);
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
                ...(!runtimeProfile
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
                ...(!runtimeProfile
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
                ...(!isReservedRoleDefinition(definition.name)
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
                      : candidate.scope[0].toUpperCase() +
                        candidate.scope.slice(1),
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
              if (
                chosen === "private" ||
                chosen === "project" ||
                chosen === "global"
              )
                selectedScope = chosen;
              continue;
            }
            if (action === "details") {
              let current;
              try {
                current = await resolveDefinition(selectedName);
              } catch (error) {
                ctx.ui.notify(String(error), "error");
                break;
              }
              if (!current) {
                ctx.ui.notify(
                  `Definition ${selectedName} is no longer available.`,
                  "warning",
                );
                break;
              }
              definition = current;
              const metadata = host.agentDefinitionMetadata(current);
              if (ctx.mode === "tui") {
                try {
                  const promptOptions = isReservedRoleDefinition(current.name)
                    ? host.getSystemPromptOptions(ctx)
                    : undefined;
                  const inspection = isReservedRoleDefinition(current.name)
                    ? host.inspectRoleDefinition(
                        current.name as RoleDefinitionName,
                        ctx.isProjectTrusted() ? { projectRoot: ctx.cwd } : {},
                      )
                    : host.inspectAgentDefinition(
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
                  const roleProfile = isReservedRoleDefinition(current.name);
                  const execution = host.leadExecutionPresentation();
                  const managedLeadProfile = current.name === "managed-lead";
                  let activeRole =
                    (current.name === "manager" &&
                      host.roleActive("manager")) ||
                    (current.name === "chief" && host.isCurrentChief(ctx)) ||
                    (managedLeadProfile && execution.managed) ||
                    (current.name === "flexible-lead" &&
                      !execution.managed &&
                      execution.mode === "flexible" &&
                      !host.roleActive("manager") &&
                      !host.roleActive("chief")) ||
                    (current.name === "orchestrator-lead" &&
                      !execution.managed &&
                      execution.mode === "orchestrate" &&
                      !host.roleActive("manager") &&
                      !host.roleActive("chief"));
                  const activeChief = current.name === "chief" && activeRole;
                  const currentRoleCharter =
                    activeRole && current.name !== "chief"
                      ? host.roleCharter(ctx)
                      : undefined;
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
                    !roleProfile || managedLeadProfile
                      ? contextInheritance(current)
                      : undefined;
                  const roleContextFiles =
                    activeRole && current.name !== "chief"
                      ? (promptOptions?.contextFiles ?? []).map((file) => ({
                          path: file.path,
                          text: file.content,
                        }))
                      : [];
                  const chiefContextFiles =
                    current.name === "chief"
                      ? host
                          .chiefGlobalInstructions(promptOptions)
                          .map((file) => ({
                            path: file.path,
                            text: file.content,
                          }))
                      : [];
                  const futureContextFiles =
                    inheritance && (!roleProfile || !activeRole)
                      ? host
                          .selectedAgentContextFiles(current, ctx.cwd)
                          .map((file) => ({
                            path: file.path,
                            text: file.content,
                          }))
                      : [];
                  const contextFiles =
                    current.name === "chief"
                      ? chiefContextFiles
                      : roleProfile
                        ? activeRole
                          ? roleContextFiles
                          : futureContextFiles
                        : futureContextFiles;
                  const contextCount = inheritance
                    ? String(contextFiles.length)
                    : current.name === "chief"
                      ? String(chiefContextFiles.length)
                      : activeRole
                        ? String(roleContextFiles.length)
                        : "session-dependent";
                  const contextMode =
                    current.name === "chief"
                      ? "Chief forced prompt includes only global user instructions; project context excluded"
                      : inheritance
                        ? inheritance.global && inheritance.project
                          ? "Pi context inherited globally and from the project"
                          : inheritance.global
                            ? "Selected global Pi context"
                            : inheritance.project
                              ? "Selected project Pi context"
                              : "Pi context files disabled"
                        : activeRole
                          ? "Current Pi context from getSystemPromptOptions()"
                          : "Coordinator profile context depends on its future session";
                  const rolePreview = activeRole
                    ? "active-session inputs"
                    : managedLeadProfile
                      ? "future Managed Lead launch"
                      : "prospective Coordinator profile";
                  const title = roleProfile
                    ? `${current.name} · ${rolePreview}`
                    : current.name;
                  const tree: string[] = [];
                  const appendText = (prefix: string, content: string) => {
                    for (const line of content.split("\n"))
                      tree.push(`${prefix}${line}`);
                  };
                  const appendContexts = (label: string) => {
                    if (!contextFiles.length) {
                      tree.push(`├─ ${label} · none`);
                      return;
                    }
                    tree.push(`├─ ${label}`);
                    contextFiles.forEach((file, index) => {
                      tree.push(
                        `│  ${index === contextFiles.length - 1 ? "└─" : "├─"} ${file.path}`,
                      );
                      appendText("│  │  ", file.text);
                    });
                  };
                  const appendDefinition = (label: string) => {
                    tree.push(`├─ ${label}`);
                    inspection.layers.forEach((layer, index) => {
                      const lastLayer = index === inspection.layers.length - 1;
                      tree.push(
                        `│  ${lastLayer ? "└─" : "├─"} ${layer.scope} · ${basename(layer.path)}`,
                      );
                      for (const change of summarizeDefinitionLayerChanges(
                        layer,
                      ))
                        tree.push(`│  │  ${change}`);
                    });
                    for (
                      let index = 0;
                      index < inspection.bodyFragments.length;
                      index++
                    ) {
                      const fragment = inspection.bodyFragments[index]!;
                      tree.push(
                        `│  └─ ${fragment.scope} · surviving body text`,
                      );
                      for (const part of expandedFragments[index] ?? []) {
                        if (part.filePath) {
                          tree.push(`│     └─ ${part.filePath}`);
                          appendText("│        ", part.text);
                        } else appendText("│     ", part.text);
                      }
                    }
                  };
                  const promptMode =
                    current.frontmatter.systemPromptMode ?? "append";
                  const chiefBody = activeChief
                    ? host.supervisoryProfileBody(ctx, "chief")
                    : fragments.join("\n\n");
                  const chiefPrompt =
                    current.name === "chief"
                      ? host.chiefSystemPrompt(promptOptions, chiefBody)
                      : undefined;
                  if (!roleProfile) {
                    tree.push(
                      promptMode === "replace"
                        ? "├─ Replacement prompt · Pi base prefix replaced"
                        : "├─ Pi base instructions · native Pi defaults/tool guidance",
                    );
                    appendDefinition(
                      promptMode === "replace"
                        ? "├─ Replacement body · Herdsman definition"
                        : "├─ Appended prompt · Herdsman definition",
                    );
                    if (inheritance?.global && inheritance.project) {
                      tree.push(
                        "├─ Herdsman shared guidance · managed launch input",
                      );
                      appendContexts(`Pi context · ${contextMode}`);
                    } else {
                      appendContexts(`Pi context · ${contextMode}`);
                      tree.push(
                        "├─ Herdsman shared guidance · managed launch input",
                      );
                    }
                    tree.push(
                      "├─ Pi skills/extensions · configured selections; load status unknown",
                    );
                    tree.push("├─ Working directory");
                    tree.push(`│  ${ctx.cwd}`);
                    tree.push("└─ Runtime contributions · session-dependent");
                  } else if (current.name === "chief") {
                    tree.push(
                      activeChief
                        ? "├─ Active Chief forced prompt"
                        : "├─ Prospective Chief forced prompt",
                    );
                    appendText("│  ", chiefPrompt ?? "");
                    appendDefinition(
                      "├─ Effective Chief profile on disk · may differ from active snapshot",
                    );
                    tree.push(
                      `└─ Global user instruction files included: ${chiefContextFiles.length}; project context excluded`,
                    );
                  } else if (managedLeadProfile) {
                    if (activeRole) {
                      tree.push(
                        "├─ Managed Lead body · active runtime definition",
                      );
                      if (activeExecutionDefinition?.name === "managed-lead")
                        appendText(
                          "│  ",
                          host.expandAgentBodyFiles(
                            activeExecutionDefinition.body,
                            [],
                            "definition details",
                          ),
                        );
                      tree.push(
                        "├─ Herdsman shared guidance · managed launch input",
                      );
                      appendContexts(`Pi context · ${contextMode}`);
                      tree.push(
                        "├─ Runtime role contract · verified active producer",
                      );
                      appendText("│  ", currentRoleCharter ?? "");
                    } else {
                      appendDefinition(
                        "├─ Managed Lead definition · future launch",
                      );
                      tree.push(
                        "├─ Herdsman shared guidance · managed Lead launch input",
                      );
                      appendContexts(`Pi context · ${contextMode}`);
                    }
                    tree.push("├─ Working directory");
                    tree.push(`│  ${ctx.cwd}`);
                    tree.push(
                      "└─ Runtime contributions · managed session-dependent",
                    );
                  } else if (activeRole) {
                    tree.push(
                      "├─ Pi base prompt · native and not reconstructed",
                    );
                    appendContexts(`Pi context · ${contextMode}`);
                    tree.push("├─ Working directory");
                    tree.push(`│  ${ctx.cwd}`);
                    tree.push(
                      "├─ Herdsman role contract/profile · current verified producer",
                    );
                    appendText("│  ", currentRoleCharter ?? "");
                    if (
                      current.name === "flexible-lead" ||
                      current.name === "orchestrator-lead"
                    ) {
                      const activeBody = host.executionPrompt();
                      if (activeBody) {
                        tree.push(
                          "├─ Lead execution profile · active runtime producer",
                        );
                        appendText("│  ", activeBody);
                      }
                      appendDefinition(
                        "├─ Effective Lead profile on disk · active prompt is a session snapshot",
                      );
                    } else if (current.name === "manager") {
                      appendDefinition(
                        "├─ Effective Manager profile on disk · active prompt is a session snapshot",
                      );
                    }
                    tree.push("└─ Runtime contributions · session-dependent");
                  } else {
                    appendDefinition(
                      "├─ Prospective Coordinator profile contribution",
                    );
                    tree.push(
                      "├─ Runtime sections · depend on active role/session",
                    );
                    tree.push(
                      "└─ Exact future prompt unavailable until launch",
                    );
                  }
                  if (roleProfile && !activeRole && current.name !== "chief")
                    tree.push(`Working directory · ${ctx.cwd}`);
                  tree.push("+ added · - removed · ~ changed");
                  await host.showDefinitionDetails(ctx, title, [
                    `Context: ${ctx.cwd}`,
                    `Preview: ${roleProfile ? rolePreview : "Future Agent launch"}`,
                    `Definition sources (${sources.length}): ${sources.join(", ") || "standalone"}`,
                    `Pi context files: ${contextCount} · ${contextMode}`,
                    "Known-input preview only; provider/runtime transformations may add inputs.",
                    ...host.formatAgentDefinitions([metadata]),
                    "",
                    ...tree,
                  ]);
                } catch (error) {
                  ctx.ui.notify(
                    `Could not inspect ${current.name}: ${String(error).replace(/^Error: /u, "")}`,
                    "error",
                  );
                }
              } else {
                ctx.ui.notify(
                  host.formatAgentDefinitions([metadata]).join("\n"),
                );
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
                const resolvedToken = resolved
                  ? modelToken(resolved)
                  : configured;
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
                modelsByToken.set(
                  modelToken(resolvedConfigured),
                  resolvedConfigured,
                );
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
              const model = configured
                ? this.resolveConfiguredModel(ctx, configured)
                : ctx.model;
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
              value =
                selectedThinking === "inherit" ? undefined : selectedThinking;
            } else if (action === "enabled") {
              field = "enabled";
              value = enabledAtScope === false;
            } else continue;
            const latest = await resolveDefinition(selectedName);
            if (
              !latest ||
              !definitionEditTargets(latest).some(
                (candidate) =>
                  candidate.scope === selectedScope &&
                  candidate.path === target.path,
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
            const verified = await resolveDefinition(definition.name);
            if (!verified)
              throw new Error(
                `definition ${definition.name} is no longer available`,
              );
            if (
              result.changed &&
              !definitionEditTargets(verified).some(
                (candidate) =>
                  candidate.scope === selectedScope &&
                  candidate.path === result.path,
              )
            )
              throw new Error(
                `agent ${definition.name} override verification failed`,
              );
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
      }
    },
    async openRunningAgentsMenu(ctx: ExtensionCommandContext): Promise<void> {
      const signal = host.controller.sessionSignal();
      const snapshot = await host.loadStatusSnapshot(ctx, signal);
      const rows = host.buildStatusRows(
        snapshot.agents.filter(
          (agent) => agent.state !== "lost" && agent.state !== "unknown",
        ),
        { now: Date.now() },
      );
      if (!rows.length) {
        ctx.ui.notify(
          "No running Agents. Ask Pi to delegate using an available definition.",
        );
        return;
      }
      const options = host.renderRunningOptions(rows);
      if (ctx.mode !== "tui" && new Set(options).size !== options.length) {
        ctx.ui.notify("Running list is ambiguous; reopen Running.", "warning");
        return;
      }
      const selected = await host.selectMenu(
        ctx,
        "Running",
        options.map((label, index) => ({
          value: String(index),
          label,
          help: rows[index]?.task
            ? `Task: ${rows[index]!.task}`
            : "Focus this managed Agent.",
        })),
      );
      if (selected === undefined) return;
      const selectedIndex = Number(selected);
      const selectedRow =
        !Number.isInteger(selectedIndex) ||
        selectedIndex < 0 ||
        selectedIndex >= rows.length
          ? undefined
          : rows[selectedIndex];
      if (!selectedRow) return;
      const fresh = await host.loadStatusSnapshot(
        ctx,
        host.controller.sessionSignal(),
      );
      const target = fresh.agents.find(
        (agent) =>
          agent.label === selectedRow.label &&
          agent.paneId === selectedRow.paneId &&
          agent.sessionId === selectedRow.sessionId,
      );
      if (!target?.paneId) {
        ctx.ui.notify("Agent changed; reopen Running.", "warning");
        return;
      }
      await host.runHerdr(host.pi, ctx, ["agent", "focus", target.paneId], {
        signal: host.controller.sessionSignal(),
      });
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
      const snapshot = await host.loadStatusSnapshot(
        ctx,
        host.controller.sessionSignal(),
      );
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
              throw new Error(
                "Owned Agent mailbox state is unresolved; stop not verified",
              );
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
            persisted = await host.persistStopClosures(
              ctx,
              result.closures ?? [],
            );
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
        "Execution",
        [
          {
            value: "flexible",
            label: "flexible",
            description: execution.mode === "flexible" ? "current" : undefined,
          },
          {
            value: "orchestrate",
            label: "orchestrate",
            description:
              execution.mode === "orchestrate" ? "current" : undefined,
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
      let selectedSetting = "auto-activate-manager";
      const loadProjectState = () => {
        if (!ctx.isProjectTrusted())
          return { trusted: false as const, overrides: {} };
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
        const projectDescription = (
          key: "autoActivateManager" | "contextRetirement",
        ) =>
          !project.trusted
            ? `Effective ${config[key] ? "on" : "off"} (global; untrusted project)`
            : "error" in project
              ? "Project value unavailable"
              : `Effective ${(Object.hasOwn(project.overrides, key) ? project.overrides[key] : config[key]) ? "on" : "off"}${Object.hasOwn(project.overrides, key) ? " (project)" : " (global)"}`;
        const selected = await host.selectMenu(
          ctx,
          "Settings",
          [
            {
              value: "default-lead-execution",
              label: "Default Lead execution",
              description: config.defaultLeadExecution,
              help: "Used when a future ordinary Lead session has no persisted execution choice.",
            },
            {
              value: "auto-activate-manager",
              label: "Manager auto-start",
              description: `Global ${config.autoActivateManager ? "on" : "off"} · ${projectDescription("autoActivateManager")}`,
              help: "Attempt Manager mode automatically on eligible future session starts. Changing this does not alter the current role.",
            },
            {
              value: "manager-git-bootstrap-confirmation",
              label: "Skip Manager Git setup confirmation",
              description: `Global ${config.managerGitBootstrapWithoutConfirmation ? "on" : "off"}`,
              help: "Automatically initialize a non-Git workspace when Manager is started explicitly. Off by default.",
            },
            {
              value: "context-retirement",
              label: "Context retirement",
              description: `Global ${config.contextRetirement ? "on" : "off"} · ${projectDescription("contextRetirement")}`,
              help: "Retire managed-Agent sessions at automatic context pressure instead of allowing normal threshold compaction.",
            },
            {
              value: "manager-merge",
              label: "Manager local merge",
              description: `Global ${config.managerMergeEnabled === "divergent" ? "conflict-free merges" : config.managerMergeEnabled ? "fast-forward only" : "off"}`,
              help: "Choose whether Managers may integrate accepted local branches only by fast-forward or also by clean divergent merge, with guarded cleanup.",
            },
            {
              value: "status-widget-rows",
              label: "Status widget rows",
              description: String(config.statusWidgetMaxRows),
              help: "Maximum ambient widget lines, including header and overflow (1–100).",
            },
            {
              value: "max-agent-depth",
              label: "Max Agent depth",
              description: String(config.maxAgentDepth),
              help: "Longest chain of nested Agents below the Lead, Manager or Chief (1 = Agents never delegate). Global only; checked at each launch. Existing Agents stay manageable when it is lowered.",
            },
            {
              value: "message-limits",
              label: "Message limits",
              help: "Configure inline attachment and managed mailbox payload byte limits.",
            },
            {
              value: "project-overrides",
              label: "Project overrides…",
              help: "Choose project-specific values for Manager auto-start and context retirement.",
            },
          ],
          selectedSetting,
        );
        if (!selected) return;
        selectedSetting = selected;
        if (selected === "project-overrides") {
          await this.openProjectOverridesMenu(ctx);
        } else if (selected === "status-widget-rows") {
          while (true) {
            const choice = await host.selectMenu(ctx, "Status widget rows", [
              {
                value: "default",
                label: `Default (${DEFAULT_STATUS_WIDGET_MAX_ROWS})`,
              },
              ...[3, 5, 8, 12, 20].map((rows) => ({
                value: String(rows),
                label: String(rows),
              })),
              { value: "custom", label: "Custom…" },
              { value: "reset", label: "Reset" },
            ]);
            if (!choice) break;
            let value: number | undefined;
            if (choice === "reset") value = undefined;
            else if (choice === "custom") {
              const input = await host.input(
                ctx,
                "Custom status widget rows (1–100)",
              );
              if (input === undefined) continue;
              value = Number(input.trim());
              if (
                !/^\d+$/u.test(input.trim()) ||
                !host.validStatusWidgetMaxRows(value)
              ) {
                ctx.ui.notify("Enter an integer from 1 through 100", "error");
                continue;
              }
            } else
              value =
                choice === "default"
                  ? DEFAULT_STATUS_WIDGET_MAX_ROWS
                  : Number(choice);
            try {
              host.updateConfig("statusWidgetMaxRows", value);
              ctx.ui.notify(
                `Status widget rows: ${value === undefined ? "reset" : value}`,
              );
              break;
            } catch (error) {
              ctx.ui.notify(
                `Could not update status widget rows: ${String(error)}`,
                "error",
              );
            }
          }
        } else if (selected === "max-agent-depth") {
          while (true) {
            const choice = await host.selectMenu(ctx, "Max Agent depth", [
              {
                value: "default",
                label: `Default (${DEFAULT_MAX_AGENT_DEPTH})`,
              },
              ...[1, 2, 3, 4, 5].map((depth) => ({
                value: String(depth),
                label: String(depth),
              })),
              { value: "custom", label: "Custom…" },
              { value: "reset", label: "Reset" },
            ]);
            if (!choice) break;
            let value: number | undefined;
            if (choice === "reset") value = undefined;
            else if (choice === "custom") {
              const input = await host.input(
                ctx,
                "Custom max Agent depth (positive integer)",
              );
              if (input === undefined) continue;
              value = Number(input.trim());
              if (
                !/^\d+$/u.test(input.trim()) ||
                !host.validMaxAgentDepth(value)
              ) {
                ctx.ui.notify("Enter a positive integer", "error");
                continue;
              }
            } else
              value =
                choice === "default" ? DEFAULT_MAX_AGENT_DEPTH : Number(choice);
            try {
              host.updateConfig("maxAgentDepth", value);
              ctx.ui.notify(
                `Max Agent depth: ${value === undefined ? "reset" : value}`,
              );
              break;
            } catch (error) {
              ctx.ui.notify(
                `Could not update max Agent depth: ${String(error)}`,
                "error",
              );
            }
          }
        } else if (selected === "message-limits")
          await this.openMessageLimitsMenu(ctx);
        else if (selected === "default-lead-execution") {
          const mode = await host.selectMenu(
            ctx,
            "Default Lead execution",
            [
              { value: "flexible", label: "flexible" },
              { value: "orchestrate", label: "orchestrate" },
            ],
            config.defaultLeadExecution,
          );
          if (mode) host.updateConfig("defaultLeadExecution", mode);
        } else if (
          selected === "context-retirement" ||
          selected === "auto-activate-manager" ||
          selected === "manager-git-bootstrap-confirmation"
        ) {
          const key =
            selected === "context-retirement"
              ? "contextRetirement"
              : selected === "auto-activate-manager"
                ? "autoActivateManager"
                : "managerGitBootstrapWithoutConfirmation";
          const enabled = !host.readConfig()[key];
          host.updateConfig(key, enabled);
          ctx.ui.notify(
            `Global ${key === "contextRetirement" ? "context retirement" : key === "autoActivateManager" ? "Manager auto-start" : "Manager Git setup confirmation skip"}: ${enabled ? "on" : "off"}`,
          );
        } else if (selected === "manager-merge") {
          const current = host.readConfig().managerMergeEnabled;
          const choice = await host.selectMenu(
            ctx,
            "Global Manager local merge",
            [
              { value: "off", label: "Off" },
              { value: "fast-forward", label: "Fast-forward only" },
              { value: "divergent", label: "Conflict-free merges" },
            ],
            current === false
              ? "off"
              : current === true
                ? "fast-forward"
                : "divergent",
          );
          if (!choice) continue;
          const setting =
            choice === "off"
              ? false
              : choice === "fast-forward"
                ? true
                : "divergent";
          if (
            setting !== false &&
            (current === false ||
              (setting === "divergent" && current !== "divergent"))
          ) {
            const confirm = await ctx.ui.input(
              setting === "divergent"
                ? "Enable conflict-free divergent Manager merges? Git may create a new merge commit, and successful integration can automatically remove the exact source worktree. Type enable to confirm."
                : "Enable fast-forward Manager integration and automatic cleanup of successfully integrated source worktrees. Type enable to confirm.",
              undefined,
            );
            if (confirm !== "enable") continue;
          }
          host.updateConfig("managerMergeEnabled", setting);
          ctx.ui.notify(
            `Global Manager local merge: ${setting === "divergent" ? "conflict-free merges" : setting ? "fast-forward only" : "off"}`,
          );
        }
      }
    },
    async openProjectOverridesMenu(
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      while (true) {
        let overrides;
        let overrideError: unknown;
        if (ctx.isProjectTrusted()) {
          try {
            overrides = host.readProjectOverrides(ctx);
          } catch (error) {
            overrideError = error;
          }
        }
        let removalPolicy:
          | Awaited<ReturnType<typeof host.getRemovalPreauthorization>>
          | undefined;
        try {
          removalPolicy = await host.getRemovalPreauthorization(ctx);
        } catch {
          // Removal policy is available only with verified active Manager authority.
        }
        let mergePolicy:
          | {
              repoKey: string;
              enabled: boolean;
              allowDivergence: boolean;
              source: "global" | "repository";
            }
          | undefined;
        try {
          const manager = await host.getRemovalPreauthorization(ctx);
          const policy = effectiveMergePolicy(
            host.readConfig(),
            manager.repoKey,
          );
          mergePolicy = { repoKey: manager.repoKey, ...policy };
        } catch {
          // Merge permission is exposed only with verified active Manager authority.
        }
        if (!ctx.isProjectTrusted() && !removalPolicy) {
          ctx.ui.notify(
            "Project overrides are unavailable because this project is not trusted.",
            "warning",
          );
          return;
        }
        if (overrideError && !removalPolicy) {
          ctx.ui.notify(String(overrideError).replace(/^Error: /, ""), "error");
          return;
        }
        const fields = [
          ...(ctx.isProjectTrusted()
            ? [
                {
                  value: "autoActivateManager",
                  label: "Manager auto-start",
                  help: "Attempt Manager mode automatically on eligible future session starts.",
                },
                {
                  value: "contextRetirement",
                  label: "Context retirement",
                  help: "Retire managed-Agent sessions at automatic context pressure.",
                },
              ]
            : []),
          ...(removalPolicy
            ? [
                {
                  value: "removal-confirmation",
                  label: `Worktree removal confirmation · ${removalPolicy.enabled ? "skip" : "required"}`,
                  help: `Controls confirmation for verified repository ${removalPolicy.repoKey}. Stored in user-level Herdsman authorization, not .pi/settings.json.`,
                },
              ]
            : []),
          ...(mergePolicy
            ? [
                {
                  value: "merge-permission",
                  label: `Manager local merge · ${!mergePolicy.enabled ? "off" : mergePolicy.allowDivergence ? "conflict-free merges" : "fast-forward only"} (${mergePolicy.source})`,
                  help: `Controls local integration and guarded cleanup for verified repository ${mergePolicy.repoKey}.`,
                },
              ]
            : []),
        ];
        const field = await host.selectMenu(ctx, "Project overrides", [
          ...fields,
        ]);
        if (!field) return;
        if (field === "removal-confirmation") {
          const policy = await host.getRemovalPreauthorization(ctx);
          const choice = await host.selectMenu(
            ctx,
            `Worktree removal · ${policy.repoKey}`,
            [
              { value: "required", label: "Require confirmation" },
              {
                value: "skip",
                label: "Skip confirmation for this repository",
              },
            ],
            policy.enabled ? "skip" : "required",
          );
          if (choice && (choice === "skip") !== policy.enabled) {
            const stored = await host.setRemovalPreauthorization(
              choice === "skip",
              ctx,
            );
            ctx.ui.notify(
              stored
                ? `Worktree removal confirmation ${choice === "skip" ? "skipped" : "required"} for ${policy.repoKey}.`
                : "Worktree removal policy unchanged.",
              stored ? "info" : "warning",
            );
          }
          continue;
        }
        if (field === "merge-permission" && mergePolicy) {
          const global = host.readConfig().managerMergeEnabled;
          const current = effectiveMergePolicy(
            host.readConfig(),
            mergePolicy.repoKey,
          );
          const choice = await host.selectMenu(
            ctx,
            `Manager local merge · ${mergePolicy.repoKey}`,
            [
              {
                value: "inherit",
                label: `Inherit global (${global === "divergent" ? "conflict-free merges" : global ? "fast-forward only" : "off"})`,
              },
              { value: "off", label: "Off" },
              { value: "fast-forward", label: "Fast-forward only" },
              { value: "divergent", label: "Conflict-free merges" },
            ],
            current.source === "global"
              ? "inherit"
              : !current.enabled
                ? "off"
                : current.allowDivergence
                  ? "divergent"
                  : "fast-forward",
          );
          if (!choice) continue;
          const enabled =
            choice === "inherit"
              ? undefined
              : choice === "off"
                ? false
                : choice === "fast-forward"
                  ? true
                  : "divergent";
          if (
            enabled !== undefined &&
            enabled !== false &&
            (current.source !== "repository" ||
              !current.enabled ||
              (enabled === "divergent" && !current.allowDivergence))
          ) {
            const confirm = await ctx.ui.input(
              enabled === "divergent"
                ? "Enable conflict-free divergent Manager merges? Git may create a new merge commit, and successful integration can automatically remove the exact source worktree. Type enable to confirm."
                : "Enable fast-forward Manager integration and automatic cleanup of successfully integrated source worktrees. Type enable to confirm.",
              undefined,
            );
            if (confirm !== "enable") continue;
          }
          const exactManager = await host.getRemovalPreauthorization(ctx);
          if (exactManager.repoKey !== mergePolicy.repoKey)
            throw new Error(
              "Manager repository changed; policy was not updated",
            );
          setManagerMergeOverride(mergePolicy.repoKey, enabled);
          ctx.ui.notify(
            `Manager local merge ${enabled === undefined ? "inherits global" : enabled === "divergent" ? "allows conflict-free merges" : enabled ? "allows fast-forward only" : "disabled"} for ${mergePolicy.repoKey}.`,
          );
          continue;
        }
        if (!ctx.isProjectTrusted() || overrideError || !overrides) continue;
        const key = field as "autoActivateManager" | "contextRetirement";
        const global = host.readConfig()[key];
        const choice = await host.selectMenu(
          ctx,
          key === "autoActivateManager"
            ? "Manager auto-start"
            : "Context retirement",
          [
            {
              value: "inherit",
              label: `Inherit global (${global ? "on" : "off"})`,
              help: "Remove this project's explicit value and use the current global default.",
            },
            {
              value: "on",
              label: "On for this project",
              help: "Enable this preference in this trusted project.",
            },
            {
              value: "off",
              label: "Off for this project",
              help: "Disable this preference in this trusted project.",
            },
          ],
          Object.hasOwn(overrides, key)
            ? overrides[key]
              ? "on"
              : "off"
            : "inherit",
        );
        if (!choice) continue;
        try {
          host.updateProjectOverride(
            ctx,
            key,
            choice === "inherit" ? undefined : choice === "on",
          );
          ctx.ui.notify(
            `${key === "autoActivateManager" ? "Manager auto-start" : "Context retirement"} ${choice === "inherit" ? "inherited" : `set ${choice} for this project`}.`,
          );
        } catch (error) {
          ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
        }
      }
    },
    async openAgentsMenu(ctx: ExtensionCommandContext): Promise<void> {
      let selectedSection = "running";
      while (true) {
        const snapshot = await host.loadStatusSnapshot(
          ctx,
          host.controller.sessionSignal(),
        );
        const running = host.formatStatusCounts(snapshot.agents) || "0";
        const placement = await host.placementSettings(ctx);
        const selected = await host.selectMenu(
          ctx,
          "Agents",
          [
            {
              value: "running",
              label: "Running",
              description: running,
              help: "Focus a live managed Agent.",
            },
            {
              value: "layout",
              label: "Layout",
              description: placement.effective,
              help: "Choose where newly delegated Lead-direct Agents are placed in Herdr.",
            },
            {
              value: "stop-all",
              label: "Stop all…",
              help: "Emergency stop for the owned Agent tree. Active work or pending results may be discarded.",
            },
          ],
          selectedSection,
        );
        if (!selected) return;
        selectedSection = selected;
        if (selected === "running") await this.openRunningAgentsMenu(ctx);
        else if (selected === "layout") await this.openPlacementMenu(ctx);
        else if (selected === "stop-all") await this.confirmAndStopAll(ctx);
      }
    },
    async openHerdsmanMenu(ctx: ExtensionCommandContext): Promise<void> {
      let selectedSection = "execution";
      while (true) {
        const execution = host.leadExecutionPresentation();
        const selected = await host.selectMenu(
          ctx,
          `Pi Herdsman · v${host.version}`,
          [
            {
              value: "execution",
              label: "Execution",
              description: execution.managed
                ? managedExecutionLabel(execution.lifecycle)
                : execution.mode,
              help: execution.managed
                ? "This assigned session uses managed-lead. Use Pi /fork or /clone to continue independently (same Git checkout)."
                : "Choose whether this session works directly or primarily delegates tasks.",
            },
            {
              value: "agents",
              label: "Agents",
              help: "View and manage background Agents.",
            },
            {
              value: "manager",
              label: "Project manager",
              description: host.roleActive("manager") ? "active" : undefined,
              help: "Coordinate independent project work across Git branches.",
            },
            {
              value: "stats",
              label: "Session stats",
              help: "View token usage and model costs for this session and its managed work.",
            },
            {
              value: "definitions",
              label: "Definitions",
              help: "Inspect available Agents and their configuration.",
            },
            {
              value: "settings",
              label: "Settings",
              help: "Change Herdsman preferences.",
            },
            {
              value: "advanced",
              label: "Advanced…",
              description: host.roleActive("chief")
                ? "Chief active"
                : undefined,
              help: "Open advanced Herdsman coordination controls.",
            },
          ],
          selectedSection,
        );
        if (!selected) return;
        selectedSection = selected;
        if (selected === "execution") await this.openExecutionMenu(ctx);
        else if (selected === "agents") await this.openAgentsMenu(ctx);
        else if (selected === "manager")
          await this.openRoleMenu("manager", ctx);
        else if (selected === "stats") await this.showSessionStats(ctx);
        else if (selected === "definitions")
          await this.openDefinitionsMenu(ctx);
        else if (selected === "settings") await this.openSettingsMenu(ctx);
        else if (selected === "advanced") await this.openAdvancedMenu(ctx);
      }
    },
    async openAdvancedMenu(ctx: ExtensionCommandContext): Promise<void> {
      const selected = await host.selectMenu(ctx, "Advanced", [
        {
          value: "chief",
          label: "Chief mode",
          description: host.roleActive("chief") ? "active" : undefined,
          help: "Supervise Managers and unassigned Leads across Herdsman.",
        },
      ]);
      if (selected === "chief") await this.openRoleMenu("chief", ctx);
    },
    async openRoleMenu(
      role: "manager" | "chief",
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const active = host.roleActive(role);
      const name = role === "manager" ? "Manager" : "Chief";
      const title = role === "manager" ? "Project manager" : "Chief mode";
      const selected = await host.selectMenu(
        ctx,
        title,
        active
          ? [
              { value: "overview", label: "Overview" },
              {
                value: "refresh",
                label: "Refresh profile",
                help: "Apply definition changes after the current turn becomes idle.",
              },
              { value: "leave", label: `Leave ${name} mode` },
            ]
          : [{ value: "start", label: `Start ${name} mode` }],
      );
      if (selected === "overview" || selected === "start")
        await this.runRoleCommand(role, "", ctx);
      else if (selected === "refresh")
        await this.runRoleCommand(role, "refresh", ctx);
      else if (selected === "leave")
        await this.runRoleCommand(role, "leave", ctx);
    },
    async runRoleCommand(
      role: "manager" | "chief",
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const args = rawArgs.trim().split(/\s+/u).filter(Boolean);
      const action = args[0];
      if (
        args.length > 1 ||
        (action && action !== "refresh" && action !== "leave")
      ) {
        ctx.ui.notify(`Usage: /${role} [refresh|leave]`, "error");
        return;
      }
      try {
        if (!action && host.roleActive(role)) {
          await host.openSupervisionOverview(ctx);
          return;
        }
        if (action === "refresh" && !host.roleActive(role)) {
          ctx.ui.notify(
            `/${role} refresh requires active ${role} mode`,
            "error",
          );
          return;
        }
        ctx.ui.notify(await host.transitionRole(role, action === "leave", ctx));
      } catch (error) {
        ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
      }
    },
    async runHerdsmanCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      if (!ctx.hasUI) return;
      const usage =
        "Usage: /herdsman [stats | definitions | placement [tab|subtree|split] | stop]";
      const placementUsage = "Usage: /herdsman placement [tab|subtree|split]";
      const args = rawArgs.trim() ? rawArgs.trim().split(/\s+/u) : [];
      try {
        if (!args.length) return void (await this.openHerdsmanMenu(ctx));
        if (args[0] === "stats" && args.length === 1)
          return void (await this.showSessionStats(ctx));
        if (args[0] === "definitions" && args.length === 1)
          return void (await this.openDefinitionsMenu(ctx));
        if (args[0] === "placement") {
          if (args.length > 2 || (args[1] && !host.isSpawnPlacement(args[1])))
            return void ctx.ui.notify(placementUsage, "error");
          if (args.length === 1)
            return void (await this.openPlacementMenu(ctx));
          host.updateConfig("spawnPlacement", args[1]);
          const verified = await host.placementSettings(ctx);
          if (verified.effective !== args[1])
            throw new Error(
              `Agent placement did not become effective: ${verified.effective}`,
            );
          return void ctx.ui.notify(`placement: ${verified.effective}`);
        }
        if (args[0] === "stop" && args.length === 1)
          return void (await this.confirmAndStopAll(ctx));
        ctx.ui.notify(usage, "error");
      } catch (error) {
        ctx.ui.notify(String(error), "error");
      }
    },
    async runLeadExecutionCommand(
      rawArgs: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const args = rawArgs.trim().split(/\s+/u).filter(Boolean);
      const mode = args[0];
      if (
        args.length > 1 ||
        (mode !== undefined && !isLeadExecutionMode(mode))
      ) {
        ctx.ui.notify("Usage: /lead [flexible|orchestrate]", "error");
        return;
      }
      if (mode === undefined) return void (await this.openExecutionMenu(ctx));
      try {
        await host.setLeadExecutionMode(ctx, mode);
        ctx.ui.notify(`Lead execution: ${mode}`);
      } catch (error) {
        ctx.ui.notify(String(error).replace(/^Error: /, ""), "error");
      }
    },
  };
}
