import assert from "node:assert/strict";
import { test } from "node:test";
import packageMetadata from "../../package.json" with { type: "json" };
import { claimDelegationLock } from "../agent-controller.ts";
import { readConfig, resolveProjectsDirectory } from "../config.ts";
import { fakeContext, WORKSPACE } from "../support.ts";
import { createLeadCommandRuntime } from "./commands.ts";

test("Herdsman root renders when status and definition metadata fail", async () => {
  let rootLabels: string[] = [];
  const notices: string[] = [];
  const runtime = createLeadCommandRuntime({
    version: packageMetadata.version,
    loadStatusSnapshot: async () => {
      throw new Error("status unavailable");
    },
    contextAgentDefinitions: async () => {
      throw new Error("definitions unavailable");
    },
    leadExecutionPresentation: () => ({ managed: false, mode: "flexible" }),
    roleActive: () => false,
    selectMenu: async (_ctx: unknown, _title: string, items: any[]) => {
      rootLabels = items.map(({ label }) => label);
      return undefined;
    },
  } as any);
  await runtime.runHerdsmanCommand("", {
    hasUI: true,
    ui: { notify: (message: string) => notices.push(message) },
  } as any);
  assert.deepEqual(rootLabels, [
    "Execution",
    "Agents",
    "Project manager",
    "Session stats",
    "Definitions",
    "Settings",
    "Advanced…",
  ]);
  assert.deepEqual(notices, []);
});

test("Herdsman role menus dispatch through the shared role transition", async () => {
  for (const role of ["manager", "chief"] as const) {
    for (const scenario of [
      {
        active: false,
        action: "start",
        labels: [`Start ${role === "manager" ? "Manager" : "Chief"} mode`],
      },
      {
        active: true,
        action: "overview",
        labels: [
          "Overview",
          `Leave ${role === "manager" ? "Manager" : "Chief"} mode`,
        ],
      },
      {
        active: true,
        action: "leave",
        labels: [
          "Overview",
          `Leave ${role === "manager" ? "Manager" : "Chief"} mode`,
        ],
      },
    ]) {
      const dispatched: [string, boolean][] = [];
      const menus: { title: string; labels: string[] }[] = [];
      const overviews: string[] = [];
      let rootSelection = true;
      const host = {
        version: packageMetadata.version,
        leadExecutionPresentation: () => ({
          managed: false,
          mode: "flexible",
        }),
        roleActive: (selectedRole: string) =>
          selectedRole === role && scenario.active,
        transitionRole: async (selectedRole: string, leave: boolean) => {
          dispatched.push([selectedRole, leave]);
          return "transition requested";
        },
        openSupervisionOverview: async () => {
          overviews.push(role);
        },
        selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
          menus.push({ title, labels: items.map(({ label }) => label) });
          if (title.startsWith("Pi Herdsman")) {
            if (!rootSelection) return undefined;
            rootSelection = false;
            return role === "manager" ? "manager" : "advanced";
          }
          if (title === "Advanced") return "chief";
          return scenario.action;
        },
      } as any;
      const runtime = createLeadCommandRuntime(host);
      const notices: string[] = [];
      await runtime.runHerdsmanCommand("", {
        hasUI: true,
        ui: { notify: (message: string) => notices.push(message) },
      } as any);
      const title = role === "manager" ? "Project manager" : "Chief mode";
      assert.ok(
        menus.some(
          (menu) =>
            menu.title === title &&
            scenario.labels.every((label) => menu.labels.includes(label)),
        ),
      );
      assert.deepEqual(
        dispatched,
        scenario.action === "start"
          ? [[role, false]]
          : scenario.action === "leave"
            ? [[role, true]]
            : [[role, false]],
      );
      assert.deepEqual(overviews, scenario.action === "overview" ? [role] : []);
      assert.deepEqual(notices, ["transition requested"]);
    }
  }
});

