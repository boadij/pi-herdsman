import assert from "node:assert/strict";
import { test } from "node:test";
import packageMetadata from "../../package.json" with { type: "json" };
import {
  claimDelegationLock,
  visibleAgentSnapshots,
} from "../agent-controller.ts";
import {
  readConfig,
  validMaxAgentDepth,
  validStatusWidgetMaxRows,
} from "../config.ts";
import { fakeContext, WORKSPACE } from "../support.ts";
import { createLeadCommandRuntime } from "./commands.ts";

test("status widget rows Settings validates choices and reports persistence errors", async () => {
  for (const scenario of [
    { choices: ["5"], inputs: [], expected: [5], errors: 0 },
    {
      choices: ["custom", "custom", "custom"],
      inputs: ["1e1", "+3", " 100 "],
      expected: [100],
      errors: 2,
    },
    { choices: ["reset"], inputs: [], expected: [undefined], errors: 0 },
    {
      choices: ["custom", undefined],
      inputs: [undefined],
      expected: [],
      errors: 0,
    },
    {
      choices: ["12", undefined],
      inputs: [],
      expected: [],
      errors: 1,
      fail: true,
    },
  ]) {
    const choices = [...scenario.choices];
    const inputs = [...scenario.inputs];
    const updates: (number | undefined)[] = [];
    const notices: [string, string | undefined][] = [];
    let settings = 0;
    const runtime = createLeadCommandRuntime({
      readConfig,
      placementSettings: async () => ({ effective: "tab" }),
      validStatusWidgetMaxRows,
      selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
        if (title === "Interface") {
          assert.equal(
            items.find((item) => item.value === "status-widget-rows")
              .description,
            "8",
          );
          return settings++ === 0 ? "status-widget-rows" : undefined;
        }
        return choices.shift();
      },
      input: async () => inputs.shift(),
      updateConfig: (_key: string, value: number | undefined) => {
        if (scenario.fail) throw new Error("disk failure");
        updates.push(value);
      },
    } as any);
    await runtime.openSettingsCategory(
      {
        isProjectTrusted: () => false,
        ui: {
          notify: (message: string, level?: string) =>
            notices.push([message, level]),
        },
      } as any,
      "interface",
    );
    assert.deepEqual(updates, scenario.expected);
    assert.equal(
      notices.filter(([, level]) => level === "error").length,
      scenario.errors,
    );
    if (scenario.fail)
      assert.equal(
        notices.some(([, level]) => level !== "error"),
        false,
      );
  }
});

test("max Agent depth Settings validates choices and reports persistence errors", async () => {
  for (const scenario of [
    { choices: ["4"], inputs: [], expected: [4], errors: 0 },
    { choices: ["default"], inputs: [], expected: [], errors: 0 },
    {
      choices: ["custom", "custom", "custom", "custom"],
      inputs: ["0", "-1", "1.5", " 6 "],
      expected: [6],
      errors: 3,
    },
    { choices: ["reset"], inputs: [], expected: [undefined], errors: 0 },
    {
      choices: ["custom", undefined],
      inputs: [undefined],
      expected: [],
      errors: 0,
    },
    {
      choices: ["3", undefined],
      inputs: [],
      expected: [],
      errors: 1,
      fail: true,
    },
  ]) {
    const choices = [...scenario.choices];
    const inputs = [...scenario.inputs];
    const updates: (number | undefined)[] = [];
    const notices: [string, string | undefined][] = [];
    let settings = 0;
    const runtime = createLeadCommandRuntime({
      readConfig,
      placementSettings: async () => ({ effective: "tab" }),
      validMaxAgentDepth,
      selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
        if (title === "Sessions & agents") {
          assert.equal(
            items.find((item) => item.value === "max-agent-depth").description,
            "2",
          );
          return settings++ === 0 ? "max-agent-depth" : undefined;
        }
        return choices.shift();
      },
      input: async () => inputs.shift(),
      updateConfig: (key: string, value: number | undefined) => {
        assert.equal(key, "maxAgentDepth");
        if (scenario.fail) throw new Error("disk failure");
        updates.push(value);
      },
    } as any);
    await runtime.openSettingsCategory(
      {
        isProjectTrusted: () => false,
        ui: {
          notify: (message: string, level?: string) =>
            notices.push([message, level]),
        },
      } as any,
      "sessions",
    );
    assert.deepEqual(updates, scenario.expected);
    assert.equal(
      notices.filter(([, level]) => level === "error").length,
      scenario.errors,
    );
  }
});

test("Herdsman root renders when status and definition metadata fail", async () => {
  for (const scenario of [
    { role: "lead", managed: false, mode: "flexible" },
    { role: "lead", managed: false, mode: "orchestrate" },
    { role: "lead", managed: true, mode: "flexible" },
    { role: "manager", managed: false, mode: "flexible" },
    { role: "chief", managed: false, mode: "flexible" },
  ]) {
    const showLeadMode = scenario.role === "lead" && !scenario.managed;
    const notices: string[] = [];
    let calls = 0;
    let discoveryCalls = 0;
    const runtime = createLeadCommandRuntime({
      version: packageMetadata.version,
      loadStatusSnapshot: async () => {
        discoveryCalls++;
        throw new Error("status unavailable");
      },
      contextAgentDefinitions: async () => {
        discoveryCalls++;
        throw new Error("definitions unavailable");
      },
      isLead: () => scenario.role === "lead",
      leadExecutionPresentation: () => ({
        managed: scenario.managed,
        mode: scenario.mode,
      }),
      roleActive: (role: string) => role === scenario.role,
      selectMenu: async (
        _ctx: unknown,
        _title: string,
        items: any[],
        selected: string,
      ) => {
        calls++;
        assert.deepEqual(
          items.map(({ label }) => label),
          [
            ...(showLeadMode ? ["Lead mode"] : []),
            "Agents & definitions",
            "Project management",
            "Chief coordination",
            "Settings",
            "Usage & costs",
          ],
        );
        assert.equal(selected, showLeadMode ? "execution" : "agents");
        if (showLeadMode) assert.equal(items[0].description, scenario.mode);
        assert.equal(
          items.find((item) => item.value === "manager").description,
          scenario.role === "manager" ? "Active" : "Inactive",
        );
        assert.equal(
          items.find((item) => item.value === "chief").description,
          scenario.role === "chief" ? "Active" : "Inactive",
        );
        return undefined;
      },
    } as any);
    await runtime.runHerdsmanCommand("", {
      hasUI: true,
      ui: { notify: (message: string) => notices.push(message) },
    } as any);
    assert.equal(calls, 1);
    assert.equal(discoveryCalls, 0);
    assert.deepEqual(notices, []);
  }
});

