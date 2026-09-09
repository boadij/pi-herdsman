import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { after, mock, test } from "node:test";
import { Value } from "typebox/value";
import type {
  AskRecord,
  RequestRecord,
  ResultRecord,
  ManagedAgentState,
} from "./mailbox.ts";
import { claimProcessLock } from "./lock.ts";
import { OperationError } from "./errors.ts";

export const watchedResultPaths = new Map<string, Function>();
export const projectContextCwds: string[] = [];
export const nativeSessions = new Map<
  string,
  {
    id: string;
    path: string;
    entries?: unknown[];
    cwd?: string;
    sessionName?: string;
  }
>();
export let sessionOpenError: unknown;
export let failNextMailboxWrite = false;
export let failNextResultRemoval = false;
export let resultRemovalAttempts = 0;
export let agentDefinitionReadCount = 0;
export let settingsAccessHook:
  ((access: "reload" | "project") => void) | undefined;

export type WidgetComponent = {
  render(width: number): string[];
  invalidate(): void;
};
export type WidgetContent =
  | undefined
  | string[]
  | ((tui: { requestRender(): void }, theme: unknown) => WidgetComponent);

function assertWidgetContent(content: unknown): void {
  if (content === undefined) return;
  if (Array.isArray(content)) {
    assert.ok(content.every((line) => typeof line === "string"));
    return;
  }
  assert.equal(typeof content, "function", "invalid widget content");
  const component = (
    content as (
      tui: { requestRender(): void },
      theme: unknown,
    ) => WidgetComponent
  )(
    { requestRender: () => undefined },
    { fg: (_color: string, text: string) => text },
  );
  assert.equal(typeof component?.render, "function");
  assert.equal(typeof component?.invalidate, "function");
  assert.ok(Array.isArray(component.render(80)));
  component.invalidate();
}
export const realFs = await import("node:fs");
const testTmpRoot = realFs.mkdtempSync(join(tmpdir(), "pi-herdsman-test-"));
process.env.TMPDIR = testTmpRoot;
const {
  Key: tuiKey,
  matchesKey: tuiMatchesKey,
  visibleWidth: tuiVisibleWidth,
} = await import("@earendil-works/pi-tui");
export { tuiVisibleWidth };
export const PI_AGENT_ROOT = realFs.mkdtempSync(
  join(tmpdir(), "pi-herdsman-pi-agent-"),
);
export const PI_AGENTS_DIR = join(PI_AGENT_ROOT, "agents");
realFs.mkdirSync(PI_AGENTS_DIR);
realFs.writeFileSync(
  join(PI_AGENTS_DIR, "agent.md"),
  "---\nname: agent\n---\nagent instructions\n",
);
function testSettings(path: string): Record<string, unknown> {
  try {
    return JSON.parse(realFs.readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}
after(() => realFs.rmSync(testTmpRoot, { recursive: true, force: true }));
mock.module("node:fs", {
  namedExports: {
    closeSync: realFs.closeSync,
    chmodSync: realFs.chmodSync,
    constants: realFs.constants,
    existsSync: realFs.existsSync,
    fstatSync: realFs.fstatSync,
    fsyncSync: realFs.fsyncSync,
    mkdirSync: realFs.mkdirSync,
    openSync: (...args: any[]) => {
      return realFs.openSync(...args);
    },
    readFileSync: (...args: any[]) => {
      if (
        typeof args[0] === "string" &&
        args[0].startsWith(`${PI_AGENTS_DIR}/`)
      )
        agentDefinitionReadCount++;
      return realFs.readFileSync(...args);
    },
    readSync: (...args: any[]) => {
      return realFs.readSync(...args);
    },
    readdirSync: realFs.readdirSync,
    realpathSync: realFs.realpathSync,
    renameSync: realFs.renameSync,
    rmSync: realFs.rmSync,
    rmdirSync: realFs.rmdirSync,
    statSync: realFs.statSync,
    unlinkSync: (path: string) => {
      if (failNextResultRemoval && path.includes("/result-")) {
        resultRemovalAttempts++;
        failNextResultRemoval = false;
        throw new Error("injected result removal failure");
      }
      if (path.includes("/result-")) resultRemovalAttempts++;
      return realFs.unlinkSync(path);
    },
    writeFileSync: realFs.writeFileSync,
    writeSync: (...args: any[]) => {
      if (failNextMailboxWrite) {
        failNextMailboxWrite = false;
        throw new Error("injected mailbox state write failure");
      }
      return realFs.writeSync(...args);
    },
    watchFile: (path: string, _options: unknown, listener: Function) => {
      watchedResultPaths.set(path, listener);
    },
    unwatchFile: (path: string, listener: Function) => {
      if (watchedResultPaths.get(path) === listener)
        watchedResultPaths.delete(path);
    },
  },
});

export const {
  controlMarker,
  listAgentStates,
  readPendingAsk,
  readRequest,
  readResult,
  readAgentState,
  removeAsk,
  removeRequest,
  removeResult,
  MAILBOX_PROTOCOL_LIMIT_BYTES,
  resetAgentMailbox,
  agentMailboxPath,
  writeAsk,
  writeRequest,
  writeResult,
  writeAgentState,
} = await import("./mailbox.ts");

mock.module("@earendil-works/pi-coding-agent", {
  namedExports: {
    DynamicBorder: class {
      private readonly color: (text: string) => string;
      constructor(color = (text: string) => text) {
        this.color = color;
      }
      invalidate() {}
      render(width: number) {
        return [this.color("─".repeat(width))];
      }
    },
    DEFAULT_MAX_BYTES: 50 * 1024,
    DEFAULT_MAX_LINES: 2000,
    formatSize: (n: number) => `${n} B`,
    getMarkdownTheme: () => ({}),
    truncateHead: (
      text: string,
      options: { maxBytes?: number; maxLines?: number },
    ) => {
      const lines = text.split("\n");
      const maxLines = options.maxLines ?? lines.length;
      const content = lines.slice(0, maxLines).join("\n");
      return {
        content,
        truncated: content !== text,
        totalLines: lines.length,
        outputLines: content ? content.split("\n").length : 0,
      };
    },
    truncateTail: (
      text: string,
      options: { maxBytes?: number; maxLines?: number },
    ) => {
      const lines = text.split("\n");
      const maxLines = options.maxLines ?? lines.length;
      const content = lines.slice(-maxLines).join("\n");
      return {
        content,
        truncated: content !== text,
        totalLines: lines.length,
        outputLines: content ? content.split("\n").length : 0,
      };
    },
    truncateLine: (text: string) => ({ text, wasTruncated: false }),
    CONFIG_DIR_NAME: ".pi",
    getAgentDir: () => PI_AGENT_ROOT,
    loadProjectContextFiles: ({ cwd }: { cwd: string }) => {
      projectContextCwds.push(cwd);
      return [];
    },
    SettingsManager: {
      create: (cwd: string, agentDir: string, options: any) => ({
        reload: async () => settingsAccessHook?.("reload"),
        getGlobalSettings: () => testSettings(join(agentDir, "settings.json")),
        getProjectSettings: () => {
          settingsAccessHook?.("project");
          return testSettings(join(cwd, ".pi", "settings.json"));
        },
        isProjectTrusted: () => options?.projectTrusted === true,
      }),
    },
    SessionManager: {
      listAll: async () => [...nativeSessions.values()],
      open: (path: string) => {
        if (sessionOpenError !== undefined) throw sessionOpenError;
        const session = [...nativeSessions.values()].find(
          (item) => item.path === path,
        );
        return {
          getSessionId: () => session?.id ?? "",
          getSessionFile: () => session?.path,
          getHeader: () => (session ? { cwd: session.cwd } : null),
          getCwd: () => resolve(session?.cwd || process.cwd()),
          getSessionName: () => session?.sessionName,
          getEntries: () =>
            session?.entries ?? [
              {
                type: "custom",
                customType: "pi-herdsman-agent-definition",
                data: { name: "agent" },
              },
            ],
        };
      },
    },
  },
});
mock.module("@earendil-works/pi-tui", {
  namedExports: {
    Container: class {
      children: any[] = [];
      addChild(child: any) {
        this.children.push(child);
      }
      clear() {
        this.children = [];
      }
      invalidate() {}
      render(width: number) {
        return this.children.flatMap((child) => child.render(width));
      }
    },
    Box: class {
      private readonly children: any[] = [];
      private readonly paddingX: number;
      private readonly paddingY: number;
      private readonly bgFn: (text: string) => string;
      constructor(
        paddingX = 0,
        paddingY = 0,
        bgFn: (text: string) => string = (text) => text,
      ) {
        this.paddingX = paddingX;
        this.paddingY = paddingY;
        this.bgFn = bgFn;
      }
      addChild(child: any) {
        this.children.push(child);
      }
      render(width: number) {
        const innerWidth = Math.max(0, width - this.paddingX * 2);
        const content = this.children.flatMap((child) =>
          child.render(innerWidth),
        );
        const blank = "".padEnd(Math.max(0, innerWidth));
        return [
          ...Array.from({ length: this.paddingY }, () =>
            this.bgFn(blank.padEnd(width)),
          ),
          ...content.map((line: string) =>
            this.bgFn(
              `${"".padEnd(this.paddingX)}${line}${"".padEnd(this.paddingX)}`,
            ),
          ),
          ...Array.from({ length: this.paddingY }, () =>
            this.bgFn(blank.padEnd(width)),
          ),
        ];
      }
    },
    Text: class {
      text: string;
      constructor(text: string) {
        this.text = text;
      }
      render(_width: number) {
        return this.text.split("\n");
      }
    },
    Markdown: class {
      private readonly text: string;
      constructor(text: string) {
        this.text = text;
      }
      invalidate() {}
      render(_width: number) {
        return this.text.split("\n");
      }
    },
    Spacer: class {
      private readonly height: number;
      constructor(height = 1) {
        this.height = height;
      }
      invalidate() {}
      render(_width: number) {
        return Array.from({ length: this.height }, () => "");
      }
    },
    SelectList: class {
      private index = 0;
      private readonly items: any[];
      onSelect?: (item: any) => void;
      onCancel?: () => void;
      onSelectionChange?: (item: any) => void;
      constructor(items: any[]) {
        this.items = items;
      }
      setSelectedIndex(index: number) {
        this.index = Math.max(0, Math.min(index, this.items.length - 1));
      }
      getSelectedItem() {
        return this.items[this.index] ?? null;
      }
      invalidate() {}
      render(_width: number) {
        return this.items.map(
          (item, index) => `${index === this.index ? "→ " : "  "}${item.label}`,
        );
      }
      handleInput(data: string) {
        if (tuiMatchesKey(data, tuiKey.enter))
          this.onSelect?.(this.getSelectedItem());
        else if (tuiMatchesKey(data, tuiKey.escape)) this.onCancel?.();
        else if (tuiMatchesKey(data, tuiKey.down)) {
          this.index = Math.min(this.items.length - 1, this.index + 1);
          this.onSelectionChange?.(this.getSelectedItem());
        } else if (tuiMatchesKey(data, tuiKey.up)) {
          this.index = Math.max(0, this.index - 1);
          this.onSelectionChange?.(this.getSelectedItem());
        }
      }
    },
    truncateToWidth: (text: string, width: number) => text.slice(0, width),
    Key: tuiKey,
    matchesKey: tuiMatchesKey,
    visibleWidth: tuiVisibleWidth,
  },
});
mock.module("@earendil-works/pi-ai", {
  namedExports: {
    StringEnum: (values: readonly string[]) => ({
      type: "string",
      enum: [...values],
    }),
    getSupportedThinkingLevels: (model: { reasoning: boolean }) =>
      model.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"],
  },
});
mock.module("typebox", {
  namedExports: {
    Type: {
      Object: (properties: unknown, options: unknown = {}) => ({
        type: "object",
        properties,
        ...(options as object),
      }),
      Optional: (value: unknown) => value,
      String: (options: unknown = {}) => ({ type: "string", ...options }),
      Boolean: (options: unknown = {}) => ({ type: "boolean", ...options }),
      Number: (options: unknown = {}) => ({ type: "number", ...options }),
      Integer: (options: unknown = {}) => ({ type: "integer", ...options }),
      Array: (items: unknown, options: unknown = {}) => ({
        type: "array",
        items,
        ...options,
      }),
      Union: (anyOf: unknown[]) => ({ anyOf }),
    },
  },
});

const extension = await import("./index.ts");
export const registerExtension = extension.default;
export const {
  sessionAgentDefinition,
  resolveManagedSession,
  resolveAssignmentSession,
} = extension;
export const { herdrAgentAlias: runScopedHerdrAlias } =
  await import("./herdr.ts");
export const {
  StatusWidget,
  formatAgentDefinitions,
  buildStatusRows,
  renderRunningOptions,
  truncateModelText,
  visibleWidth,
} = await import("./presentation.ts");
export const {
  agentDefinitionMetadata,
  discoverAgent,
  discoverAgentDefinitions,
} = await import("./agent-definitions.ts");

export type Context = {
  cwd: string;
  hasUI: boolean;
  mode: "tui" | "rpc";
  isProjectTrusted: () => boolean;
  isIdle: () => boolean;
  abort: () => void;
  getContextUsage: () => { tokens: number; contextWindow: number };
  sessionManager: {
    getSessionId: () => string;
    getSessionFile: () => string;
    getEntries: () => unknown[];
    getBranch: () => unknown[];
  };
  ui: {
    notify: () => void;
    select: () => Promise<string>;
    setWidget?: (key: string, content: WidgetContent) => void;
    custom?: (...args: unknown[]) => Promise<unknown>;
  };
};

export const WORKSPACE = `registered-test-workspace-${randomUUID()}`;
export const LEAD_SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const NON_PI_AGENT = "legacy-root";
export const AGENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const REQUEST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const DEFAULT_PI_SESSION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const PARENT_SESSION_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const CHILD_SESSION_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

export type FixtureIdentity = {
  paneId: string;
  tabId: string;
  piSessionId: string;
  piSessionFile: string;
};

export const defaultFixtureIdentity: FixtureIdentity = {
  paneId: "registered-pane",
  tabId: "registered-tab",
  piSessionId: DEFAULT_PI_SESSION_ID,
  piSessionFile: "/tmp/registered-agent.jsonl",
};

export function recoveryIdentity(label: string): FixtureIdentity {
  return {
    paneId: `${label}-pane`,
    tabId: `${label}-tab`,
    piSessionId: DEFAULT_PI_SESSION_ID,
    piSessionFile: `/tmp/${label}-agent.jsonl`,
  };
}

export function herdrAlias(label: string): string {
  return runScopedHerdrAlias(WORKSPACE, label, AGENT_ID);
}
export function isPreservePaneStop(args: string[]): boolean {
  return (
    args[0] === "agent" &&
    args[1] === "send-keys" &&
    args.includes("ctrl+c") &&
    args.includes("ctrl+d")
  );
}
export function isPaneClose(args: string[]): boolean {
  return args[0] === "pane" && args[1] === "close";
}
export function isTabClose(args: string[]): boolean {
  return args[0] === "tab" && args[1] === "close";
}
export function isAgentList(args: string[]): boolean {
  return args[0] === "agent" && args[1] === "list";
}
export function isTabList(args: string[]): boolean {
  return args[0] === "tab" && args[1] === "list";
}
export function isPaneList(args: string[]): boolean {
  return args[0] === "pane" && args[1] === "list";
}
export function isHerdrList(args: string[]): boolean {
  return isAgentList(args) || isTabList(args) || isPaneList(args);
}
export function delegationLockPathForTest(
  workspaceId: string,
  parentSessionId: string,
): string {
  return join(
    tmpdir(),
    "pi-herdsman",
    process.getuid?.().toString() ?? "user",
    "locks",
    "delegation-" +
      createHash("sha256")
        .update(workspaceId + "\0" + parentSessionId)
        .digest("hex"),
  );
}

export function fakeContext(
  entries: unknown[] = [],
  branch: unknown[] = entries,
): Context {
  return {
    cwd: "/tmp",
    hasUI: false,
    mode: "tui",
    abort: () => undefined,
    isProjectTrusted: () => true,
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 2, contextWindow: 10 }),
    sessionManager: {
      getSessionId: () => LEAD_SESSION_ID,
      getSessionFile: () => "/tmp/root.jsonl",
      getEntries: () => entries,
      getBranch: () => branch,
    },
    ui: {
      notify: () => undefined,
      select: async () => "tab",
      confirm: async () => true,
      setWidget: (_key: string, content: WidgetContent) =>
        assertWidgetContent(content),
      custom: async () => undefined,
    },
  };
}
export function fakeAgentContext(
  entries: unknown[] = [],
  branch: unknown[] = entries,
): Context {
  const context = fakeContext(entries, branch);
  context.sessionManager = {
    ...context.sessionManager,
    getSessionId: () => "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    getSessionFile: () => "/tmp/registered-agent.jsonl",
  };
  return context;
}