test("Project override menu edits Off then Inherit without changing global Manager auto-start", async () => {
  const menus: { title: string; selected?: string }[] = [];
  const values: string[] = [];
  const overrides: { autoActivateManager?: boolean } = {};
  const global = { ...readConfig(), autoActivateManager: true };
  const answers = [
    "project-overrides",
    "autoActivateManager",
    "off",
    undefined,
    "project-overrides",
    "autoActivateManager",
    "inherit",
    undefined,
    undefined,
  ];
  const runtime = createLeadCommandRuntime({
    readConfig: () => global,
    readProjectOverrides: () => ({ ...overrides }),
    updateProjectOverride: (
      _ctx: unknown,
      _key: string,
      value: boolean | undefined,
    ) => {
      if (value === undefined) delete overrides.autoActivateManager;
      else overrides.autoActivateManager = value;
      values.push(value === undefined ? "inherit" : value ? "on" : "off");
    },
    selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
      const answer = answers.shift();
      menus.push({
        title,
        selected: items.find(({ value }) => value === answer)?.value,
      });
      return answer;
    },
  } as any);
  await runtime.openSettingsMenu({
    isProjectTrusted: () => true,
    ui: { notify: () => undefined },
  } as any);
  assert.deepEqual(values, ["off", "inherit"]);
  assert.equal(Object.hasOwn(overrides, "autoActivateManager"), false);
  assert.equal(global.autoActivateManager, true);
  assert.deepEqual(
    menus.map(({ title }) => title),
    [
      "Settings",
      "Project overrides",
      "Manager auto-start",
      "Project overrides",
      "Settings",
      "Project overrides",
      "Manager auto-start",
      "Project overrides",
      "Settings",
    ],
  );
});

test("Settings displays, changes, and resets the effective Projects directory", async () => {
  const settingsMenus: { items: any[]; selected?: string }[] = [];
  const directoryMenus: any[][] = [];
  const updates: [string, unknown][] = [];
  const inputs: string[] = [];
  const notices: string[] = [];
  const settingSelections = [
    "projects-directory",
    "projects-directory",
    undefined,
  ];
  const directorySelections = ["change", "reset"];
  const enteredDirectories = ["~/New Projects"];
  let storedDirectory: string | undefined = "~/Existing Projects";
  const runtime = createLeadCommandRuntime({
    readConfig: () => ({
      ...readConfig(),
      projectsDirectory: storedDirectory ?? readConfig().projectsDirectory,
    }),
    updateConfig: (key: string, value: unknown) => {
      updates.push([key, value]);
      storedDirectory = value as string | undefined;
    },
    input: async (_ctx: unknown, label: string) => {
      inputs.push(label);
      return enteredDirectories.shift();
    },
    selectMenu: async (
      _ctx: unknown,
      title: string,
      items: any[],
      selected?: string,
    ) => {
      if (title === "Settings") {
        settingsMenus.push({ items, selected });
        return settingSelections.shift();
      }
      directoryMenus.push(items);
      return directorySelections.shift();
    },
  } as any);
  await runtime.openSettingsMenu({
    isProjectTrusted: () => false,
    ui: { notify: (message: string) => notices.push(message) },
  } as any);

  const projectSetting = settingsMenus[0]?.items.find(
    ({ value }) => value === "projects-directory",
  );
  assert.equal(projectSetting?.label, "Projects directory");
  assert.equal(
    projectSetting?.description,
    resolveProjectsDirectory("~/Existing Projects"),
  );
  assert.match(projectSetting?.help, /newly cloned repositories/);
  assert.deepEqual(
    directoryMenus[0]?.map(({ label }) => label),
    ["Change directory", "Reset to default"],
  );
  assert.equal(inputs[0], "Projects directory (absolute path or ~/path)");
  assert.deepEqual(updates, [
    ["projectsDirectory", "~/New Projects"],
    ["projectsDirectory", undefined],
  ]);
  assert.deepEqual(notices, [
    `Projects directory: ${resolveProjectsDirectory("~/New Projects")}`,
    `Projects directory: ${resolveProjectsDirectory("~/Projects")}`,
  ]);
});

