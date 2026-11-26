import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claimDelegationLock,
  visibleAgentSnapshots,
} from "../agent-controller.ts";
import {
  DEFAULT_CONFIG,
  readConfig,
  updateConfig,
  validByteLimit,
  validMaxAgentDepth,
  validStatusWidgetMaxRows,
} from "../config.ts";
import { fakeContext, HERDSMAN_BUILD, WORKSPACE } from "../support.ts";
import { createLeadCommandRuntime } from "./commands.ts";
import { pickOverrideModels } from "./override-model-picker.ts";

const overridePickerModels = [
  { provider: "group/one", id: "first", name: "Alpha" },
  { provider: "group/one", id: "second", name: "Beta" },
  { provider: "other", id: "third", name: "Gamma" },
];

test("override picker filters, toggles, applies bulk shortcuts and saves or cancels", async () => {
  const configured = ["missing/model"];
  for (const save of [true, false]) {
    let refreshes = 0;
    const keyData: Record<string, string> = {
      "tui.select.up": "\u001b[A",
      "tui.select.down": "\u001b[B",
      "tui.select.confirm": "\r",
      "tui.select.cancel": "\u001b",
      "app.models.enableAll": "\u0001",
      "app.models.clearAll": "\u0018",
      "app.models.toggleProvider": "\u0010",
      "app.models.save": "\u0013",
    };
    const result = await pickOverrideModels(
      {
        mode: "tui",
        scopedModels: [],
        modelRegistry: {
          refresh: async () => {
            refreshes++;
          },
          getAvailable: () => overridePickerModels,
        },
        ui: {
          custom: async (factory: any) => {
            let result: string[] | undefined;
            const component = factory(
              { requestRender() {} },
              { fg: (_color: string, text: string) => text },
              {
                matches: (input: string, name: string) =>
                  input === keyData[name],
                getKeys: (name: string) => [name],
              },
              (value: string[] | undefined) => {
                result = value;
              },
            );
            const display = () => component.render(120).join("\n");
            assert.match(display(), /→ ✓ missing\/model \[unavailable\]/);
            component.handleInput("\u0001"); // Select available models, retaining unavailable selections.
            assert.match(display(), /3\/3 selected · 1 unavailable/);
            component.handleInput("\u0018"); // Clear all (including unavailable).
            assert.match(
              display(),
              /No custom models selected\. Pi scoped models will be used\./,
            );
            for (const char of "Alpha") component.handleInput(char);
            assert.match(display(), /→   first \(Alpha\) \[group\/one\]/);
            assert.doesNotMatch(display(), /second \(Beta\)/);
            component.handleInput("\u0001"); // Select filtered.
            assert.match(display(), /→ ✓ first \(Alpha\) \[group\/one\]/);
            component.handleInput("\u0018"); // Clear filtered.
            component.handleInput("\r"); // Toggle the sole match, not inheritance.
            assert.match(display(), /→ ✓ first/);
            component.handleInput("\u0010"); // Select entire provider despite filter.
            assert.match(display(), /2\/3 selected/);
            component.handleInput("\u0010"); // Clear entire provider.
            assert.match(display(), /No custom models selected/);
            for (let i = 0; i < 5; i++) component.handleInput("\u007f");
            component.handleInput("\u001b[B"); // Move past the unavailable row.
            component.handleInput("\u001b[B");
            assert.match(display(), /→   second \(Beta\) \[group\/one\]/);
            component.handleInput("\r");
            assert.match(
              display(),
              /missing\/model \[unavailable\][\s\S]*first \(Alpha\)[\s\S]*→ ✓ second \(Beta\)/,
            );
            component.handleInput(save ? "\u0013" : "\u001b");
            return result;
          },
        },
      } as any,
      configured,
      async () => assert.fail("unexpected fallback"),
    );
    assert.deepEqual(result, save ? ["group/one/second"] : undefined);
    assert.deepEqual(configured, ["missing/model"]);
    assert.equal(refreshes, 1);
  }
});