export type ExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
};
export type ExecHandler = (
  command: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal },
) => ExecResult | Promise<ExecResult>;

export function fakePi(
  options: {
    exec?: ExecHandler;
    sendMessage?: (message: unknown) => void | Promise<void>;
    entries?: unknown[];
    activeTools?: string[] | (() => string[]);
    autoActivateRegisteredTools?: boolean;
    persistMessages?: boolean;
    sessionName?: string;
  } = {},
) {
  const events = new Map<string, ((event: any, ctx: Context) => unknown)[]>();
  const commands: string[] = [];
  const commandOptions = new Map<string, any>();
  const entryRenderers: { customType: string; renderer: unknown }[] = [];
  const messageRenderers: { customType: string; renderer: unknown }[] = [];
  const tools: any[] = [];
  const calls: string[][] = [];
  const callResults: { args: string[]; succeeded: boolean; code?: number }[] =
    [];
  const execOptions: { timeout?: number; signal?: AbortSignal }[] = [];
  const entries = options.entries ?? [];
  const sent: unknown[] = [];
  const sentMessageCalls: { message: unknown; options?: unknown }[] = [];
  const sentUsers: unknown[] = [];
  const sentUserCalls: { content: unknown; options?: unknown }[] = [];
  let activeTools: string[] | undefined =
    typeof options.activeTools === "function"
      ? undefined
      : [...(options.activeTools ?? [])];
  const pi = {
    on(name: string, handler: (event: any, ctx: Context) => unknown) {
      events.set(name, [...(events.get(name) ?? []), handler]);
    },
    registerCommand(name: string, options: any) {
      commands.push(name);
      commandOptions.set(name, options);
    },
    registerTool(tool: unknown) {
      tools.push(tool);
      if (options.autoActivateRegisteredTools && (tool as any)?.name) {
        activeTools = [
          ...new Set([...this.getActiveTools(), (tool as any).name]),
        ];
      }
    },
    registerMessageRenderer(customType: string, renderer: unknown) {
      messageRenderers.push({ customType, renderer });
    },
    registerEntryRenderer(customType: string, renderer: unknown) {
      entryRenderers.push({ customType, renderer });
    },
    getActiveTools() {
      return activeTools
        ? [...activeTools]
        : (options.activeTools as () => string[])();
    },
    setActiveTools(next: string[]) {
      activeTools = [...next];
    },
    getSessionName() {
      return options.sessionName;
    },
    async exec(
      command: string,
      args: string[],
      execOptionsValue: { timeout?: number; signal?: AbortSignal } = {},
    ) {
      calls.push(args);
      execOptions.push(execOptionsValue);
      try {
        const result = await (options.exec?.(
          command,
          args,
          execOptionsValue,
        ) ?? {
          stdout: "{}",
          stderr: "",
          code: 0,
        });
        callResults.push({
          args,
          succeeded: result.code === 0,
          code: result.code,
        });
        return result;
      } catch (error) {
        callResults.push({ args, succeeded: false });
        throw error;
      }
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ type: "custom", customType, data });
    },
    sendMessage(message: unknown, sendOptions?: unknown) {
      sent.push(message);
      sentMessageCalls.push({ message, options: sendOptions });
      if (options.persistMessages) entries.push(message);
      return options.sendMessage?.(message);
    },
    sendUserMessage(content: unknown, options?: unknown) {
      sentUsers.push(content);
      sentUserCalls.push({ content, options });
    },
  };
  return {
    pi,
    events,
    commands,
    commandOptions,
    entryRenderers,
    messageRenderers,
    tools,
    calls,
    callResults,
    execOptions,
    entries,
    sent,
    sentMessageCalls,
    sentUsers,
    sentUserCalls,
  };
}