test("Settings categories and Agents & definitions retain their selections", async () => {
  const calls: { title: string; labels: string[]; selected?: string }[] = [];
  const answers = ["manager", undefined, "interface", undefined, undefined];
  const runtime = createLeadCommandRuntime({
    readConfig: () => readConfig(),
    placementSettings: async () => ({ effective: "tab" }),
    selectMenu: async (
      _ctx: unknown,
      title: string,
      items: any[],
      selected?: string,
    ) => {
      calls.push({ title, labels: items.map((item) => item.label), selected });
      return answers.shift();
    },
  } as any);
  await runtime.openSettingsMenu({ isProjectTrusted: () => false } as any);
  assert.deepEqual(calls[0]?.labels, [
    "Sessions & agents",
    "Manager & repositories",
    "Interface",
    "Delegation options",
    "Communication",
  ]);
  assert.equal(calls[2]?.selected, "manager");
  assert.equal(calls[4]?.selected, "interface");

  const agentCalls: string[][] = [];
  const agents = createLeadCommandRuntime({
    controller: { sessionSignal: () => undefined },
    loadStatusSnapshot: async () => ({ agents: [] }),
    formatStatusCounts: () => "0",
    selectMenu: async (_ctx: unknown, _title: string, items: any[]) => {
      agentCalls.push(items.map((item) => item.label));
      return undefined;
    },
  } as any);
  await agents.openAgentsMenu({} as any);
  assert.deepEqual(agentCalls[0], [
    "Running agents",
    "Agent definitions",
    "Coordinator profiles",
    "Stop all agents…",
  ]);
});

test("Agent definitions remain available when running status fails", async () => {
  const seen: { title: string; items: any[] }[] = [];
  let loadedDefinitions = 0;
  const runtime = createLeadCommandRuntime({
    controller: { sessionSignal: () => undefined },
    loadStatusSnapshot: async () => {
      throw new Error("status failed");
    },
    contextAgentDefinitions: async () => {
      loadedDefinitions++;
      return { definitions: [], roleDefinitions: [], projectTrusted: false };
    },
    selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
      seen.push({ title, items });
      return seen.length === 1 ? "agent-definitions" : undefined;
    },
  } as any);
  await runtime.openAgentsMenu({
    isProjectTrusted: () => false,
    ui: { notify: () => undefined },
  } as any);
  assert.equal(seen[0]?.items[0]?.description, "Unavailable");
  assert.equal(loadedDefinitions, 1);
});

test("Role menus retain selection and refresh active state after operations", async () => {
  let active = true;
  const selections: (string | undefined)[] = [];
  const labels: string[][] = [];
  const answers = ["refresh", "leave", undefined];
  const runtime = createLeadCommandRuntime({
    roleActive: () => active,
    transitionRole: async (_role: string, leave: boolean) => {
      if (leave) active = false;
      return "ok";
    },
    selectMenu: async (
      _ctx: unknown,
      _title: string,
      items: any[],
      selected: string | undefined,
    ) => {
      selections.push(selected);
      labels.push(items.map((i) => i.value));
      return answers.shift();
    },
  } as any);
  await runtime.openRoleMenu("chief", {
    ui: { notify: () => undefined },
  } as any);
  assert.deepEqual(selections, [undefined, "refresh", "leave"]);
  assert.deepEqual(labels[2], ["start"]);
});

test("Value menus identify current options in text and message row shows effective limits", async () => {
  const menus: { title: string; items: any[]; selected?: string }[] = [];
  const runtime = createLeadCommandRuntime({
    readConfig: () => ({
      ...readConfig(),
      defaultLeadExecution: "orchestrate",
      managerGitBootstrapWithoutConfirmation: false,
      maxAgentDepth: 7,
      statusWidgetMaxRows: 5,
    }),
    messageLimits: async () => ({
      inline: { bytes: 4096 },
      mailbox: { bytes: 16384 },
    }),
    formatMessageLimit: (n: number) => `${n / 1024} KiB`,
    placementSettings: async () => ({ effective: "tab" }),
    getRemovalPreauthorization: async () => ({
      repoKey: "/repo",
      enabled: false,
      identity: {},
    }),
    selectMenu: async (
      _ctx: unknown,
      title: string,
      items: any[],
      selected?: string,
    ) => {
      menus.push({ title, items, selected });
      return undefined;
    },
  } as any);
  const ctx = {
    isProjectTrusted: () => false,
    ui: { notify: () => undefined },
  } as any;
  await runtime.openSettingsCategory(ctx, "sessions");
  assert.equal(
    menus[0]?.items.find((i) => i.value === "message-limits").description,
    "Inline 4 KiB · mailbox 16 KiB",
  );
  await runtime.openRemovalSetting(ctx);
  const removal = menus.at(-1)!;
  assert.equal(removal.selected, "required");
  assert.equal(
    removal.items.find((i) => i.value === "required").description,
    "current",
  );
});