test("Project Overrides exposes verified removal policy independently of project trust and storage", async () => {
  const menuCalls: { title: string; items: any[] }[] = [];
  const notices: string[] = [];
  let stored: boolean | undefined;
  const answers = ["removal-confirmation", "skip", undefined];
  const runtime = createLeadCommandRuntime({
    readProjectOverrides: () => {
      throw new Error("untrusted project settings");
    },
    getRemovalPreauthorization: async () => ({
      repoKey: "/verified/repository",
      enabled: false,
    }),
    setRemovalPreauthorization: async (enabled: boolean) => {
      stored = enabled;
      return true;
    },
    selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
      menuCalls.push({ title, items });
      return answers.shift();
    },
  } as any);
  await runtime.openProjectOverridesMenu({
    isProjectTrusted: () => false,
    ui: { notify: (message: string) => notices.push(message) },
  } as any);
  assert.equal(menuCalls[0]?.title, "Project overrides");
  assert.deepEqual(
    menuCalls[0]?.items.map(({ value }) => value),
    ["removal-confirmation"],
  );
  assert.match(menuCalls[0]?.items[0]?.help, /\/verified\/repository/);
  assert.match(menuCalls[0]?.items[0]?.help, /not \.pi\/settings\.json/);
  assert.equal(menuCalls[1]?.title, "Worktree removal · /verified/repository");
  assert.equal(stored, true);
  assert.deepEqual(notices, [
    "Worktree removal confirmation skipped for /verified/repository.",
  ]);
});

test("Settings isolates malformed project settings and untrusted projects inherit global values", async () => {
  const menus: { label: string; options: string[] }[] = [];
  const notices: string[] = [];
  const updates: boolean[] = [];
  let trusted = true;
  let reads = 0;
  let settingSelection = 0;
  const runtime = createLeadCommandRuntime({
    readConfig: () => ({ ...readConfig(), autoActivateManager: true }),
    readProjectOverrides: () => {
      reads++;
      throw new Error("malformed project settings");
    },
    updateConfig: (_key: string, value: boolean) => updates.push(value),
    selectMenu: async (_ctx: unknown, label: string, items: any[]) => {
      menus.push({
        label,
        options: items.map(({ label, description }) =>
          description ? `${label}  ${description}` : label,
        ),
      });
      if (label === "Settings")
        return settingSelection++ === 0
          ? trusted
            ? "auto-activate-manager"
            : "project-overrides"
          : undefined;
      return undefined;
    },
  } as any);
  const context = {
    isProjectTrusted: () => trusted,
    ui: { notify: (message: string) => notices.push(message) },
  } as any;
  await runtime.openSettingsMenu(context);
  assert.match(
    menus[0]?.options.find((option) =>
      option.startsWith("Manager auto-start"),
    ) ?? "",
    /Global on · Project value unavailable/u,
  );
  assert.deepEqual(updates, [false], "global settings remain editable");
  assert.equal(
    reads,
    2,
    "the trusted settings menu reloads its project snapshot after edits",
  );

  trusted = false;
  settingSelection = 0;
  menus.length = 0;
  await runtime.openSettingsMenu(context);
  assert.match(
    menus[0]?.options.find((option) =>
      option.startsWith("Manager auto-start"),
    ) ?? "",
    /Effective on \(global; untrusted project\)/u,
  );
  assert.equal(reads, 2, "untrusted projects do not read project settings");
  assert.deepEqual(notices, [
    "Global Manager auto-start: off",
    "Project overrides are unavailable because this project is not trusted.",
  ]);
});