for (const mode of ["tui", "rpc"]) {
  test(`override picker previews and preserves Pi scope in ${mode}`, async () => {
    const [first, second, third] = overridePickerModels;
    const catalog = [
      third,
      first,
      second,
      ...Array.from({ length: 16 }, (_, index) => ({
        provider: "extra",
        id: "model-" + index,
        name: "model-" + index,
      })),
    ];
    const steps = {
      remove: { key: "\r", choice: "0" },
      inherit: { key: "\r", choice: "inherit" },
      save: { key: "\u0013", choice: "save" },
    };
    for (const { configured, actions, expected } of [
      { configured: [], actions: [steps.save], expected: undefined },
      {
        configured: ["group/one/first", "group/one/second"],
        actions: [steps.save],
        expected: undefined,
      },
      {
        configured: [],
        actions: [steps.remove, steps.save],
        expected: ["group/one/second"],
      },
      {
        configured: ["other/third"],
        actions: [steps.inherit, steps.save],
        expected: [],
      },
    ]) {
      const assertInherited = (display: string) => {
        assert.match(display, /Using Pi scoped models · 2\/19 selected/);
        assert.match(display, /✓ Use Pi scoped models/);
      };
      const assertSelectedFirst = (display: string) => {
        assert.match(
          display,
          /✓ Use Pi scoped models[\s\S]*✓ first \(Alpha\)[\s\S]*✓ second \(Beta\)[\s\S]*third \(Gamma\)/,
        );
      };
      const assertCustom = (display: string) => {
        assert.match(display, /Custom selection/);
        assert.doesNotMatch(display, /✓ Use Pi scoped models/);
      };
      let previous: (typeof steps)[keyof typeof steps] | undefined;
      const result = await pickOverrideModels(
        {
          mode,
          scopedModels: [{ model: first }, { model: second }],
          modelRegistry: {
            refresh: async () => {},
            getAvailable: () => catalog,
          },
          ui: {
            custom: async (factory: any) => {
              assert.equal(mode, "tui");
              const up = "\u001b[A";
              const down = "\u001b[B";
              const clear = "\u001bOQ"; // Pi's clear action is configured to F2.
              let result: string[] | undefined;
              const component = factory(
                { requestRender() {} },
                { fg: (_color: string, text: string) => text },
                {
                  matches: (input: string, name: string) =>
                    (input === steps.remove.key &&
                      name === "tui.select.confirm") ||
                    (input === steps.save.key && name === "app.models.save") ||
                    (input === up && name === "tui.select.up") ||
                    (input === down && name === "tui.select.down") ||
                    (input === clear && name === "app.models.clearAll"),
                  getKeys: (name: string) => [name],
                },
                (value: string[] | undefined) => {
                  result = value;
                },
              );
              const display = () => component.render(120).join("\n");
              if (!configured.length) {
                assertInherited(display());
                assertSelectedFirst(display());
                if (actions.length === 1) {
                  component.handleInput(up);
                  assert.match(display(), /→ ✓ Use Pi scoped models/);
                  component.handleInput(down);
                  assert.match(display(), /→ ✓ first/);
                  for (let i = 0; i < 9; i++) component.handleInput(down);
                  assert.match(display(), /→   model-6 \[extra\]/);
                  assert.doesNotMatch(display(), /first \(Alpha\)/);
                  assertInherited(display());
                }
              } else {
                assertCustom(display());
              }
              for (const action of actions) {
                if (action === steps.inherit) {
                  component.handleInput(clear);
                  assert.match(display(), /No custom models selected/);
                  component.handleInput("z");
                  assert.match(
                    display(),
                    /→   Use Pi scoped models[\s\S]*No matching models/,
                  );
                }
                component.handleInput(action.key);
                if (action === steps.inherit) assertInherited(display());
              }
              return result;
            },
          },
        } as any,
        configured,
        async (title, items) => {
          assert.equal(mode, "rpc");
          const action = actions.shift();
          assert.ok(action);
          assert.equal(items[0]?.value, "inherit");
          const display = [title, ...items.map(({ label }) => label)].join(
            "\n",
          );
          if (!previous && !configured.length) {
            assertInherited(display);
            assertSelectedFirst(display);
          } else if (!previous) {
            assertCustom(display);
          } else if (previous === steps.inherit) {
            assertInherited(display);
          }
          assert.ok(items.some(({ value }) => value === action.choice));
          previous = action;
          return action.choice;
        },
      );
      assert.deepEqual(result, expected);
    }
  });
}