test("Current setting choices remain visible after cursor movement and in non-TUI labels", async () => {
  for (const scenario of [
    {
      action: "project",
      answers: ["project", undefined, undefined],
      title: "Project Manager auto-start",
      current: "inherit",
    },
    {
      action: "merge",
      answers: ["repository", undefined, undefined],
      title: "Local branch integration · /repo",
      current: "inherit",
    },
    {
      action: "merge",
      answers: ["global", undefined, undefined],
      title: "Global Manager local merge",
      current: "off",
    },
    {
      action: "sessions",
      answers: ["default-lead-execution", undefined, undefined],
      title: "Default Lead execution",
      current: "flexible",
    },
    {
      action: "sessions",
      answers: ["max-agent-depth", undefined, undefined],
      title: "Max Agent depth",
      current: "default",
    },
    {
      action: "manager",
      answers: ["manager-git-bootstrap-confirmation", undefined, undefined],
      title: "Manager Git setup prompt",
      current: "required",
    },
    {
      action: "interface",
      answers: ["status-widget-rows", undefined, undefined],
      title: "Status widget rows",
      current: "default",
    },
    {
      action: "limits",
      answers: ["inlineAttachmentLimitBytes", undefined, undefined],
      title: "Limit",
      current: "4096",
    },
  ]) {
    const answers = [...scenario.answers];
    let found = false;
    const runtime = createLeadCommandRuntime({
      readConfig,
      readProjectOverrides: () => ({}),
      placementSettings: async () => ({ effective: "tab" }),
      messageLimits: async () => ({
        inline: { bytes: 4096 },
        mailbox: { bytes: 16384 },
      }),
      formatMessageLimit: (bytes: number) => String(bytes),
      getRemovalPreauthorization: async () => ({
        repoKey: "/repo",
        enabled: false,
        identity: {},
      }),
      selectMenu: async (
        _ctx: unknown,
        title: string,
        items: any[],
        selected: string,
      ) => {
        if (title === scenario.title) {
          found = true;
          assert.equal(selected, scenario.current);
          const current = items.find((item) => item.value === scenario.current);
          // The non-TUI selector concatenates label and description, independent of cursor.
          assert.match(
            `${current.label}  ${current.description ?? ""}`,
            /current/,
          );
        }
        return answers.shift();
      },
    } as any);
    const ctx = {
      isProjectTrusted: () => true,
      ui: { notify: () => undefined },
    } as any;
    if (scenario.action === "project")
      await runtime.openProjectSetting(ctx, "autoActivateManager");
    else if (scenario.action === "merge") await runtime.openMergeSetting(ctx);
    else if (scenario.action === "limits")
      await runtime.openMessageLimitsMenu(ctx);
    else await runtime.openSettingsCategory(ctx, scenario.action);
    assert.equal(found, true, scenario.title);
  }
});

test("Herdsman role menus dispatch shared role commands", async () => {
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
          role === "manager" ? "Project overview" : "Overview",
          role === "manager" ? "Refresh Manager profile" : "Refresh profile",
          `Leave ${role === "manager" ? "Manager" : "Chief"} mode`,
        ],
      },
      {
        active: true,
        action: "refresh",
        labels: [
          role === "manager" ? "Project overview" : "Overview",
          role === "manager" ? "Refresh Manager profile" : "Refresh profile",
          `Leave ${role === "manager" ? "Manager" : "Chief"} mode`,
        ],
      },
      {
        active: true,
        action: "leave",
        labels: [
          role === "manager" ? "Project overview" : "Overview",
          role === "manager" ? "Refresh Manager profile" : "Refresh profile",
          `Leave ${role === "manager" ? "Manager" : "Chief"} mode`,
        ],
      },
    ]) {
      const dispatched: [string, boolean][] = [];
      const menus: { title: string; labels: string[] }[] = [];
      const overviews: string[] = [];
      let rootSelection = true;
      let roleSelection = true;
      const host = {
        version: packageMetadata.version,
        isLead: () => !scenario.active,
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
            return role === "manager" ? "manager" : "chief";
          }
          if (!roleSelection) return undefined;
          roleSelection = false;
          return scenario.action;
        },
      } as any;
      const runtime = createLeadCommandRuntime(host);
      const notices: string[] = [];
      await runtime.runHerdsmanCommand("", {
        hasUI: true,
        ui: { notify: (message: string) => notices.push(message) },
      } as any);
      const title = role === "manager" ? "Project management" : "Chief mode";
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
            : scenario.action === "refresh"
              ? [[role, false]]
              : [],
      );
      assert.deepEqual(overviews, scenario.action === "overview" ? [role] : []);
      assert.deepEqual(
        notices,
        scenario.action === "overview" ? [] : ["transition requested"],
      );
    }
  }
});

test("role overview bypasses the idle-gated refresh and invalid commands do nothing", async () => {
  for (const role of ["manager", "chief"] as const) {
    let active = true;
    let transitions = 0;
    let overviews = 0;
    let release!: () => void;
    const idle = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notices: [string, string | undefined][] = [];
    const runtime = createLeadCommandRuntime({
      roleActive: () => active,
      transitionRole: async () => {
        transitions++;
        await idle;
        return "refreshed";
      },
      openSupervisionOverview: async () => {
        overviews++;
      },
    } as any);
    const ctx = {
      ui: {
        notify: (message: string, level?: string) =>
          notices.push([message, level]),
      },
    } as any;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        runtime.runRoleCommand(role, "", ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("overview waited for idle")),
            1000,
          );
        }),
      ]);
      assert.equal(overviews, 1);
      assert.equal(transitions, 0);
      const refresh = runtime.runRoleCommand(role, "refresh", ctx);
      assert.equal(transitions, 1);
      release();
      await refresh;
    } finally {
      clearTimeout(timer);
      release();
    }
    assert.deepEqual(notices.splice(0), [["refreshed", undefined]]);
    active = false;
    await runtime.runRoleCommand(role, "refresh", ctx);
    for (const args of ["unknown", "refresh extra", "leave extra"]) {
      await runtime.runRoleCommand(role, args, ctx);
    }
    assert.equal(transitions, 1);
    assert.equal(overviews, 1);
    assert.deepEqual(notices, [
      [`/${role} refresh requires active ${role} mode`, "error"],
      ...Array.from({ length: 3 }, () => [
        `Usage: /${role} [refresh|leave]`,
        "error",
      ]),
    ]);
  }
});

test("Settings categories expose only canonical entries and unavailable repository state", async () => {
  const seen: Record<string, any[]> = {};
  const runtime = createLeadCommandRuntime({
    readConfig,
    placementSettings: async () => ({ effective: "tab" }),
    getRemovalPreauthorization: async () => {
      throw new Error("No verified repository");
    },
    selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
      seen[title] = items;
      return undefined;
    },
  } as any);
  const ctx = { isProjectTrusted: () => false } as any;
  for (const category of ["sessions", "manager", "interface", "communication"])
    await runtime.openSettingsCategory(ctx, category);
  assert.deepEqual(
    seen["Sessions & agents"]!.map((i) => i.value),
    [
      "default-lead-execution",
      "context-retirement",
      "max-agent-depth",
      "message-limits",
    ],
  );
  assert.deepEqual(
    seen["Manager & repositories"]!.map((i) => i.value),
    [
      "auto-activate-manager",
      "manager-git-bootstrap-confirmation",
      "manager-merge",
      "removal-confirmation",
    ],
  );
  assert.deepEqual(
    seen.Interface!.map((i) => i.value),
    ["agent-layout", "status-widget-rows"],
  );
  assert.deepEqual(
    seen.Communication!.map((i) => i.value),
    ["peer-communication", "peer-federation"],
  );
  assert.equal(
    seen["Manager & repositories"]!.find(
      (i) => i.value === "removal-confirmation",
    ).description,
    "Repository unavailable",
  );
});