test("Definitions retains the last selected Agent when returning to its list", async () => {
  const { RESERVED_ROLE_DEFINITION_NAMES } =
    await import("../agent-definitions.ts");
  const second = { name: "second", frontmatter: { name: "second" } } as any;
  const first = { name: "first", frontmatter: { name: "first" } } as any;
  const roleDefinitions = RESERVED_ROLE_DEFINITION_NAMES.map((name) => ({
    name,
    frontmatter: { name },
  })) as any[];
  const selections: { title: string; selected?: string }[] = [];
  const results = ["agents", "second", undefined, undefined, undefined];
  const runtime = createLeadCommandRuntime({
    contextAgentDefinitions: async () => ({
      definitions: [first, second],
      roleDefinitions,
      projectTrusted: true,
    }),
    selectMenu: async (
      _ctx: unknown,
      title: string,
      _items: any[],
      selected?: string,
    ) => {
      selections.push({ title, selected });
      return results.shift();
    },
    agentDefinitionEnabled: () => true,
    getThinkingLevel: () => "high",
  } as any);
  await runtime.openDefinitionsMenu({
    ui: { notify: () => undefined },
  } as any);
  assert.deepEqual(
    selections
      .filter(({ title }) => title === "Agents")
      .map(({ selected }) => selected),
    [undefined, "second"],
  );
});

test("lead stop-all does not report an empty inventory while delegation is locked", async () => {
  const summaries: string[] = [];
  const context = fakeContext() as any;
  context.hasUI = true;
  const release = claimDelegationLock(
    WORKSPACE,
    context.sessionManager.getSessionId(),
  );
  const runtime = createLeadCommandRuntime({
    loadStatusSnapshot: async () => ({ agents: [] }),
    controller: {
      workspaceId: () => WORKSPACE,
      sessionSignal: () => new AbortController().signal,
    },
    presentStopSummary: (summary: string) => summaries.push(summary),
  } as any);
  try {
    await assert.rejects(
      runtime.confirmAndStopAll(context),
      /already in progress/,
    );
    assert.deepEqual(summaries, []);
  } finally {
    release();
  }
});

test("lead stop-all rejects an empty inventory with unresolved mailbox state", async () => {
  const summaries: string[] = [];
  let cleanupStarted = false;
  const context = fakeContext() as any;
  context.hasUI = true;
  const runtime = createLeadCommandRuntime({
    loadStatusSnapshot: async () => ({ agents: [] }),
    controller: {
      workspaceId: () => WORKSPACE,
      sessionSignal: () => new AbortController().signal,
      agentSnapshotView: async () => ({
        stateIssues: [{ diagnostic: "unreadable mailbox" }],
        visible: [],
      }),
      stopOwnedAgentsForSession: async () => {
        cleanupStarted = true;
      },
    },
    presentStopSummary: (summary: string) => summaries.push(summary),
  } as any);

  await assert.rejects(
    runtime.confirmAndStopAll(context),
    /Owned Agent mailbox state is unresolved; stop not verified/u,
  );
  assert.deepEqual(summaries, []);
  assert.equal(cleanupStarted, false);
});

test("Stop all finishes only the Lead herd run", async () => {
  for (const isLead of [true, false]) {
    const ctx = fakeContext() as any;
    ctx.ui.confirm = async () => true;
    ctx.abort = () => {};
    let finished = 0;
    const runtime = createLeadCommandRuntime({
      isLead: () => isLead,
      loadStatusSnapshot: async () => ({ agents: [{}] }),
      formatStatusCounts: () => "1 agent",
      controller: {
        workspaceId: () => WORKSPACE,
        sessionSignal: () => new AbortController().signal,
        stopOwnedAgentsForSession: async () => ({
          summary: "Stopped",
          closures: [],
        }),
      },
      persistStopClosures: async () => 0,
      presentStopSummary: () => {},
      maybeFinishHerdRun: async () => {
        finished++;
      },
    } as any);
    await runtime.confirmAndStopAll(ctx);
    assert.equal(finished, isLead ? 1 : 0);
  }
});