test("Delegation settings allow editing while Off and write only when saved", async () => {
  const config = { ...DEFAULT_CONFIG, allowedAgentModels: ["missing/model"] };
  const writes: unknown[][] = [];
  const notices: string[] = [];
  const choices = [
    "allowed-override-models",
    "0",
    "cancel",
    "allowed-override-models",
    "0",
    "save",
    "model-overrides",
    "on",
    undefined,
  ];
  const runtime = createLeadCommandRuntime({
    readConfig: () => config,
    updateConfig: (key: string, value: boolean | string[]) => {
      writes.push([key, value]);
      if (typeof value === "boolean") config.allowAgentModelOverrides = value;
      else config.allowedAgentModels = value;
    },
    selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
      const choice = choices.shift();
      if (choice === "allowed-override-models") {
        assert.equal(
          items.find((item) => item.value === "model-overrides")?.description,
          "Off",
        );
        assert.equal(
          items.find((item) => item.value === choice)?.description,
          "Custom selection · 1 selected",
        );
      }
      if (choice === "0") {
        assert.match(title, /0\/3 selected · 1 unavailable/);
        assert.match(
          items.find((item) => item.value === choice)?.label,
          /^1\. ✓ missing\/model \[unavailable\]$/,
        );
      }
      if (choice === "cancel" || choice === "save") {
        assert.match(title, /Pi scoped models will be used/);
        assert.deepEqual(writes, []);
      }
      if (choice === "model-overrides") {
        assert.equal(
          items.find((item) => item.value === "allowed-override-models")
            ?.description,
          "Using Pi scoped models",
        );
      }
      return choice;
    },
  } as any);
  await runtime.openSettingsCategory(
    {
      mode: "rpc",
      scopedModels: [],
      isProjectTrusted: () => false,
      modelRegistry: {
        refresh: async () => {},
        getAvailable: () => overridePickerModels,
      },
      ui: { notify: (message: string) => notices.push(message) },
    } as any,
    "delegation",
  );
  assert.deepEqual(writes, [
    ["allowedAgentModels", []],
    ["allowAgentModelOverrides", true],
  ]);
  assert.deepEqual(notices, [
    "Agent model overrides: On. Applies to subsequent delegations and model turns.",
  ]);
});