test("Delegate Agents to other directories (cwd) shows the current choice and persists globally", async () => {
  const config = { ...readConfig(), allowAgentCwdOverride: false };
  const writes: unknown[][] = [];
  const notices: string[] = [];
  const attempts = ["off", "on", "off", undefined];
  const runtime = createLeadCommandRuntime({
    readConfig: () => ({ ...config }),
    updateConfig: (key: string, value: boolean) => {
      writes.push([key, value]);
      config.allowAgentCwdOverride = value;
    },
    selectMenu: async (
      _ctx: unknown,
      title: string,
      items: {
        value: string;
        label: string;
        description?: string;
        help?: string;
      }[],
      selected: string,
    ) => {
      if (title === "Delegation options") {
        assert.deepEqual(
          items.map((item) => item.value),
          ["cwd-override"],
        );
        assert.equal(selected, "cwd-override");
        assert.equal(
          items[0]?.label,
          "Delegate Agents to other directories (cwd)",
        );
        assert.equal(
          items[0]?.description,
          config.allowAgentCwdOverride ? "On" : "Off",
        );
        assert.equal(
          items[0]?.help,
          "Allow Leads to specify a different working directory using the optional cwd parameter in delegate_agent. Without it, Agents start in the Lead's current directory. Global setting. Run /reload after changing it. Cross-directory delegation is limited to ordinary Leads.",
        );
        return attempts.length ? "cwd-override" : undefined;
      }
      assert.equal(title, "Delegate Agents to other directories (cwd)");
      assert.deepEqual(
        items.map((item) => item.label),
        ["Off", "On"],
      );
      assert.equal(selected, config.allowAgentCwdOverride ? "on" : "off");
      assert.equal(
        items.find((item) => item.value === selected)?.description,
        "current",
      );
      return attempts.shift();
    },
  } as any);
  await runtime.openSettingsCategory(
    {
      isProjectTrusted: () => false,
      ui: { notify: (message: string) => notices.push(message) },
    } as any,
    "delegation",
  );
  assert.deepEqual(writes, [
    ["allowAgentCwdOverride", true],
    ["allowAgentCwdOverride", false],
  ]);
  assert.equal(notices.length, writes.length);
  for (const notice of notices)
    assert.equal(notice, "Run /reload after changing it.");
});

test("Communication settings preserve the federation preference while inactive", async () => {
  const config = {
    ...readConfig(),
    peerCommunicationEnabled: true,
    peerFederationEnabled: true,
  };
  const descriptions: string[][] = [];
  const notices: string[] = [];
  const writes: [keyof typeof config, boolean][] = [];
  const answers = [
    "peer-communication",
    "off",
    "peer-federation",
    "peer-communication",
    "on",
    "peer-federation",
    "off",
    undefined,
  ];
  const runtime = createLeadCommandRuntime({
    readConfig: () => ({ ...config }),
    updateConfig: (
      key: "peerCommunicationEnabled" | "peerFederationEnabled",
      value: boolean,
    ) => {
      writes.push([key, value]);
      config[key] = value;
    },
    selectMenu: async (
      _ctx: unknown,
      title: string,
      items: { description: string }[],
    ) => {
      if (title === "Communication")
        descriptions.push(items.map((item) => item.description));
      return answers.shift();
    },
  } as any);
  await runtime.openSettingsCategory(
    {
      isProjectTrusted: () => false,
      ui: { notify: (message: string) => notices.push(message) },
    } as any,
    "communication",
  );
  assert.deepEqual(descriptions, [
    ["On", "On"],
    ["Off", "On (inactive)"],
    ["Off", "On (inactive)"],
    ["On", "On"],
    ["On", "Off"],
  ]);
  assert.deepEqual(writes, [
    ["peerCommunicationEnabled", false],
    ["peerCommunicationEnabled", true],
    ["peerFederationEnabled", false],
  ]);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /inactive while peer communication is off/);
});

test("Project setting combines scopes and skips unchanged values", async () => {
  const config = { ...readConfig(), autoActivateManager: true };
  const overrides: { autoActivateManager?: boolean } = {};
  const writes: unknown[] = [];
  const answers = [
    "project",
    "off",
    "project",
    "off",
    "project",
    "inherit",
    undefined,
  ];
  const selections: (string | undefined)[] = [];
  const runtime = createLeadCommandRuntime({
    readConfig: () => config,
    readProjectOverrides: () => ({ ...overrides }),
    updateProjectOverride: (
      _ctx: unknown,
      _key: string,
      value: boolean | undefined,
    ) => {
      writes.push(value);
      if (value === undefined) delete overrides.autoActivateManager;
      else overrides.autoActivateManager = value;
    },
    selectMenu: async (
      _ctx: unknown,
      _title: string,
      _items: unknown,
      selected: string,
    ) => {
      selections.push(selected);
      return answers.shift();
    },
  } as any);
  await runtime.openProjectSetting(
    { isProjectTrusted: () => true, ui: { notify: () => undefined } } as any,
    "autoActivateManager",
  );
  assert.deepEqual(writes, [false, undefined]);
  assert.equal(selections[2], "project");
  assert.equal(config.autoActivateManager, true);
});

test("Removal selector passes verified identity and avoids unchanged writes", async () => {
  const identity = { repository: "verified" };
  let writes = 0;
  let choice = "required";
  const runtime = createLeadCommandRuntime({
    getRemovalPreauthorization: async () => ({
      repoKey: "/verified/repository",
      identity,
      enabled: false,
    }),
    setRemovalPreauthorization: async (
      value: boolean,
      _ctx: unknown,
      expected: unknown,
    ) => {
      assert.equal(value, true);
      assert.equal(expected, identity);
      writes++;
      return true;
    },
    selectMenu: async (
      _ctx: unknown,
      title: string,
      _items: unknown,
      selected: string,
    ) => {
      assert.match(title, /\/verified\/repository/);
      assert.equal(selected, "required");
      return choice;
    },
  } as any);
  const ctx = { ui: { notify: () => undefined } } as any;
  await runtime.openRemovalSetting(ctx);
  assert.equal(writes, 0);
  choice = "skip";
  await runtime.openRemovalSetting(ctx);
  assert.equal(writes, 1);
});