export function stopSummary(pi: ReturnType<typeof fakePi>): string {
  const message = [...pi.sentMessageCalls]
    .reverse()
    .find(
      (candidate: any) =>
        candidate?.message?.customType === "pi-herdsman-stop-summary",
    )?.message as { details?: { summary?: unknown } } | undefined;
  return typeof message?.details?.summary === "string"
    ? message.details.summary
    : "";
}

export function setLeadEnvironment(): void {
  clearTestMailboxes();
  for (const entry of realFs.readdirSync(PI_AGENTS_DIR))
    if (entry.endsWith(".md")) realFs.rmSync(join(PI_AGENTS_DIR, entry));
  realFs.writeFileSync(
    join(PI_AGENTS_DIR, "agent.md"),
    "---\nname: agent\n---\nagent instructions\n",
  );
  realFs.writeFileSync(
    join(PI_AGENTS_DIR, "child.md"),
    "---\nname: child\n---\nchild\n",
  );
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = WORKSPACE;
  for (const key of [
    "PI_HERDSMAN_MAILBOX",
    "PI_HERDSMAN_RUN_ID",
    "PI_HERDSMAN_OWNER_SESSION_ID",
    "PI_HERDSMAN_LABEL",
    "PI_HERDSMAN_WORKSPACE_ID",
    "PI_HERDSMAN_AGENT_DEFINITION",
    "PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS",
    "HERDR_PANE_ID",
    "HERDR_SOCKET_PATH",
  ])
    delete process.env[key];
}

export function setAgentEnvironment(
  label = "registered-agent",
  allowedAgentDefinitions?: string[],
): string {
  clearTestMailboxes();
  for (const entry of realFs.readdirSync(PI_AGENTS_DIR))
    if (entry.endsWith(".md")) realFs.rmSync(join(PI_AGENTS_DIR, entry));
  realFs.writeFileSync(
    join(PI_AGENTS_DIR, "agent.md"),
    "---\nname: agent\n---\nagent instructions\n",
  );
  realFs.writeFileSync(
    join(PI_AGENTS_DIR, "child.md"),
    "---\nname: child\n---\nchild\n",
  );
  const workspace = WORKSPACE;
  const mailbox = agentMailboxPath(workspace, label);
  process.env.HERDR_ENV = "1";
  process.env.HERDR_WORKSPACE_ID = workspace;
  process.env.PI_HERDSMAN_MAILBOX = mailbox;
  process.env.PI_HERDSMAN_RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  process.env.PI_HERDSMAN_OWNER_SESSION_ID =
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  process.env.PI_HERDSMAN_LABEL = label;
  process.env.PI_HERDSMAN_WORKSPACE_ID = workspace;
  process.env.PI_HERDSMAN_AGENT_DEFINITION = "agent";
  process.env.HERDR_PANE_ID = "registered-pane";
  if (allowedAgentDefinitions === undefined)
    delete process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS;
  else
    process.env.PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS = JSON.stringify(
      allowedAgentDefinitions,
    );
  resetAgentMailbox(mailbox);
  return mailbox;
}