test("status widget rows Settings validates choices and reports persistence errors", async () => {
  for (const scenario of [
    { choices: ["5"], inputs: [], expected: [5], errors: 0 },
    {
      choices: ["custom", "custom", "custom"],
      inputs: ["1e1", "+3", " 100 "],
      expected: [100],
      errors: 2,
    },
    { choices: ["default"], inputs: [], expected: [undefined], errors: 0 },
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
            "8 lines",
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
    {
      choices: ["custom", "custom", "custom", "custom"],
      inputs: ["0", "-1", "1.5", " 6 "],
      expected: [6],
      errors: 3,
    },
    { choices: ["default"], inputs: [], expected: [undefined], errors: 0 },
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
        if (title === "Delegation options") {
          assert.equal(
            items.find((item) => item.value === "max-agent-depth").description,
            "2 levels",
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
      "delegation",
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
      build: HERDSMAN_BUILD,
      extensionPath: "/example/index.js",
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
        title: string,
        items: any[],
        selected: string,
      ) => {
        calls++;
        assert.equal(
          title,
          `Pi Herdsman · v${HERDSMAN_BUILD.version} · ${HERDSMAN_BUILD.sha256.slice(0, 12)}`,
        );
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
    await runtime.openHerdsmanMenu({
      hasUI: true,
      ui: { notify: (message: string) => notices.push(message) },
    } as any);
    assert.equal(calls, 1);
    assert.equal(discoveryCalls, 0);
    assert.deepEqual(notices, []);
  }
});

test("Settings retain category selection and Agents & definitions lists its destinations", async () => {
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
    selectMenu: async (_ctx: unknown, _title: string, items: any[]) => {
      agentCalls.push(items.map((item) => item.label));
      return undefined;
    },
  } as any);
  await agents.openAgentsMenu({} as any);
  assert.deepEqual(agentCalls[0], [
    "Agent definitions",
    "Coordinator profiles",
    "Stop all agents…",
  ]);
});

test("Agents & definitions skips discovery before rendering and retains its selection", async () => {
  const selections: (string | undefined)[] = [];
  let statusReads = 0;
  let loadedDefinitions = 0;
  const runtime = createLeadCommandRuntime({
    controller: { sessionSignal: () => undefined },
    loadStatusSnapshot: async () => {
      statusReads++;
      throw new Error("status failed");
    },
    getThinkingLevel: () => "off",
    agentDefinitionEnabled: () => true,
    contextAgentDefinitions: async () => {
      loadedDefinitions++;
      return { definitions: [], roleDefinitions: [], projectTrusted: false };
    },
    selectMenu: async (
      _ctx: unknown,
      title: string,
      _items: unknown[],
      selected?: string,
    ) => {
      if (title !== "Agents & definitions") return undefined;
      selections.push(selected);
      if (selections.length === 1) {
        assert.equal(loadedDefinitions, 0);
        return "coordinator-profiles";
      }
      if (selections.length === 2) return "agent-definitions";
      return undefined;
    },
  } as any);
  await runtime.openAgentsMenu({
    isProjectTrusted: () => false,
    ui: { notify: () => undefined },
  } as any);
  assert.equal(statusReads, 0);
  assert.equal(loadedDefinitions, 1);
  assert.deepEqual(selections, [
    "agent-definitions",
    "coordinator-profiles",
    "agent-definitions",
  ]);
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
    "Files 4 KiB · Messages 16 KiB",
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
      title: "Project · Start Manager automatically",
      current: "inherit",
    },
    {
      action: "merge",
      answers: ["repository", undefined, undefined],
      title: "Repository · Merge accepted branches · /repo",
      current: "inherit",
    },
    {
      action: "merge",
      answers: ["global", undefined, undefined],
      title: "Global · Merge accepted branches",
      current: "off",
    },
    {
      action: "sessions",
      answers: ["default-lead-execution", undefined, undefined],
      title: "Default Lead mode",
      current: "flexible",
    },
    {
      action: "delegation",
      answers: ["max-agent-depth", undefined, undefined],
      title: "Agent nesting limit",
      current: "default",
    },
    {
      action: "manager",
      answers: ["manager-git-bootstrap-confirmation", undefined, undefined],
      title: "Confirm Git initialization",
      current: "required",
    },
    {
      action: "interface",
      answers: ["status-widget-rows", undefined, undefined],
      title: "Status widget lines",
      current: "default",
    },
    {
      action: "limits",
      answers: ["inlineAttachmentLimitBytes", undefined, undefined],
      title: "Shared file content",
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
          const defaultValue = {
            "Agent nesting limit": "2",
            "Status widget lines": "8",
            "Shared file content": "131072",
          }[title];
          if (defaultValue) {
            const values = items.map(({ value }) => value);
            assert.equal(values[0], "default");
            assert.equal(values.at(-1), "custom");
            assert.equal(values.length, new Set(values).size);
            assert.ok(!values.includes(defaultValue));
            assert.ok(!values.includes("reset"));
            assert.match(items[0].label, /^Use default /);
          }
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

test("Message and file limit selectors restore defaults even when already effective", async () => {
  for (const key of [
    "inlineAttachmentLimitBytes",
    "mailboxPayloadLimitBytes",
  ] as const) {
    const answers = [
      key,
      "custom",
      key,
      "custom",
      key,
      "default",
      key,
      "default",
      undefined,
    ];
    const inputs = ["0", undefined];
    const writes: unknown[][] = [];
    const errors: string[] = [];
    const runtime = createLeadCommandRuntime({
      messageLimits: async () => ({
        inline: { bytes: DEFAULT_CONFIG.inlineAttachmentLimitBytes },
        mailbox: { bytes: DEFAULT_CONFIG.mailboxPayloadLimitBytes },
      }),
      formatMessageLimit: String,
      validByteLimit,
      input: async () => inputs.shift(),
      selectMenu: async () => answers.shift(),
      updateMessageLimit: (setting: string, value: unknown) => {
        writes.push([setting, value]);
        if (writes.length === 1) throw new Error("disk failure");
      },
    } as any);
    await runtime.openMessageLimitsMenu({
      ui: {
        notify: (message: string, level?: string) => {
          if (level === "error") errors.push(message);
        },
      },
    } as any);
    assert.deepEqual(writes, [
      [key, undefined],
      [key, undefined],
    ]);
    assert.deepEqual(
      errors.map((message) => message.split(":").at(-1)?.trim()),
      ["Enter an integer from 1 through 1024 KiB", "disk failure"],
    );
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
        build: HERDSMAN_BUILD,
        extensionPath: "/example/index.js",
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
      await runtime.openHerdsmanMenu({
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
        runtime.runRoleCommand(role, "open", ctx),
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
    assert.equal(transitions, 1);
    assert.equal(overviews, 1);
    assert.deepEqual(notices, [
      [`/${role}-refresh requires active ${role} mode`, "error"],
    ]);
  }
});

test("Settings categories expose canonical rows, values and contextual help", async () => {
  const expected = [
    [
      "sessions",
      [
        ["default-lead-execution", "Default Lead mode", "Flexible"],
        [
          "context-retirement",
          "Finish Agents near context limit",
          "On · Global",
        ],
        [
          "message-limits",
          "Message and file limits",
          "Files 4097 B · Messages 16 KiB",
        ],
      ],
    ],
    [
      "manager",
      [
        [
          "auto-activate-manager",
          "Start Manager automatically",
          "Off · Global",
        ],
        [
          "manager-git-bootstrap-confirmation",
          "Confirm Git initialization",
          "Required",
        ],
        ["manager-merge", "Merge accepted branches", "Repository unavailable"],
        ["projects-directory", "Projects directory", "~/Projects"],
        [
          "removal-confirmation",
          "Confirm worktree removal",
          "Repository unavailable",
        ],
      ],
    ],
    [
      "interface",
      [
        ["agent-layout", "Agent terminal layout", "Shared tab"],
        ["status-widget-rows", "Status widget lines", "8 lines"],
      ],
    ],
    [
      "delegation",
      [
        ["max-agent-depth", "Agent nesting limit", "2 levels"],
        ["cwd-override", "Delegate Agents to other directories (cwd)", "Off"],
        ["model-overrides", "Agent model overrides", "Off"],
        [
          "allowed-override-models",
          "Allowed override models",
          "Using Pi scoped models",
        ],
      ],
    ],
    [
      "communication",
      [
        ["peer-communication", "Peer communication", "On"],
        ["peer-federation", "Peer federation", "On"],
      ],
    ],
  ] as const;
  let categoryIndex = 0;
  let selectedCategory: { value: string; label: string } | undefined;
  const displayedRows: [string, string][] = [];
  const host = {
    readConfig: () => DEFAULT_CONFIG,
    placementSettings: async () => ({ effective: "tab" }),
    messageLimits: async () => ({
      inline: { bytes: 4097 },
      mailbox: { bytes: 16384 },
    }),
    getRemovalPreauthorization: async () => {
      throw new Error("No verified repository");
    },
    selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
      if (title === "Settings") {
        selectedCategory = items[categoryIndex++];
        if (!selectedCategory) assert.equal(items.length, expected.length);
        return selectedCategory?.value;
      }
      assert.ok(selectedCategory);
      assert.equal(title, selectedCategory.label);
      const category = selectedCategory.value;
      const rows = expected.find(([value]) => value === category)?.[1];
      assert.deepEqual(
        items.map(({ value, label, description }) => [
          value,
          label,
          description,
        ]),
        rows,
      );
      assert.ok(
        items.every(({ help }) => help?.length > 0 && help.length <= 280),
      );
      for (const item of items) {
        assert.ok(!Object.hasOwn(item, "category"));
        displayedRows.push([title, item.label]);
      }
    },
  };
  await createLeadCommandRuntime(host as any).openSettingsMenu({
    isProjectTrusted: () => false,
  } as any);

  const commands = readFileSync(
    new URL("../../docs/reference/commands.md", import.meta.url),
    "utf8",
  );
  const table = commands.match(
    /^### Settings menu\r?\n\r?\n([\s\S]*?)\r?\n\r?\n/m,
  )?.[1];
  assert.ok(table, "Settings menu inventory is missing");
  const documentedRows = table
    .split(/\r?\n/)
    .slice(2)
    .map((row) => {
      const match = row.match(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*$/);
      assert.ok(match, `Invalid Settings menu inventory row: ${row}`);
      return [match[1], match[2]];
    });
  assert.deepEqual(documentedRows, displayedRows);
});

test("Settings identifies trusted project and verified repository sources", async () => {
  for (const [readFails, overrideMerge, project, merge] of [
    [false, true, "Off · Project", "Conflict-free · Repository"],
    [true, false, "Project unavailable", "Fast-forward · Global"],
  ] as const) {
    const runtime = createLeadCommandRuntime({
      readConfig: () => ({
        ...DEFAULT_CONFIG,
        autoActivateManager: true,
        managerMergeEnabled: true,
        managerMergeOverrides: overrideMerge ? { "/repo": "divergent" } : {},
      }),
      readProjectOverrides: () => {
        if (readFails) throw new Error("Unavailable");
        return { autoActivateManager: false };
      },
      getRemovalPreauthorization: async () => ({
        repoKey: "/repo",
        enabled: true,
      }),
      selectMenu: async (_ctx: unknown, _title: string, items: any[]) => {
        assert.deepEqual(
          items.map(({ description }) => description),
          [project, "Required", merge, "~/Projects", "Skipped · Repository"],
        );
      },
    } as any);
    await runtime.openSettingsCategory(
      { isProjectTrusted: () => true } as any,
      "manager",
    );
  }
});

test("Projects directory edits use the active profile's global configuration", async (t) => {
  const profile = mkdtempSync(join(tmpdir(), "herdsman-projects-setting-"));
  const previousProfile = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = profile;
  t.after(() => {
    if (previousProfile === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousProfile;
    rmSync(profile, { recursive: true, force: true });
  });
  const customPath = join(profile, "Work Repositories");
  const defaultPath = DEFAULT_CONFIG.projectsDirectory;
  for (const [input, before, after, writes, invalid] of [
    [customPath, defaultPath, customPath, 1, false],
    ["relative/path", customPath, customPath, 1, true],
    [undefined, customPath, customPath, 0, false],
    [defaultPath, customPath, defaultPath, 1, false],
  ] as const) {
    const notices: [string, string][] = [];
    let visits = 0;
    let writeCount = 0;
    const runtime = createLeadCommandRuntime({
      readConfig,
      updateConfig: (key: "projectsDirectory", value: string | undefined) => {
        writeCount++;
        assert.equal(key, "projectsDirectory");
        assert.equal(value, input === defaultPath ? undefined : input);
        updateConfig(key, value);
      },
      input: async (_ctx: unknown, label: string) => {
        assert.equal(label, `Projects directory (default: ${defaultPath})`);
        return input;
      },
      selectMenu: async (_ctx: unknown, title: string, items: any[]) => {
        assert.equal(title, "Manager & repositories");
        const row = items.find(({ value }) => value === "projects-directory");
        assert.equal(row?.description, visits === 0 ? before : after);
        if (visits++ === 0) return row.value;
      },
    } as any);
    await runtime.openSettingsCategory(
      {
        isProjectTrusted: () => false,
        ui: {
          notify: (message: string, level: string) =>
            notices.push([message, level]),
        },
      } as any,
      "manager",
    );
    assert.equal(visits, 2);
    assert.equal(writeCount, writes);
    assert.equal(readConfig().projectsDirectory, after);
    if (invalid) {
      assert.equal(notices.length, 1);
      assert.match(notices[0]![0], /projectsDirectory.*absolute/);
      assert.equal(notices[0]![1], "error");
    } else assert.deepEqual(notices, []);
  }
  assert.equal(existsSync(customPath), false);
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
          [
            "max-agent-depth",
            "cwd-override",
            "model-overrides",
            "allowed-override-models",
          ],
        );
        assert.equal(
          selected,
          attempts.length === 4 ? "max-agent-depth" : "cwd-override",
        );
        assert.equal(
          items[1]?.label,
          "Delegate Agents to other directories (cwd)",
        );
        assert.equal(
          items[1]?.description,
          config.allowAgentCwdOverride ? "On" : "Off",
        );
        assert.equal(
          items[1]?.help,
          "Allow ordinary Leads to select another directory using `cwd` in `delegate_agent`. Without it, Agents use the Lead's directory. Global setting; changes apply to subsequent model turns without `/reload`.",
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
  assert.deepEqual(
    notices,
    ["On", "Off"].map(
      (value) =>
        `Delegate Agents to other directories (cwd): ${value}. Applies to subsequent delegations and model turns.`,
    ),
  );
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
        if (title === "Merge accepted branches")
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
      title === "Merge accepted branches"
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
  const second = {
    category: "agent",
    name: "second",
    frontmatter: { name: "second" },
  } as any;
  const first = {
    category: "agent",
    name: "first",
    frontmatter: { name: "first" },
  } as any;
  const selections: { title: string; selected?: string }[] = [];
  const results = ["agents", "second", undefined, undefined, undefined];
  const runtime = createLeadCommandRuntime({
    contextAgentDefinitions: async () => ({
      definitions: [first, second],
      roleDefinitions: [],
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
      category: "agent" as const,
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
      inspectDefinition: () => ({
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
      leadExecutionDefinition: () => undefined,
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
  const choices = [
    "roles",
    "lead:managed-lead",
    "details",
    undefined,
    undefined,
  ];
  let details: any;
  let selectedCwd: string | undefined;
  const definition = {
    category: "lead" as const,
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
    inspectDefinition: () => ({
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
    leadExecutionDefinition: () => undefined,
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

test("same-named Lead and Manager entries expose only applicable settings", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "herdsman-definition-menu-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  for (const directory of ["leads", "managers"]) {
    const path = join(root, "coordinators", directory);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "shared.md"), "---\nname: shared\n---\nProfile");
  }
  const choices = [
    "roles",
    "lead:shared",
    undefined,
    "manager:shared",
    undefined,
    undefined,
    undefined,
  ];
  const profileMenus: string[][] = [];
  const runtime = createLeadCommandRuntime({
    selectMenu: async (
      _ctx: unknown,
      title: string,
      items: { value: string; label: string }[],
    ) => {
      if (title === "Coordinators") {
        assert.ok(
          items.some(
            ({ value, label }) =>
              value === "lead:shared" && label === "shared (lead)",
          ),
        );
        assert.ok(
          items.some(
            ({ value, label }) =>
              value === "manager:shared" && label === "shared (manager)",
          ),
        );
      }
      if (title === "shared")
        profileMenus.push(items.map(({ value }) => value));
      return choices.shift();
    },
    getThinkingLevel: () => "high",
  } as any);
  await runtime.openDefinitionsMenu({
    isProjectTrusted: () => false,
    ui: { notify: () => undefined },
  } as any);
  assert.deepEqual(profileMenus, [
    ["model", "thinking", "details"],
    ["details"],
  ]);
});

test("Coordinator Details show current prompt inputs in composition order", async () => {
  const choices = ["roles", "manager:manager", "details", undefined, undefined];
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
    inspectDefinition: () => ({
      definition: {
        category: "manager" as const,
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
    ["roles", "manager:manager", "details"],
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
  const choices = ["roles", "chief:chief", "details", undefined, undefined];
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
    inspectDefinition: () => ({
      definition: {
        category: "chief" as const,
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
  const first = {
    category: "agent",
    name: "first",
    frontmatter: { name: "first" },
  } as any;
  const warning =
    "/agent/agents/manager.md: definition belongs in /agent/coordinators/managers/manager.md; file excluded from discovery";
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