test("Git setup selector confirms new skip and revokes without confirmation", async () => {
  for (const [initial, choice, accepted, expected, confirms] of [
    [false, "skip", false, undefined, 1],
    [false, "skip", true, true, 1],
    [true, "required", false, false, 0],
  ] as const) {
    let selection = 0;
    let confirmations = 0;
    let written: boolean | undefined;
    const runtime = createLeadCommandRuntime({
      readConfig: () => ({
        ...readConfig(),
        managerGitBootstrapWithoutConfirmation: initial,
      }),
      placementSettings: async () => ({ effective: "tab" }),
      updateConfig: (_key: string, value: boolean) => {
        written = value;
      },
      selectMenu: async (_ctx: unknown, title: string) =>
        title === "Manager & repositories"
          ? selection++
            ? undefined
            : "manager-git-bootstrap-confirmation"
          : choice,
    } as any);
    await runtime.openSettingsCategory(
      {
        isProjectTrusted: () => false,
        ui: {
          confirm: async () => {
            confirmations++;
            return accepted;
          },
          notify: () => undefined,
        },
      } as any,
      "manager",
    );
    assert.equal(confirmations, confirms);
    assert.equal(written, expected);
  }
});

test("Global integration confirms increases and rejects stale changes", async () => {
  for (const during of ["selection", "confirmation"] as const) {
    let current: false | true | "divergent" = false;
    let scopeCalls = 0;
    let confirms = 0;
    const writes: unknown[] = [];
    const notices: string[] = [];
    const runtime = createLeadCommandRuntime({
      readConfig: () => ({ ...readConfig(), managerMergeEnabled: current }),
      getRemovalPreauthorization: async () => {
        throw new Error("unavailable");
      },
      selectMenu: async (_ctx: unknown, title: string) => {
        if (title === "Local branch integration")
          return scopeCalls++ ? undefined : "global";
        if (during === "selection") current = true;
        return "divergent";
      },
      updateConfig: (_key: string, value: unknown) => writes.push(value),
    } as any);
    await runtime.openMergeSetting({
      ui: {
        notify: (m: string) => notices.push(m),
        confirm: async () => {
          confirms++;
          if (during === "confirmation") current = true;
          return true;
        },
      },
    } as any);
    assert.equal(confirms, 1);
    assert.deepEqual(writes, []);
    assert.match(notices[0]!, /policy changed/);
  }
});

test("Global integration preserves locked compare-and-set and no-op", async () => {
  let scopeCalls = 0;
  const writes: unknown[] = [];
  const notices: string[] = [];
  const runtime = createLeadCommandRuntime({
    readConfig: () => ({ ...readConfig(), managerMergeEnabled: true }),
    getRemovalPreauthorization: async () => {
      throw new Error("unavailable");
    },
    selectMenu: async (_ctx: unknown, title: string) =>
      title === "Local branch integration"
        ? scopeCalls++ < 2
          ? "global"
          : undefined
        : scopeCalls === 1
          ? "fast-forward"
          : "off",
    updateConfig: (_key: string, value: unknown, expected: unknown) => {
      writes.push([value, expected]);
      throw new Error("policy changed; reopen");
    },
  } as any);
  await runtime.openMergeSetting({
    ui: { notify: (m: string) => notices.push(m) },
  } as any);
  assert.deepEqual(writes, [[false, true]]);
  assert.match(notices[0]!, /policy changed/);
});

test("Repository integration delegates inheritance and explicit grants to guarded setter", async () => {
  for (const [override, choice] of [
    [false, "inherit"],
    [undefined, "divergent"],
  ] as const) {
    const identity = { verified: true };
    const writes: unknown[] = [];
    const config = {
      ...readConfig(),
      managerMergeEnabled: "divergent" as const,
      managerMergeOverrides:
        override === undefined ? {} : { "/repo": override },
    };
    const answers = ["repository", choice, undefined];
    const runtime = createLeadCommandRuntime({
      readConfig: () => config,
      getRemovalPreauthorization: async () => ({
        repoKey: "/repo",
        enabled: false,
        identity,
      }),
      selectMenu: async () => answers.shift(),
      setRepositoryMergeOverride: async (...args: unknown[]) => {
        writes.push(args);
        return false;
      },
    } as any);
    const ctx = { ui: { notify: () => undefined } } as any;
    await runtime.openMergeSetting(ctx);
    assert.deepEqual(writes, [
      [
        choice === "inherit" ? undefined : "divergent",
        ctx,
        identity,
        { global: "divergent", override },
      ],
    ]);
  }
});

test("Repository merge errors are reported and unchanged overrides are not written", async () => {
  const answers = ["repository", "off", "repository", "inherit", undefined];
  const notices: string[] = [];
  let writes = 0;
  const runtime = createLeadCommandRuntime({
    readConfig: () => ({
      ...readConfig(),
      managerMergeEnabled: true,
      managerMergeOverrides: { "/repo": false },
    }),
    getRemovalPreauthorization: async () => ({
      repoKey: "/repo",
      enabled: false,
      identity: {},
    }),
    selectMenu: async () => answers.shift(),
    setRepositoryMergeOverride: async () => {
      writes++;
      throw new Error("Repository or session changed; reopen the selector");
    },
  } as any);
  await runtime.openMergeSetting({
    ui: { notify: (message: string) => notices.push(message) },
  } as any);
  assert.equal(writes, 1);
  assert.match(notices[0]!, /changed; reopen/);
});