function clearTestMailboxes(): void {
  for (const { path, state } of listAgentStates())
    if (state.workspaceId === WORKSPACE)
      realFs.rmSync(path, { recursive: true, force: true });
}

export function managedState(
  label: string,
  activeRequestId?: string,
  identity: FixtureIdentity = defaultFixtureIdentity,
): ManagedAgentState {
  return {
    version: 4,
    runId: AGENT_ID,
    ownerSessionId: LEAD_SESSION_ID,
    workspaceId: WORKSPACE,
    agentLabel: label,
    paneId: identity.paneId,
    piSessionId: identity.piSessionId,
    piSessionFile: identity.piSessionFile,
    cwd: "/tmp",
    ...(activeRequestId ? { activeRequestId } : {}),
    updatedAt: Date.now(),
  };
}

export function resultEntryDetails(
  state: ManagedAgentState,
  requestId: string,
) {
  return {
    runId: state.runId,
    requestId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    cwd: state.cwd,
    piSessionId: state.piSessionId,
    ...(state.piSessionFile !== undefined
      ? { piSessionFile: state.piSessionFile }
      : {}),
  };
}

export function listResponse(
  label: string,
  status: "idle" | "working" | "done" = "idle",
  sessionId: string | null = DEFAULT_PI_SESSION_ID,
  identity: FixtureIdentity = defaultFixtureIdentity,
  useAgentStatus = false,
  agentStatus: unknown = status,
  runId = AGENT_ID,
): string {
  const agent = {
    herdr_agent: runScopedHerdrAlias(WORKSPACE, label, runId),
    ...(useAgentStatus
      ? { agent_status: agentStatus, interactive_ready: agentStatus === "done" }
      : { status }),
    cwd: "/tmp",
    workspace_id: WORKSPACE,
    pane_id: identity.paneId,
    tab_id: identity.tabId,
    tab_label: "agents",
    ...(sessionId
      ? {
          agent_session: {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: sessionId,
          },
          session_path: identity.piSessionFile,
        }
      : {}),
  };
  return JSON.stringify({
    action: "list",
    workspace_id: WORKSPACE,
    tab: "",
    tabs: [],
    agents: [agent],
    available_panes: [],
    agent_definitions: [],
  });
}

export function requestRecordBytes(
  agentLabel: string,
  paneId: string,
  text: string,
): number {
  return Buffer.byteLength(
    JSON.stringify({
      version: 4,
      runId: AGENT_ID,
      requestId: REQUEST_ID,
      ownerSessionId: LEAD_SESSION_ID,
      workspaceId: WORKSPACE,
      agentLabel,
      paneId,
      kind: "task",
      text,
      createdAt: 1_700_000_000_000,
    }),
    "utf8",
  );
}

export function leadExec(
  label: string,
  status: "idle" | "working" | "done",
  session: string,
  onPrompt?: (mailbox: string, marker: string) => void,
  listSession: string | null = DEFAULT_PI_SESSION_ID,
  identity: FixtureIdentity = defaultFixtureIdentity,
  useAgentStatus = false,
  agentStatus: unknown = status,
): ExecHandler {
  return (command, args) => {
    if (command === "herdr" && args[0] === "agent" && args[1] === "list")
      return {
        stdout: listResponse(
          label,
          status,
          listSession,
          identity,
          useAgentStatus,
          agentStatus,
        ),
        stderr: "",
        code: 0,
      };
    if (command === "herdr" && isPaneList(args))
      return {
        stdout: JSON.stringify({
          result: {
            panes: [
              {
                pane_id: identity.paneId,
                workspace_id: WORKSPACE,
                cwd: "/tmp",
                agent: label,
                agent_status: useAgentStatus ? agentStatus : status,
              },
            ],
          },
        }),
        stderr: "",
        code: 0,
      };
    if (command === "herdr" && args[0] === "--version")
      return { stdout: "0.8.0", stderr: "", code: 0 };
    if (command === "herdr" && args[0] === "agent" && args[1] === "get")
      return {
        stdout: JSON.stringify({
          result: {
            agent: {
              name: herdrAlias(label),
              pane_id: identity.paneId,
              workspace_id: WORKSPACE,
              cwd: "/tmp",
              agent_session: {
                source: "herdr:pi",
                agent: "pi",
                kind: "id",
                value: session,
              },
              ...(useAgentStatus
                ? {
                    agent_status: agentStatus,
                    interactive_ready: agentStatus === "done",
                  }
                : {}),
            },
          },
        }),
        stderr: "",
        code: 0,
      };
    if (command === "herdr" && args[0] === "agent" && args[1] === "prompt") {
      onPrompt?.(agentMailboxPath(WORKSPACE, label), args.at(-1) ?? "");
      return { stdout: "{}", stderr: "", code: 0 };
    }
    return { stdout: "{}", stderr: "", code: 0 };
  };
}

export function agentFromState(
  state: ManagedAgentState,
  status: "idle" | "working" | "blocked" | "done" = "idle",
): Record<string, unknown> {
  const alias = runScopedHerdrAlias(
    state.workspaceId,
    state.agentLabel,
    state.runId,
  );
  return {
    name: alias,
    herdr_agent: alias,
    status,
    cwd: state.cwd,
    workspace_id: state.workspaceId,
    pane_id: state.paneId,
    tab_id: `${state.agentLabel}-tab`,
    tab_label: "agents",
    agent_session: {
      source: "herdr:pi",
      agent: "pi",
      kind: "id",
      value: state.piSessionId,
    },
  };
}

export function agentControllerExecutor(
  parent: ManagedAgentState,
  children: ManagedAgentState[] = [],
): ExecHandler {
  return (command, args) => {
    if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
    if (args[0] === "--version")
      return { stdout: "0.8.0", stderr: "", code: 0 };
    if (isAgentList(args))
      return {
        stdout: JSON.stringify({
          result: {
            agents: [parent, ...children].map((state) =>
              agentFromState(state, state.activeRequestId ? "working" : "idle"),
            ),
          },
        }),
        stderr: "",
        code: 0,
      };
    if (isPaneList(args))
      return {
        stdout: JSON.stringify({
          result: {
            panes: [parent, ...children].map((state) => ({
              pane_id: state.paneId,
              workspace_id: state.workspaceId,
              cwd: state.cwd,
              agent: state.agentLabel,
              agent_status: state.activeRequestId ? "working" : "idle",
            })),
          },
        }),
        stderr: "",
        code: 0,
      };
    if (args[0] === "agent" && args[1] === "get") {
      const requested = args[2];
      const state =
        requested ===
        runScopedHerdrAlias(parent.workspaceId, parent.agentLabel, parent.runId)
          ? parent
          : children.find(
              (candidate) =>
                candidate.paneId === requested ||
                runScopedHerdrAlias(
                  candidate.workspaceId,
                  candidate.agentLabel,
                  candidate.runId,
                ) === requested,
            );
      if (state)
        return {
          stdout: JSON.stringify({
            result: {
              agent: agentFromState(
                state,
                state.activeRequestId ? "working" : "idle",
              ),
            },
          }),
          stderr: "",
          code: 0,
        };
    }
    if (args[0] === "agent" && args[1] === "prompt") {
      const state = children.find((candidate) => candidate.paneId === args[2]);
      const marker = args.at(-1) ?? "";
      const requestId = marker.startsWith("__PI_HERDSMAN_AGENT_V4__:")
        ? marker.slice("__PI_HERDSMAN_AGENT_V4__:".length)
        : "";
      const request = state
        ? readRequest(agentMailboxPath(WORKSPACE, state.agentLabel), requestId)
        : undefined;
      if (state && request) {
        writeAgentState(agentMailboxPath(WORKSPACE, state.agentLabel), {
          ...state,
          ...(request.kind === "task"
            ? {
                activeRequestId: requestId,
                completedRequestId: undefined,
              }
            : {}),
          lastAck: {
            requestId,
            accepted: true,
            acknowledgedAt: Date.now(),
          },
          updatedAt: Date.now(),
        });
      }
      return { stdout: "{}", stderr: "", code: 0 };
    }
    return { stdout: "{}", stderr: "", code: 0 };
  };
}

export function delegatedLifecycleExecutor(
  parent: ManagedAgentState,
  initialChildren: ManagedAgentState[] = [],
  testCwd = "/tmp",
): {
  exec: ExecHandler;
  live: Map<string, ManagedAgentState>;
  closeOrder: string[];
  environmentCommands: string[];
  paneEnvironment: Record<string, string>;
} {
  const live = new Map(
    [parent, ...initialChildren].map((state) => [state.agentLabel, state]),
  );
  const slots = ["delegated-slot-1", "delegated-slot-2", "delegated-slot-3"];
  const childSessionIds = [
    CHILD_SESSION_ID,
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  const closeOrder: string[] = [];
  const environmentCommands: string[] = [];
  const closedPanes = new Set<string>();
  const paneEnvironment: Record<string, string> = {};
  const tabId = "delegated-tab";
  let createdChildren = 0;
  const currentStateForPane = (paneId: string): ManagedAgentState | undefined =>
    [...live.values()].find((state) => state.paneId === paneId);
  const agentForState = (
    state: ManagedAgentState,
  ): Record<string, unknown> => ({
    ...agentFromState(state, state.activeRequestId ? "working" : "idle"),
    tab_id: tabId,
    tab_label: "agents",
  });
  const panes = (): Record<string, unknown>[] => [
    ...[...live.values()].map((state) => ({
      pane_id: state.paneId,
      tab_id: tabId,
      workspace_id: WORKSPACE,
      cwd: state.cwd,
      foreground_cwd: state.cwd,
      agent: state.agentLabel,
      agent_status: state.activeRequestId ? "working" : "idle",
    })),
    ...slots
      .filter(
        (paneId) => !closedPanes.has(paneId) && !currentStateForPane(paneId),
      )
      .map((paneId) => ({
        pane_id: paneId,
        tab_id: tabId,
        workspace_id: WORKSPACE,
        cwd: testCwd,
        foreground_cwd: testCwd,
        agent_status: "unknown",
      })),
  ];
  return {
    live,
    closeOrder,
    environmentCommands,
    paneEnvironment,
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({
            result: { agents: [...live.values()].map(agentForState) },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "agent" && args[1] === "get") {
        const requested = args[2];
        const state =
          currentStateForPane(requested) ??
          [...live.values()].find(
            (candidate) =>
              runScopedHerdrAlias(
                candidate.workspaceId,
                candidate.agentLabel,
                candidate.runId,
              ) === requested,
          );
        return {
          stdout: JSON.stringify({
            result: { agent: state ? agentForState(state) : null },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (isTabList(args))
        return {
          stdout: JSON.stringify({
            result: {
              tabs: [
                { tab_id: tabId, label: "agents", workspace_id: WORKSPACE },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({ result: { panes: panes() } }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "get") {
        const state = currentStateForPane(args[2]!);
        return {
          stdout: JSON.stringify({
            result: {
              pane: state
                ? {
                    pane_id: state.paneId,
                    tab_id: tabId,
                    workspace_id: WORKSPACE,
                    cwd: state.cwd,
                    agent_session: {
                      kind: "id",
                      value: state.piSessionId,
                    },
                  }
                : undefined,
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "pane" && args[1] === "process-info")
        return (() => {
          return {
            stdout: JSON.stringify({
              result: {
                process: currentStateForPane(args.at(-1)!)
                  ? {
                      pane_id: args.at(-1),
                      shell_pid: 123,
                      foreground_process_group_id: 456,
                      foreground_processes: [
                        { pid: 456, argv0: "/usr/bin/pi" },
                      ],
                    }
                  : {
                      pane_id: args.at(-1),
                      shell_pid: 123,
                      foreground_process_group_id: 123,
                      foreground_processes: [{ pid: 123, argv0: "/bin/zsh" }],
                    },
              },
            }),
            stderr: "",
            code: 0,
          };
        })();
      if (args[0] === "pane" && args[1] === "layout")
        return {
          stdout: JSON.stringify({
            result: {
              layout: {
                workspace_id: WORKSPACE,
                tab_id: tabId,
                panes: panes().map((pane, index) => ({
                  pane_id: pane.pane_id,
                  rect: { width: 100 - index, height: 40 },
                })),
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "run") {
        const commandText = args.at(-1) ?? "";
        environmentCommands.push(commandText);
        for (const match of commandText.matchAll(
          /([A-Z][A-Z0-9_]*)='([^']*)'/g,
        ))
          paneEnvironment[match[1]] = match[2];
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (args[0] === "pane" && args[1] === "wait-output")
        return { stdout: "{}", stderr: "", code: 0 };
      if (args[0] === "pane" && args[1] === "split") {
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i] !== "--env") continue;
          const assignment = args[i + 1]!;
          const separator = assignment.indexOf("=");
          if (separator > 0) {
            environmentCommands.push(assignment);
            paneEnvironment[assignment.slice(0, separator)] = assignment.slice(
              separator + 1,
            );
          }
        }
        const paneId = slots.find(
          (candidate) =>
            !closedPanes.has(candidate) && !currentStateForPane(candidate),
        );
        if (!paneId) return { stdout: "{}", stderr: "no pane", code: 1 };
        return {
          stdout: JSON.stringify({
            result: { pane: { pane_id: paneId } },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "agent" && args[1] === "start") {
        const label = paneEnvironment.PI_HERDSMAN_LABEL;
        const runId = paneEnvironment.PI_HERDSMAN_RUN_ID;
        const ownerSessionId = paneEnvironment.PI_HERDSMAN_OWNER_SESSION_ID;
        const workspaceId = paneEnvironment.PI_HERDSMAN_WORKSPACE_ID;
        const paneId = args[args.indexOf("--pane") + 1];
        const state: ManagedAgentState = {
          version: 4,
          runId,
          ownerSessionId,
          workspaceId,
          agentLabel: label,
          paneId,
          piSessionId: childSessionIds[createdChildren++],
          piSessionFile: `/tmp/${label}.jsonl`,
          cwd: testCwd,
          updatedAt: Date.now(),
        };
        live.set(label, state);
        writeAgentState(agentMailboxPath(workspaceId, label), state);
        const agent = agentForState(state);
        return {
          stdout: JSON.stringify({
            result: {
              agent,
              tab_id: tabId,
              tab_label: "agents",
              pane_id: paneId,
              cwd: testCwd,
              herdr_agent: agent.name,
              created_tab: false,
              created_pane: true,
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "agent" && args[1] === "prompt") {
        const state = currentStateForPane(args[2]!);
        const requestId = (args.at(-1) ?? "").replace(
          "__PI_HERDSMAN_AGENT_V4__:",
          "",
        );
        const request = state
          ? readRequest(
              agentMailboxPath(WORKSPACE, state.agentLabel),
              requestId,
            )
          : undefined;
        if (state && request) {
          const next = {
            ...state,
            ...(request.kind === "task"
              ? { activeRequestId: requestId, completedRequestId: undefined }
              : {}),
            lastAck: {
              requestId,
              accepted: true,
              acknowledgedAt: Date.now(),
            },
            updatedAt: Date.now(),
          };
          live.set(state.agentLabel, next);
          writeAgentState(agentMailboxPath(WORKSPACE, state.agentLabel), next);
        }
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (args[0] === "pane" && args[1] === "close") {
        const state = currentStateForPane(args[2]!);
        if (!state) return { stdout: "{}", stderr: "missing pane", code: 1 };
        live.delete(state.agentLabel);
        closedPanes.add(state.paneId);
        closeOrder.push(state.agentLabel);
        return { stdout: "{}", stderr: "", code: 0 };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  };
}

export function cascadeExecutor(
  states: ManagedAgentState[],
  options: {
    failCloseLabel?: string;
    mismatchSessionLabel?: string;
    paneOnly?: string[];
    omitAgentLabels?: string[];
    omitPaneLabels?: string[];
  } = {},
): {
  exec: ExecHandler;
  closeOrder: string[];
  live: Map<string, ManagedAgentState>;
} {
  const live = new Map(states.map((state) => [state.agentLabel, state]));
  const paneOnly = new Set(options.paneOnly ?? []);
  const omitAgentLabels = new Set(options.omitAgentLabels ?? []);
  const omitPaneLabels = new Set(options.omitPaneLabels ?? []);
  const closeOrder: string[] = [];
  const paneFor = (paneId: string) =>
    [...live.values()].find((state) => state.paneId === paneId);
  return {
    closeOrder,
    live,
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (isAgentList(args)) {
        const agents = [...live.values()]
          .filter((state) => !omitAgentLabels.has(state.agentLabel))
          .map((state) => {
            const agent = agentFromState(state);
            if (state.agentLabel === options.mismatchSessionLabel)
              agent.agent_session = {
                kind: "id",
                value: "22222222-2222-4222-8222-222222222222",
              };
            return agent;
          });
        return {
          stdout: JSON.stringify({ result: { agents } }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "agent" && args[1] === "get") {
        const requested = args[2];
        const state =
          [...live.values()].find(
            (candidate) =>
              candidate.paneId === requested ||
              runScopedHerdrAlias(
                candidate.workspaceId,
                candidate.agentLabel,
                candidate.runId,
              ) === requested,
          ) ?? undefined;
        if (!state)
          return {
            stdout: JSON.stringify({ result: { agent: null } }),
            stderr: "",
            code: 0,
          };
        const agent = agentFromState(state);
        if (state.agentLabel === options.mismatchSessionLabel)
          agent.agent_session = {
            kind: "id",
            value: "22222222-2222-4222-8222-222222222222",
          };
        return {
          stdout: JSON.stringify({ result: { agent } }),
          stderr: "",
          code: 0,
        };
      }
      if (isTabList(args))
        return {
          stdout: JSON.stringify({
            result: {
              tabs: [...live.values()].map((state) => ({
                tab_id: `${state.agentLabel}-tab`,
                workspace_id: state.workspaceId,
              })),
            },
          }),
          stderr: "",
          code: 0,
        };
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({
            result: {
              panes: [
                ...[...live.values()]
                  .filter((state) => !omitPaneLabels.has(state.agentLabel))
                  .map((state) => ({
                    pane_id: state.paneId,
                    tab_id: `${state.agentLabel}-tab`,
                    workspace_id: state.workspaceId,
                    cwd: state.cwd,
                    foreground_cwd: state.cwd,
                    agent_status: "unknown",
                  })),
                ...[...paneOnly].map((paneId) => ({
                  pane_id: paneId,
                  workspace_id: WORKSPACE,
                  cwd: "/tmp",
                })),
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "get") {
        const state = paneFor(args[2]!);
        return {
          stdout: JSON.stringify({
            result: {
              pane: state
                ? {
                    pane_id: state.paneId,
                    tab_id: `${state.agentLabel}-tab`,
                    workspace_id: state.workspaceId,
                    cwd: state.cwd,
                    agent_session: {
                      kind: "id",
                      value: state.piSessionId,
                    },
                  }
                : undefined,
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          stdout: JSON.stringify({
            result: {
              process: {
                pane_id: args.at(-1),
                shell_pid: 123,
                foreground_process_group_id: 123,
                foreground_processes: [{ pid: 123, argv0: "/bin/zsh" }],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "close") {
        const state = paneFor(args[2]!);
        if (!state) return { stdout: "{}", stderr: "pane not found", code: 1 };
        if (state.agentLabel === options.failCloseLabel)
          return { stdout: "{}", stderr: "close failed", code: 1 };
        live.delete(state.agentLabel);
        closeOrder.push(state.agentLabel);
        return { stdout: "{}", stderr: "", code: 0 };
      }
      return { stdout: "{}", stderr: "", code: 0 };
    },
  };
}

export async function assertRestrictiveManagedDefinition(
  name: string,
  content: string,
): Promise<void> {
  const definitionPath = join(PI_AGENTS_DIR, `${name}.md`);
  setLeadEnvironment();
  realFs.writeFileSync(definitionPath, content);
  const environmentCommands: string[] = [];
  const startup = startupExecutor(name, () => DEFAULT_PI_SESSION_ID);
  const root = fakePi({
    exec: (command, args, options) => {
      if (command === "herdr" && args[0] === "pane" && args[1] === "run")
        environmentCommands.push(args.at(-1) ?? "");
      if (command === "herdr" && args[0] === "pane" && args[1] === "split") {
        const allowed = args.find((arg) =>
          arg.startsWith("PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS="),
        );
        if (allowed)
          environmentCommands.push(
            `PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS='${allowed.slice("PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS=".length)}'`,
          );
      }
      return startup.exec(command, args, options);
    },
  });
  let allowedAgentDefinitions: string[] = [];
  try {
    registerExtension!(root.pi as never);
    const result = await root.tools[0].execute(
      "id",
      {
        action: "delegate",
        definition: name,
        label: name,
        task: "restricted task",
      },
      undefined,
      undefined,
      fakeContext(),
    );
    assert.equal(result.details.ok, true, JSON.stringify(result.details));
    const environment = environmentCommands.find((command) =>
      command.includes("PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS="),
    );
    assert.ok(environment);
    const encoded = /PI_HERDSMAN_ALLOWED_AGENT_DEFINITIONS='([^']*)'/.exec(
      environment,
    )?.[1];
    assert.equal(encoded, "[]");
    allowedAgentDefinitions = JSON.parse(encoded);
  } catch (error) {
    realFs.rmSync(definitionPath, { force: true });
    throw error;
  } finally {
    root.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(startup.mailbox);
  }

  const mailbox = setAgentEnvironment(name, allowedAgentDefinitions);
  process.env.PI_HERDSMAN_AGENT_DEFINITION = name;
  const agent = fakePi();
  registerExtension!(agent.pi as never);
  try {
    assert.equal(agent.tools.filter((tool) => tool.name === "agent").length, 0);
    assert.equal(
      agent.tools.filter((tool) => tool.name === "ask_owner").length,
      1,
    );
    await agent.events.get("session_start")![0](
      undefined,
      fakeAgentContext(agent.entries),
    );
  } finally {
    agent.events.get("session_shutdown")?.[0]();
    resetAgentMailbox(mailbox);
    realFs.rmSync(definitionPath, { force: true });
    setLeadEnvironment();
  }
}

export function testGate<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

export async function waitForTestCondition(
  condition: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(message);
}

export function createStagedAssignmentFixture(
  label: string,
  fastCompletion = false,
) {
  setLeadEnvironment();
  const startup = startupExecutor(label, () => DEFAULT_PI_SESSION_ID);
  const initialStatus = testGate<ExecResult>();
  const start = testGate<void>();
  const preSubmitValidation = testGate<void>();
  const prompt = testGate<void>();
  let holdInitialStatus = true;
  let holdStart = true;
  let holdPreSubmitValidation = true;
  let holdPrompt = true;
  let started = false;
  let paneClosed = false;
  let promptRequestId: string | undefined;
  let preSubmitValidationReady = false;
  let acceptedRequestIdWritten: string | undefined;
  let workingObservations = 0;

  const pi = fakePi({
    persistMessages: true,
    exec: async (command, args, options) => {
      if (command === "herdr" && isAgentList(args)) {
        if (holdInitialStatus) {
          holdInitialStatus = false;
          return initialStatus.promise;
        }
        if (!started)
          return {
            stdout: JSON.stringify({ id: 1, result: { agents: [] } }),
            stderr: "",
            code: 0,
          };
        const result = await startup.exec(command, args, options);
        const payload = JSON.parse(result.stdout);
        const agents = payload.result?.agents ?? payload.agents ?? [];
        if (
          agents.some(
            (agent: any) => (agent.agent_status ?? agent.status) === "working",
          )
        )
          workingObservations++;
        return result;
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        if (holdPreSubmitValidation && args[2] === "startup-pane") {
          holdPreSubmitValidation = false;
          preSubmitValidationReady = true;
          await preSubmitValidation.promise;
        }
        return startup.exec(command, args, options);
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "start") {
        if (holdStart) {
          holdStart = false;
          await start.promise;
        }
        const result = await startup.exec(command, args, options);
        const state = readAgentState(startup.mailbox);
        assert.ok(state, "staged startup must create mailbox state");
        writeAgentState(startup.mailbox, {
          ...state,
          updatedAt: Date.now(),
        });
        started = true;
        return result;
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "prompt") {
        promptRequestId = (args.at(-1) ?? "").slice(
          "__PI_HERDSMAN_AGENT_V4__:".length,
        );
        if (holdPrompt) {
          holdPrompt = false;
          await prompt.promise;
        }
        const result = await startup.exec(command, args, options);
        const state = readAgentState(startup.mailbox);
        assert.ok(state, "staged prompt must retain mailbox state");
        acceptedRequestIdWritten = state.activeRequestId;
        writeAgentState(startup.mailbox, {
          ...state,
          activeRequestId: undefined,
          completedRequestId: undefined,
          updatedAt: Date.now(),
        });
        return result;
      }
      if (command === "herdr" && isPaneClose(args)) {
        paneClosed = true;
        started = false;
      }
      if (command === "herdr" && isPaneList(args) && paneClosed)
        return {
          stdout: JSON.stringify({ id: 1, result: { panes: [] } }),
          stderr: "",
          code: 0,
        };
      return startup.exec(command, args, options);
    },
  });
  const context = fakeContext(pi.entries) as any;
  context.mode = "tui";
  context.hasUI = true;
  let widget: StatusWidget | undefined;
  context.ui = {
    setWidget: (_key: string, content: unknown) => {
      assertWidgetContent(content);
      if (typeof content === "function")
        widget = content(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
        );
    },
  };

  registerExtension!(pi.pi as never);
  const sessionStart = pi.events.get("session_start")![0](undefined, context);
  const emptyStatus = (): ExecResult => ({
    stdout: JSON.stringify({ id: 1, result: { agents: [] } }),
    stderr: "",
    code: 0,
  });
  return {
    pi,
    context,
    startup,
    sessionStart,
    mailbox: startup.mailbox,
    get widgetValue(): StatusWidget {
      assert.ok(widget, "staged fixture did not create a status widget");
      return widget;
    },
    get promptRequestId(): string {
      assert.ok(promptRequestId, "staged fixture did not reach prompt");
      return promptRequestId;
    },
    get promptRequested(): boolean {
      return promptRequestId !== undefined;
    },
    get preSubmitValidationReady(): boolean {
      return preSubmitValidationReady;
    },
    get acceptedRequestIdWritten(): string {
      assert.ok(
        acceptedRequestIdWritten,
        "staged fixture did not write an accepted request",
      );
      return acceptedRequestIdWritten;
    },
    get workingObservations(): number {
      return workingObservations;
    },
    releaseInitialStatus: () => initialStatus.resolve(emptyStatus()),
    releaseStart: () => start.resolve(),
    releasePreSubmitValidation: () => preSubmitValidation.resolve(),
    releasePrompt: () => prompt.resolve(),
    async list() {
      return pi.tools[0].execute(
        "id",
        { action: "list" },
        undefined,
        undefined,
        context,
      );
    },
    markWorking(requestId: string) {
      const state = readAgentState(startup.mailbox);
      assert.ok(state);
      writeAgentState(startup.mailbox, {
        ...state,
        activeRequestId: requestId,
        completedRequestId: undefined,
        updatedAt: Date.now(),
      });
    },
    completeFast(requestId: string) {
      assert.equal(fastCompletion, true);
      const state = readAgentState(startup.mailbox);
      assert.ok(state);
      writeAgentState(startup.mailbox, {
        ...state,
        activeRequestId: undefined,
        completedRequestId: requestId,
        updatedAt: Date.now(),
      });
      writeResult(startup.mailbox, {
        version: 4,
        runId: state.runId,
        requestId,
        ownerSessionId: state.ownerSessionId,
        workspaceId: state.workspaceId,
        agentLabel: state.agentLabel,
        paneId: state.paneId,
        status: "completed",
        text: "completed before working was observed",
        completedAt: Date.now(),
      });
      watchedResultPaths.get(`${startup.mailbox}/result-${requestId}.json`)?.(
        {},
        {},
      );
    },
    shutdown() {
      pi.events.get("session_shutdown")?.[0]();
      resetAgentMailbox(startup.mailbox);
    },
  };
}

export function writeMetadataTask(
  mailbox: string,
  text: string,
  requestId = REQUEST_ID,
): RequestRecord {
  const state = readAgentState(mailbox)!;
  const request: RequestRecord = {
    version: 4,
    runId: state.runId,
    requestId,
    ownerSessionId: state.ownerSessionId,
    workspaceId: state.workspaceId,
    agentLabel: state.agentLabel,
    paneId: state.paneId,
    kind: "task",
    text,
    createdAt: Date.now(),
  };
  writeRequest(mailbox, request);
  return request;
}

export function startupExecutor(
  label: string,
  sessionForGet: (count: number) => string | null,
  onGet?: (count: number) => void,
  onPrompt?: (text: string, request?: RequestRecord) => void,
  reportNullSession = false,
  onStart?: (args: string[]) => void,
  testCwd = "/tmp",
  testRunId = AGENT_ID,
  includeResult = false,
  closePaneOnClose = false,
  countStartup = false,
): { exec: ExecHandler; mailbox: string; getCount: () => number } {
  const mailbox = agentMailboxPath(WORKSPACE, label);
  let getCount = 0;
  let runId = testRunId;
  let ownerSessionId = testRunId ? LEAD_SESSION_ID : "";
  let activePaneId = "startup-pane";
  const paneEnvironment: Record<string, string> = {};
  let stopped = false;
  const emptyList = () => {
    const value = JSON.parse(listResponse(label));
    value.agents = [];
    return JSON.stringify(value);
  };
  return {
    mailbox,
    getCount: () => getCount,
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        if (countStartup && args[2] !== "startup-pane") getCount++;
        if (args[2] !== "startup-pane")
          return {
            stdout: JSON.stringify({
              result: {
                agent: {
                  name: args[2],
                  pane_id: "startup-pane",
                  tab_id: "startup-tab",
                  workspace_id: WORKSPACE,
                  cwd: testCwd,
                  agent_session: {
                    kind: "id",
                    value: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                  },
                },
              },
            }),
            stderr: "",
            code: 0,
          };
        getCount++;
        onGet?.(getCount);
        const session = sessionForGet(getCount);
        return {
          stdout: JSON.stringify({
            result: {
              agent: {
                name: runScopedHerdrAlias(WORKSPACE, label, runId || AGENT_ID),
                pane_id: "startup-pane",
                workspace_id: WORKSPACE,
                cwd: testCwd,
                ...(session
                  ? {
                      agent_session: {
                        kind: "id",
                        value: session,
                      },
                    }
                  : reportNullSession
                    ? { agent_session: null }
                    : {}),
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (command === "herdr" && args[0] === "agent" && args[1] === "prompt") {
        const requestId = args
          .at(-1)!
          .slice("__PI_HERDSMAN_AGENT_V4__:".length);
        const request = readRequest(mailbox, requestId);
        onPrompt?.(request?.text ?? "", request);
        const state = readAgentState(mailbox)!;
        writeAgentState(mailbox, {
          ...state,
          ...(request?.kind === "task"
            ? { activeRequestId: requestId, completedRequestId: undefined }
            : {}),
          lastAck: { requestId, accepted: true, acknowledgedAt: Date.now() },
          updatedAt: Date.now(),
        });
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isTabList(args))
        return {
          stdout: JSON.stringify({
            result: {
              tabs: [
                {
                  tab_id: "startup-tab",
                  label: "agents",
                  workspace_id: WORKSPACE,
                },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({
            result: {
              panes:
                closePaneOnClose && stopped
                  ? []
                  : [
                      {
                        pane_id: "startup-pane",
                        tab_id: "startup-tab",
                        workspace_id: WORKSPACE,
                        cwd: testCwd,
                        foreground_cwd: testCwd,
                        ...(runId && !stopped && readAgentState(mailbox)
                          ? {
                              agent: label,
                              agent_status: "idle",
                            }
                          : { agent_status: "unknown" }),
                      },
                    ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "process-info")
        return {
          stdout: JSON.stringify({
            result: {
              process: {
                pane_id: activePaneId,
                shell_pid: 123,
                foreground_process_group_id: 123,
                foreground_processes: [{ pid: 123, argv0: "/bin/zsh" }],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "layout")
        return {
          stdout: JSON.stringify({
            result: {
              layout: {
                workspace_id: WORKSPACE,
                tab_id: "registered-tab",
                panes: [
                  { pane_id: activePaneId, rect: { width: 100, height: 40 } },
                ],
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "split") {
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i] !== "--env") continue;
          const assignment = args[i + 1]!;
          const separator = assignment.indexOf("=");
          if (separator <= 0) continue;
          const key = assignment.slice(0, separator);
          const value = assignment.slice(separator + 1);
          if (key === "PI_HERDSMAN_RUN_ID") runId = value;
          if (key === "PI_HERDSMAN_OWNER_SESSION_ID") ownerSessionId = value;
        }
        return {
          stdout: JSON.stringify({
            result: { pane: { pane_id: activePaneId } },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "pane" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            result: {
              pane: {
                pane_id: "startup-pane",
                tab_id: "startup-tab",
                workspace_id: WORKSPACE,
                cwd: testCwd,
                agent_session: {
                  kind: "id",
                  value: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                },
              },
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "layout")
        return {
          stdout: JSON.stringify({
            result: {
              panes: [
                { pane_id: "startup-pane", rect: { width: 1, height: 1 } },
              ],
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "split") {
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i] !== "--env") continue;
          const assignment = args[i + 1]!;
          const separator = assignment.indexOf("=");
          if (separator > 0)
            paneEnvironment[assignment.slice(0, separator)] = assignment.slice(
              separator + 1,
            );
          if (assignment.startsWith("PI_HERDSMAN_RUN_ID="))
            runId = assignment.slice(19);
          if (assignment.startsWith("PI_HERDSMAN_OWNER_SESSION_ID="))
            ownerSessionId = assignment.slice(29);
        }
        return {
          stdout: JSON.stringify({
            result: { pane: { pane_id: "startup-pane" } },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (
        args[0] === "pane" &&
        (args[1] === "run" || args[1] === "wait-output")
      ) {
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (isAgentList(args))
        return {
          stdout:
            runId && !stopped && readAgentState(mailbox)
              ? (() => {
                  const state = readAgentState(mailbox)!;
                  const value = JSON.parse(
                    listResponse(
                      label,
                      state.activeRequestId ? "working" : "idle",
                    ),
                  );
                  const alias = runScopedHerdrAlias(
                    WORKSPACE,
                    label,
                    state.runId,
                  );
                  value.agents[0].herdr_agent = alias;
                  value.agents[0].name = alias;
                  value.agents[0].pane_id = "startup-pane";
                  value.agents[0].tab_id = "startup-tab";
                  return JSON.stringify(value);
                })()
              : emptyList(),
          stderr: "",
          code: 0,
        };
      if (isPaneClose(args)) {
        if (closePaneOnClose) stopped = true;
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (isPreservePaneStop(args)) {
        stopped = true;
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (args[0] === "agent" && args[1] === "start") {
        onStart?.(args);
      }
      const startedAgent = {
        name: args[2],
        pane_id: activePaneId,
        tab_id: "startup-tab",
        workspace_id: WORKSPACE,
        cwd: testCwd,
        agent_session: {
          kind: "id",
          value: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        },
      };
      writeAgentState(mailbox, {
        version: 4,
        runId,
        ownerSessionId,
        workspaceId: WORKSPACE,
        agentLabel: label,
        paneId: activePaneId,
        piSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        piSessionFile: "/tmp/registered-agent.jsonl",
        cwd: testCwd,
        updatedAt: Date.now(),
      });
      return {
        stdout: JSON.stringify({
          ...(includeResult ? { result: { agent: startedAgent } } : {}),
          tab_id: "startup-tab",
          tab_label: "agents",
          pane_id: activePaneId,
          cwd: testCwd,
          herdr_agent: runScopedHerdrAlias(WORKSPACE, label, runId || AGENT_ID),
          created_tab: false,
          created_pane: true,
          agent: startedAgent,
          runtime_identity: {
            herdr_agent: runScopedHerdrAlias(
              WORKSPACE,
              label,
              runId || AGENT_ID,
            ),
            herdr_kind: "pi",
            agent_definition: null,
            model: null,
            thinking: null,
            cwd: testCwd,
            resumed: false,
            session_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            session_name: null,
          },
        }),
        stderr: "",
        code: 0,
      };
    },
  };
}

export function skillBlock(skill: string, name: string): string {
  const start = `<!-- pi-herdsman-runtime-${name}:start -->`;
  const end = `<!-- pi-herdsman-runtime-${name}:end -->`;
  const from = skill.indexOf(start);
  const to = skill.indexOf(end);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  assert.ok(to > from, `${name} markers out of order`);
  return skill
    .slice(from + start.length, to)
    .trim()
    .replaceAll(/\s+/g, " ");
}

export function promptLaunchContents(args: string[]): string[] {
  const contents: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (
      args[index] === "--system-prompt" ||
      args[index] === "--append-system-prompt"
    )
      contents.push(readFileSync(args[index + 1]!, "utf8"));
  }
  return contents;
}

export function promptLaunchPaths(args: string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (
      args[index] === "--system-prompt" ||
      args[index] === "--append-system-prompt"
    )
      paths.push(args[index + 1]!);
  }
  return paths;
}

export function writePromptDefinition(
  path: string,
  name: string,
  promptPath: string,
): void {
  realFs.writeFileSync(
    path,
    `---\nname: ${name}\n---\ndefinition body\n@${promptPath}\n`,
  );
}

export default {
  get sessionOpenError() {
    return sessionOpenError;
  },
  set sessionOpenError(value: unknown) {
    sessionOpenError = value;
  },
  get failNextMailboxWrite() {
    return failNextMailboxWrite;
  },
  set failNextMailboxWrite(value: boolean) {
    failNextMailboxWrite = value;
  },
  get failNextResultRemoval() {
    return failNextResultRemoval;
  },
  set failNextResultRemoval(value: boolean) {
    failNextResultRemoval = value;
  },
  get resultRemovalAttempts() {
    return resultRemovalAttempts;
  },
  set resultRemovalAttempts(value: number) {
    resultRemovalAttempts = value;
  },
  get agentDefinitionReadCount() {
    return agentDefinitionReadCount;
  },
  set agentDefinitionReadCount(value: number) {
    agentDefinitionReadCount = value;
  },
  get settingsAccessHook() {
    return settingsAccessHook;
  },
  set settingsAccessHook(value: typeof settingsAccessHook) {
    settingsAccessHook = value;
  },
};