test("Invalid and untrusted project settings leave global editing available", async () => {
  for (const trusted of [true, false]) {
    const answers = ["project", "global", "off", undefined];
    const notices: string[] = [];
    const writes: unknown[] = [];
    const runtime = createLeadCommandRuntime({
      readConfig: () => ({ ...readConfig(), autoActivateManager: true }),
      readProjectOverrides: () => {
        throw new Error("malformed");
      },
      updateConfig: (_key: string, value: unknown) => writes.push(value),
      selectMenu: async () => answers.shift(),
    } as any);
    await runtime.openProjectSetting(
      {
        isProjectTrusted: () => trusted,
        ui: { notify: (m: string) => notices.push(m) },
      } as any,
      "autoActivateManager",
    );
    assert.deepEqual(writes, [false]);
    assert.match(notices[0]!, trusted ? /unavailable/ : /not trusted/);
  }
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

test("ordinary Agent Details order native and appended context by launch mode", async () => {
  for (const scenario of [
    {
      name: "native",
      frontmatter: {
        inheritGlobalContext: true,
        inheritAncestorContext: true,
        inheritProjectContext: true,
      },
      expected: [
        "Pi native context: global, ancestor, project",
        "definition body",
        "Herdsman shared guidance",
        "context sentinel",
      ],
    },
    {
      name: "selective",
      frontmatter: {
        inheritGlobalContext: false,
        inheritAncestorContext: true,
        inheritProjectContext: true,
      },
      expected: [
        "definition body",
        "context sentinel",
        "Herdsman shared guidance",
      ],
    },
    {
      name: "global and project but not ancestor",
      frontmatter: {
        inheritGlobalContext: true,
        inheritAncestorContext: false,
        inheritProjectContext: true,
      },
      expected: [
        "Selected Pi context: global, project",
        "definition body",
        "context sentinel",
      ],
    },
    {
      name: "empty first source",
      frontmatter: {
        inheritGlobalContext: true,
        inheritAncestorContext: true,
        inheritProjectContext: true,
      },
      expected: ["definition body"],
      emptyFirstFragment: true,
    },
    {
      name: "all fragments empty",
      frontmatter: {
        inheritGlobalContext: true,
        inheritAncestorContext: true,
        inheritProjectContext: true,
      },
      expected: [],
      emptyFirstFragment: true,
      allFragmentsEmpty: true,
    },
    {
      name: "multiple definition layer changes",
      frontmatter: {
        inheritGlobalContext: true,
        inheritAncestorContext: true,
        inheritProjectContext: true,
      },
      expected: ["definition body"],
      layers: [
        {
          scope: "global",
          path: "/reviewer.md",
          supplied: { description: "Updated", model: "new-model" },
          before: { description: "Original", model: "old-model" },
          after: { description: "Updated", model: "new-model" },
          body: "definition body",
          bodyAction: "inherit",
        },
      ],
    },
  ]) {
    const choices = ["agents", "reviewer", "details", undefined, undefined];
    let displayed: string[] | undefined;
    let inspectedSections: any[] | undefined;
    const notices: string[] = [];
    const definition = {
      name: "reviewer",
      path: "/reviewer.md",
      extensionSource: "/reviewer.md",
      frontmatter: { name: "reviewer", ...scenario.frontmatter },
      body: "definition body",
    };
    const runtime = createLeadCommandRuntime({
      selectMenu: async () => choices.shift(),
      getThinkingLevel: () => "high",
      agentDefinitionEnabled: () => true,
      contextAgentDefinitions: async () => ({ definitions: [definition] }),
      inspectAgentDefinition: () => ({
        definition,
        layers:
          scenario.layers ??
          (scenario.emptyFirstFragment
            ? [
                {
                  scope: "global",
                  path: "/reviewer.md",
                  supplied: {},
                  after: {},
                  body: "",
                  bodyAction: "append",
                },
              ]
            : []),
        bodyFragments: scenario.emptyFirstFragment
          ? [
              { path: "/empty.md", scope: "global", body: "@empty.md" },
              {
                path: "/reviewer.md",
                scope: "global",
                body: "definition body",
              },
            ]
          : [
              {
                path: "/reviewer.md",
                scope: "global",
                body: "definition body",
              },
            ],
      }),
      expandDefinitionBodyFragments: () =>
        scenario.allFragmentsEmpty
          ? ["", ""]
          : scenario.emptyFirstFragment
            ? ["", "definition body"]
            : ["definition body"],
      selectedAgentContextFiles: () => [
        { path: "/workspace/AGENTS.md", content: "context sentinel" },
      ],
      leadExecutionPresentation: () => ({ managed: false, mode: "flexible" }),
      roleActive: () => false,
      isCurrentChief: () => false,
      agentDefinitionMetadata: () => ({ name: "reviewer" }),
      formatAgentDefinitions: () => ["reviewer"],
      appendDefinitionsEntry: (data: any) => {
        inspectedSections = data.inspector.sections;
        displayed = [
          ...data.inspector.summary,
          ...data.inspector.sections.flatMap((section: any) =>
            [
              section.title,
              section.source,
              ...(section.changes ?? []),
              section.content,
            ].filter(Boolean),
          ),
        ];
      },
    } as any);
    await runtime.openDefinitionsMenu({
      mode: "tui",
      cwd: "/workspace",
      isProjectTrusted: () => true,
      ui: { notify: (message: string) => notices.push(message) },
    } as any);
    assert.ok(displayed, notices.join("\n"));
    const prompt = displayed!.join("\n");
    const positions = scenario.expected.map((item) => prompt.indexOf(item));
    assert.ok(
      positions.every((position) => position >= 0),
      prompt,
    );
    assert.deepEqual(
      positions,
      [...positions].sort((a, b) => a - b),
      prompt,
    );
    if (scenario.allFragmentsEmpty) {
      const fallback = inspectedSections!.find(
        (section) => section.changes?.length,
      );
      assert.ok(fallback, JSON.stringify(inspectedSections));
      assert.equal(fallback.content, undefined);
      assert.equal(
        inspectedSections!.some((section) => section.content === ""),
        false,
      );
    } else if (scenario.layers) {
      const definitionSection = inspectedSections!.find(
        (section) => section.title === "Herdsman definition",
      );
      assert.deepEqual(definitionSection?.changes, [
        "global · reviewer.md",
        "  ~ description: Original → Updated",
        "  ~ model: old-model → new-model",
      ]);
    } else if (scenario.emptyFirstFragment) {
      const firstVisible = inspectedSections!.find(
        (section) => section.content === "definition body",
      );
      assert.ok(firstVisible, JSON.stringify(inspectedSections));
      assert.ok(
        firstVisible.changes?.length,
        JSON.stringify(inspectedSections),
      );
      assert.equal(
        inspectedSections!.some((section) => section.content === ""),
        false,
      );
    }
  }
});

test("inactive Managed Lead Details include Working directory exactly once", async () => {
  const choices = ["roles", "managed-lead", "details", undefined, undefined];
  let details: any;
  let selectedCwd: string | undefined;
  const definition = {
    name: "managed-lead",
    path: "/managed-lead.md",
    frontmatter: {
      name: "managed-lead",
      inheritGlobalContext: false,
      inheritAncestorContext: false,
      inheritProjectContext: true,
    },
    body: "Managed Lead instructions",
  };
  const runtime = createLeadCommandRuntime({
    selectMenu: async () => choices.shift(),
    getThinkingLevel: () => "high",
    agentDefinitionEnabled: () => true,
    getSystemPromptOptions: () => ({ contextFiles: [] }),
    inspectRoleDefinition: () => ({
      definition,
      layers: [],
      bodyFragments: [
        { path: definition.path, scope: "bundled", body: definition.body },
      ],
    }),
    expandDefinitionBodyFragments: (fragments: Array<{ body: string }>) =>
      fragments.map(({ body }) => body),
    roleActive: () => false,
    isCurrentChief: () => false,
    leadExecutionPresentation: () => ({ managed: false, mode: "flexible" }),
    selectedAgentContextFiles: (_definition: unknown, cwd: string) => {
      selectedCwd = cwd;
      return [{ path: "/workspace/AGENTS.md", content: "project context" }];
    },
    agentDefinitionMetadata: () => ({ name: "managed-lead" }),
    formatAgentDefinitions: () => ["Managed Lead metadata"],
    appendDefinitionsEntry: (data: any) => {
      details = data;
    },
  } as any);
  await runtime.openDefinitionsMenu({
    mode: "tui",
    cwd: "/workspace",
    isProjectTrusted: () => true,
    ui: { notify: () => undefined },
  } as any);

  assert.ok(
    details,
    "Details should be appended for the prospective Managed Lead",
  );
  assert.equal(selectedCwd, "/workspace");
  assert.match(
    details.inspector.summary.join("\n"),
    /Preview cwd: \/workspace/u,
  );
  assert.match(
    details.inspector.summary.join("\n"),
    /Selected Pi context: project/u,
  );
  assert.ok(
    details.inspector.sections.some(
      (section: any) =>
        section.title === "Pi context" &&
        section.source === "/workspace/AGENTS.md",
    ),
  );
  assert.equal(
    details.inspector.sections.filter(
      (section: any) => section.title === "Working directory",
    ).length,
    1,
  );
  assert.equal(
    details.inspector.sections.some(
      (section: any) => section.title === "Preview limitation",
    ),
    false,
  );
  assert.match(
    details.inspector.summary.join("\n"),
    /Known-input preview only/u,
  );
});

test("Coordinator Details show current prompt inputs in composition order", async () => {
  const choices = ["roles", "manager", "details", undefined, undefined];
  const menus: { title: string; value?: string }[] = [];
  let displayed: string[] | undefined;
  const runtime = createLeadCommandRuntime({
    selectMenu: async (_ctx: unknown, title: string) => {
      const value = choices.shift();
      menus.push({ title, value });
      return value;
    },
    getThinkingLevel: () => "high",
    agentDefinitionEnabled: () => true,
    getSystemPromptOptions: () => ({
      contextFiles: [
        { path: "/workspace/AGENTS.md", content: "Current project context" },
      ],
    }),
    inspectRoleDefinition: () => ({
      definition: {
        name: "manager",
        path: "/profile.md",
        frontmatter: { name: "manager" },
        body: "Manager profile",
      },
      layers: [],
      bodyFragments: [],
    }),
    expandDefinitionBodyFragments: () => [],
    roleActive: (role: string) => role === "manager",
    isCurrentChief: () => false,
    roleCharter: () => "Verified manager contract",
    leadExecutionPresentation: () => ({
      managed: false,
      mode: "flexible",
    }),
    leadExecutionDefinition: () => undefined,
    executionPrompt: () => undefined,
    selectedAgentContextFiles: () => [],
    agentDefinitionMetadata: () => ({ name: "manager" }),
    formatAgentDefinitions: () => ["Manager metadata"],
    appendDefinitionsEntry: (data: any) => {
      displayed = [
        ...data.inspector.summary,
        ...data.inspector.sections.flatMap((section: any) =>
          [
            section.title,
            section.source,
            ...(section.changes ?? []),
            section.content,
          ].filter(Boolean),
        ),
      ];
    },
  } as any);
  await runtime.openDefinitionsMenu({
    mode: "tui",
    cwd: "/workspace",
    isProjectTrusted: () => true,
    ui: { notify: () => undefined },
  } as any);
  assert.deepEqual(
    menus.slice(0, 3).map(({ value }) => value),
    ["roles", "manager", "details"],
  );
  const lines = displayed!.join("\n");
  const base = lines.indexOf("Pi base prompt");
  const context = lines.indexOf("Current project context");
  const contract = lines.indexOf("Verified manager contract");
  const profile = lines.indexOf("Effective Manager profile on disk");
  const cwd = lines.indexOf("Working directory");
  const runtimeSection = lines.indexOf("Runtime contributions");
  assert.ok(base >= 0 && base < context);
  assert.ok(cwd >= 0 && cwd < contract && contract < profile);
  assert.ok(profile < runtimeSection);
  assert.match(lines, /active-session inputs/u);
});

test("Chief Details use the forced prompt producer with global-only context", async () => {
  const { chiefGlobalInstructions, chiefSystemPrompt } =
    await import("../chief-prompt.ts");
  const choices = ["roles", "chief", "details", undefined, undefined];
  let displayed: string[] | undefined;
  const promptOptions = {
    contextFiles: [
      {
        path: "/home/user/.pi/agent/AGENTS.md",
        content: "Global user instruction sentinel",
      },
      {
        path: "/workspace/AGENTS.md",
        content: "Project context sentinel must be excluded",
      },
    ],
  };
  const runtime = createLeadCommandRuntime({
    selectMenu: async () => choices.shift(),
    getThinkingLevel: () => "high",
    agentDefinitionEnabled: () => true,
    getSystemPromptOptions: () => promptOptions,
    inspectRoleDefinition: () => ({
      definition: {
        name: "chief",
        path: "/profile.md",
        frontmatter: { name: "chief" },
        body: "Chief profile sentinel",
      },
      layers: [],
      bodyFragments: [
        {
          path: "/profile.md",
          scope: "bundled",
          body: "Chief profile sentinel",
        },
      ],
    }),
    expandDefinitionBodyFragments: (fragments: Array<{ body: string }>) =>
      fragments.map(({ body }) => body),
    roleActive: () => false,
    isCurrentChief: () => false,
    chiefGlobalInstructions: (options: typeof promptOptions) =>
      chiefGlobalInstructions(options, "/home/user/.pi/agent"),
    chiefSystemPrompt: (options: typeof promptOptions, body: string) =>
      chiefSystemPrompt(
        options,
        body,
        "Chief role contract sentinel",
        "/home/user/.pi/agent",
      ),
    leadExecutionPresentation: () => ({
      managed: false,
      mode: "flexible",
    }),
    leadExecutionDefinition: () => undefined,
    executionPrompt: () => undefined,
    selectedAgentContextFiles: () => [],
    agentDefinitionMetadata: () => ({ name: "chief" }),
    formatAgentDefinitions: () => ["Chief metadata"],
    appendDefinitionsEntry: (data: any) => {
      displayed = [
        ...data.inspector.summary,
        ...data.inspector.sections.flatMap((section: any) =>
          [
            section.title,
            section.source,
            ...(section.changes ?? []),
            section.content,
          ].filter(Boolean),
        ),
      ];
    },
  } as any);
  await runtime.openDefinitionsMenu({
    mode: "tui",
    cwd: "/workspace",
    isProjectTrusted: () => true,
    ui: { notify: () => undefined },
  } as any);

  const details = displayed!.join("\n");
  assert.match(details, /Prospective Chief forced prompt/u);
  assert.match(details, /Global user instruction sentinel/u);
  assert.doesNotMatch(details, /Project context sentinel/u);
  assert.match(details, /project context excluded/u);
  assert.ok(
    details.indexOf("Chief role contract sentinel") <
      details.indexOf("Chief profile sentinel"),
  );
  assert.ok(
    details.indexOf("Chief profile sentinel") <
      details.indexOf("Global user instruction sentinel"),
  );
});

test("Definitions lists and displays misplaced-definition warnings without editing them", async () => {
  const first = { name: "first", frontmatter: { name: "first" } } as any;
  const warning =
    "/agent/agents/manager.md: definition belongs in /agent/coordinators/manager.md; file excluded from discovery";
  const menus: { title: string; items: any[] }[] = [];
  const notices: [string, string | undefined][] = [];
  const results = ["agents", "__definition_warnings__", undefined, undefined];
  const runtime = createLeadCommandRuntime({
    contextAgentDefinitions: async (
      _ctx: unknown,
      onWarning?: (message: string) => void,
    ) => {
      onWarning?.(warning);
      return {
        definitions: [first],
        roleDefinitions: [],
        projectTrusted: true,
      };
    },
    selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
      menus.push({ title, items });
      return results.shift();
    },
    agentDefinitionEnabled: () => true,
    getThinkingLevel: () => "high",
  } as any);
  await runtime.openDefinitionsMenu({
    isProjectTrusted: () => false,
    ui: {
      notify: (message: string, level?: string) =>
        notices.push([message, level]),
    },
  } as any);
  const list = menus.find(({ title }) => title === "Agents")!;
  assert.deepEqual(
    list.items.map(({ value }) => value),
    ["__definition_warnings__", "first"],
  );
  assert.match(list.items[0].label, /1 misplaced definition/u);
  assert.equal(list.items[0].help, warning);
  assert.deepEqual(notices, [[warning, "warning"]]);
  assert.equal(
    menus.some(({ title }) => title === "Agent: first"),
    false,
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
      withQuiescedTree: async (
        _ctx: unknown,
        owner: string,
        workspace: string,
        operation: (held: ReadonlySet<string>) => Promise<unknown>,
      ) => {
        const release = claimDelegationLock(workspace, owner);
        try {
          return await operation(new Set([`${workspace}\0${owner}`]));
        } finally {
          release();
        }
      },
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
      withQuiescedTree: async (
        _ctx: unknown,
        owner: string,
        workspace: string,
        operation: (held: ReadonlySet<string>) => Promise<unknown>,
      ) => {
        const release = claimDelegationLock(workspace, owner);
        try {
          return await operation(new Set([`${workspace}\0${owner}`]));
        } finally {
          release();
        }
      },
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

test("lead stop-all empty recheck sees only the Lead-owned root tree", async () => {
  const ownerSessionId = fakeContext().sessionManager.getSessionId();
  const makeAgent = (
    agentLabel: string,
    workspaceId: string,
    owner: string,
    piSessionId: string,
  ) =>
    ({
      state: { agentLabel, workspaceId, ownerSessionId: owner, piSessionId },
    }) as any;
  const ownedRoot = makeAgent("owned-root", WORKSPACE, ownerSessionId, "owned");
  const ownedChild = makeAgent("owned-child", WORKSPACE, "owned", "child");
  const unrelatedRoot = makeAgent(
    "unrelated-root",
    "other-workspace",
    "other",
    "other",
  );
  const unrelatedChild = makeAgent(
    "unrelated-child",
    "other-workspace",
    "other",
    "other-child",
  );

  for (const scenario of [
    {
      agents: [ownedRoot, ownedChild, unrelatedRoot, unrelatedChild],
      visible: ["owned-root", "owned-child"],
      summary: "Agent state changed; reopen Stop all.",
    },
    {
      agents: [unrelatedRoot, unrelatedChild],
      visible: [],
      summary: "No owned agents running.",
    },
  ]) {
    const context = fakeContext() as any;
    context.hasUI = true;
    const notices: string[] = [];
    const summaries: string[] = [];
    const runtime = createLeadCommandRuntime({
      loadStatusSnapshot: async () => ({ agents: [] }),
      controller: {
        workspaceId: () => WORKSPACE,
        sessionSignal: () => new AbortController().signal,
        withQuiescedTree: async (
          _ctx: unknown,
          _owner: string,
          _workspace: string,
          operation: (held: ReadonlySet<string>) => Promise<unknown>,
        ) => operation(new Set()),
        agentSnapshotView: async (_ctx: unknown, scope: { kind: "root" }) => {
          const visible = visibleAgentSnapshots(
            { agents: scenario.agents },
            scope,
            ownerSessionId,
          );
          assert.deepEqual(
            visible.map(({ state }) => state.agentLabel),
            scenario.visible,
          );
          return { stateIssues: [], visible };
        },
      },
      presentStopSummary: (summary: string) => summaries.push(summary),
    } as any);
    context.ui.notify = (message: string) => notices.push(message);

    await runtime.confirmAndStopAll(context);
    assert.deepEqual(
      notices,
      scenario.visible.length ? [scenario.summary] : [],
    );
    assert.deepEqual(
      summaries,
      scenario.visible.length ? [] : [scenario.summary],
    );
  }
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
        withQuiescedTree: async (
          _ctx: unknown,
          owner: string,
          workspace: string,
          operation: (held: ReadonlySet<string>) => Promise<unknown>,
        ) => {
          const release = claimDelegationLock(workspace, owner);
          try {
            return await operation(new Set([`${workspace}\0${owner}`]));
          } finally {
            release();
          }
        },
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
