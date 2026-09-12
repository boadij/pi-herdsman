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
import { herdsmanTempRoot } from "./storage.ts";

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
export let failNextRequestRemoval = false;
export let failNextResultRemoval = false;
export let resultRemovalAttempts = 0;
export let agentDefinitionReadCount = 0;
export let configReadHook: (() => void) | undefined;

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
export const testTmpRoot = realFs.mkdtempSync(
  join(tmpdir(), "pi-herdsman-test-"),
);
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
process.env.PI_CODING_AGENT_DIR = PI_AGENT_ROOT;
export const PI_AGENTS_DIR = join(PI_AGENT_ROOT, "agents");
realFs.mkdirSync(PI_AGENTS_DIR);
realFs.writeFileSync(
  join(PI_AGENTS_DIR, "agent.md"),
  "---\nname: agent\n---\nagent instructions\n",
);
const { parseFrontmatter: nativeParseFrontmatter } =
  await import("@earendil-works/pi-coding-agent");
after(() => realFs.rmSync(testTmpRoot, { recursive: true, force: true }));
mock.module("node:fs", {
  namedExports: {
    accessSync: realFs.accessSync,
    constants: realFs.constants,
    closeSync: realFs.closeSync,
    chmodSync: realFs.chmodSync,
    existsSync: (path: string) => {
      if (path === join(PI_AGENT_ROOT, "pi-herdsman", "config.json"))
        configReadHook?.();
      return realFs.existsSync(path);
    },
    fstatSync: realFs.fstatSync,
    fsyncSync: realFs.fsyncSync,
    mkdirSync: realFs.mkdirSync,
    openSync: (...args: any[]) => {
      return realFs.openSync(...args);
    },
    readFileSync: (...args: any[]) => {
      if (args[0] === join(PI_AGENT_ROOT, "pi-herdsman", "config.json"))
        configReadHook?.();
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
      if (failNextRequestRemoval && path.includes("/request-")) {
        failNextRequestRemoval = false;
        throw new Error("injected request removal failure");
      }
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
    watch: realFs.watch,
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
  readUnacknowledgedRequest,
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
    parseFrontmatter: nativeParseFrontmatter,
    loadProjectContextFiles: ({ cwd }: { cwd: string }) => {
      projectContextCwds.push(cwd);
      return [];
    },
    SessionManager: {
      listAll: async () => [...nativeSessions.values()],
      open: (path: string) => {
        if (sessionOpenError !== undefined) throw sessionOpenError;
        const session = [...nativeSessions.values()].find(
          (item) => item.path === path,
        );
        return {
          getSessionId: () => session?.id ?? DEFAULT_PI_SESSION_ID,
          getSessionFile: () => session?.path,
          getHeader: () => (session ? { cwd: session.cwd } : null),
          getCwd: () => resolve(session?.cwd || process.cwd()),
          getSessionName: () => session?.sessionName,
          getEntries: () =>
            session?.entries ?? [
              {
                type: "custom",
                customType: "pi-herdsman-agent-definition",
                data: {
                  sessionId: session?.id ?? DEFAULT_PI_SESSION_ID,
                  definition: "agent",
                  label: "agent",
                },
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
    contentText: (
      content: string | readonly { type: string; text: string }[],
      separator = "\n",
    ) =>
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(separator),
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
  sessionAgentIdentity,
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
    herdsmanTempRoot(),
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
    getContextUsage: () => ({ tokens: 2, contextWindow: 10, percent: null }),
    sessionManager: {
      getSessionId: () => LEAD_SESSION_ID,
      getSessionFile: () => "/tmp/root.jsonl",
      getSessionName: () => undefined,
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

const HERDR_STATUS_RESPONSE = JSON.stringify({
  client: { version: "0.9.0" },
  server: { running: true, compatible: true },
});
function herdrStatusResult(): ExecResult {
  return { stdout: HERDR_STATUS_RESPONSE, stderr: "", code: 0 };
}

export function fakePi(
  options: {
    exec?: ExecHandler;
    sendMessage?: (message: unknown) => void | Promise<void>;
    sendUserMessage?: (content: unknown, options?: unknown) => void;
    entries?: unknown[];
    activeTools?: string[] | (() => string[]);
    autoActivateRegisteredTools?: boolean;
    persistMessages?: boolean;
    sessionName?: string;
    thinkingLevel?: string;
    status?: ExecResult;
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
    getThinkingLevel() {
      return options.thinkingLevel ?? "medium";
    },
    async exec(
      command: string,
      args: string[],
      execOptionsValue: { timeout?: number; signal?: AbortSignal } = {},
    ) {
      calls.push(args);
      execOptions.push(execOptionsValue);
      if (command === "herdr" && args[0] === "status" && args[1] === "--json") {
        const result = options.status ?? herdrStatusResult();
        callResults.push({ args, succeeded: true, code: result.code });
        return result;
      }
      try {
        const result = await (options.exec?.(
          command,
          args,
          execOptionsValue,
        ) ?? {
          stdout:
            command === "herdr" && isAgentList(args)
              ? JSON.stringify({ id: AGENT_ID, result: { agents: [] } })
              : "{}",
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
    sendUserMessage(content: unknown, sendOptions?: unknown) {
      sentUsers.push(content);
      sentUserCalls.push({ content, options: sendOptions });
      options.sendUserMessage?.(content, sendOptions);
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
    name: runScopedHerdrAlias(WORKSPACE, label, runId),
    agent_status: useAgentStatus ? agentStatus : status,
    ...(useAgentStatus ? { interactive_ready: agentStatus === "done" } : {}),
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
  onRequest?: (mailbox: string, marker: string) => void,
  listSession: string | null = DEFAULT_PI_SESSION_ID,
  identity: FixtureIdentity = defaultFixtureIdentity,
  useAgentStatus = false,
  agentStatus: unknown = status,
): ExecHandler {
  const mailbox = agentMailboxPath(WORKSPACE, label);
  consumeMailboxRequest(mailbox, (request) => {
    if (onRequest) onRequest(mailbox, controlMarker(request.requestId));
    else acceptMailboxRequest(mailbox, request);
  });
  return (command, args) => {
    if (command === "herdr" && args[0] === "status" && args[1] === "--json")
      return herdrStatusResult();
    if (command === "herdr" && args[0] === "agent" && args[1] === "list")
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: JSON.parse(
            listResponse(
              label,
              status,
              listSession,
              identity,
              useAgentStatus,
              agentStatus,
            ),
          ),
        }),
        stderr: "",
        code: 0,
      };
    if (command === "herdr" && isPaneList(args))
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
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
          id: AGENT_ID,
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
    agent_status: status,
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
  for (const child of [parent, ...children])
    consumeMailboxRequest(
      agentMailboxPath(child.workspaceId, child.agentLabel),
      (request) =>
        acceptMailboxRequest(
          agentMailboxPath(child.workspaceId, child.agentLabel),
          request,
        ),
    );
  return (command, args) => {
    if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
    if (args[0] === "status" && args[1] === "--json")
      return herdrStatusResult();
    if (args[0] === "--version")
      return { stdout: "0.8.0", stderr: "", code: 0 };
    if (isAgentList(args))
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
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
          id: AGENT_ID,
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
            id: AGENT_ID,
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
    return { stdout: "{}", stderr: "", code: 0 };
  };
}

export function delegatedLifecycleExecutor(
  parent: ManagedAgentState,
  initialChildren: ManagedAgentState[] = [],
  testCwd = "/tmp",
  callerPane?: { paneId: string; tabId: string },
): {
  exec: ExecHandler;
  live: Map<string, ManagedAgentState>;
  closeOrder: string[];
  environmentCommands: string[];
  paneEnvironment: Record<string, string>;
  createdTabs: () => number;
  tabForPane: (paneId: string) => string | undefined;
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
  const tabByPane = new Map(
    [parent, ...initialChildren].map((state) => [
      state.paneId,
      "delegated-tab",
    ]),
  );
  const tabLabels = new Map([["delegated-tab", "agents"]]);
  if (callerPane) {
    tabByPane.set(callerPane.paneId, callerPane.tabId);
    tabLabels.set(callerPane.tabId, "lead");
  }
  let createdTabs = 0;
  let createdChildren = 0;
  const currentStateForPane = (paneId: string): ManagedAgentState | undefined =>
    [...live.values()].find((state) => state.paneId === paneId);
  const agentForState = (
    state: ManagedAgentState,
  ): Record<string, unknown> => ({
    ...agentFromState(state, state.activeRequestId ? "working" : "idle"),
    tab_id: tabByPane.get(state.paneId),
    tab_label: tabLabels.get(tabByPane.get(state.paneId) ?? ""),
  });
  const panes = (): Record<string, unknown>[] => [
    ...(callerPane
      ? [
          {
            pane_id: callerPane.paneId,
            tab_id: callerPane.tabId,
            workspace_id: WORKSPACE,
            cwd: testCwd,
            foreground_cwd: testCwd,
            agent: "pi",
            agent_status: "idle",
          },
        ]
      : []),
    ...[...live.values()].map((state) => ({
      pane_id: state.paneId,
      tab_id: tabByPane.get(state.paneId),
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
        tab_id: tabByPane.get(paneId) ?? "delegated-tab",
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
    createdTabs: () => createdTabs,
    tabForPane: (paneId) => tabByPane.get(paneId),
    exec: (command, args) => {
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (isAgentList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
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
            id: AGENT_ID,
            result: { agent: state ? agentForState(state) : null },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (isTabList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              tabs: [...tabLabels].map(([tab_id, label]) => ({
                tab_id,
                label,
                workspace_id: WORKSPACE,
              })),
            },
          }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "tab" && args[1] === "create") {
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
        const createdTabId = `delegated-tab-${++createdTabs}`;
        const rootPane = slots.find(
          (paneId) => !closedPanes.has(paneId) && !currentStateForPane(paneId),
        );
        if (!rootPane) return { stdout: "{}", stderr: "no pane", code: 1 };
        tabLabels.set(createdTabId, "agents");
        tabByPane.set(rootPane, createdTabId);
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              tab: { tab_id: createdTabId },
              root_pane: { pane_id: rootPane },
            },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({ id: AGENT_ID, result: { panes: panes() } }),
          stderr: "",
          code: 0,
        };
      if (args[0] === "pane" && args[1] === "get") {
        const state = currentStateForPane(args[2]!);
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              pane: state
                ? {
                    pane_id: state.paneId,
                    tab_id: tabByPane.get(state.paneId),
                    workspace_id: WORKSPACE,
                    cwd: state.cwd,
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
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
              id: AGENT_ID,
              result: {
                process_info: currentStateForPane(args.at(-1)!)
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
            id: AGENT_ID,
            result: {
              layout: {
                workspace_id: WORKSPACE,
                tab_id: tabByPane.get(args.at(-1) ?? "") ?? "delegated-tab",
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
        const anchor = args[args.indexOf("--pane") + 1];
        tabByPane.set(paneId, tabByPane.get(anchor ?? "") ?? "delegated-tab");
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
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
        const tabForPane = tabByPane.get(paneId) ?? "delegated-tab";
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
        tabByPane.set(paneId, tabForPane);
        writeAgentState(agentMailboxPath(workspaceId, label), state);
        consumeMailboxRequest(agentMailboxPath(workspaceId, label), (request) =>
          acceptMailboxRequest(agentMailboxPath(workspaceId, label), request),
        );
        const agent = agentForState(state);
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              agent,
              tab_id: tabForPane,
              tab_label: tabLabels.get(tabForPane),
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
      if (args[0] === "status" && args[1] === "--json")
        return herdrStatusResult();
      if (args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (isAgentList(args)) {
        const agents = [...live.values()]
          .filter((state) => !omitAgentLabels.has(state.agentLabel))
          .map((state) => {
            const agent = agentFromState(state);
            if (state.agentLabel === options.mismatchSessionLabel)
              agent.agent_session = {
                source: "herdr:pi",
                agent: "pi",
                kind: "id",
                value: "22222222-2222-4222-8222-222222222222",
              };
            return agent;
          });
        return {
          stdout: JSON.stringify({ id: AGENT_ID, result: { agents } }),
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
            stdout: JSON.stringify({ id: AGENT_ID, result: { agent: null } }),
            stderr: "",
            code: 0,
          };
        const agent = agentFromState(state);
        if (state.agentLabel === options.mismatchSessionLabel)
          agent.agent_session = {
            source: "herdr:pi",
            agent: "pi",
            kind: "id",
            value: "22222222-2222-4222-8222-222222222222",
          };
        return {
          stdout: JSON.stringify({ id: AGENT_ID, result: { agent } }),
          stderr: "",
          code: 0,
        };
      }
      if (isTabList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
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
            id: AGENT_ID,
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
            id: AGENT_ID,
            result: {
              pane: state
                ? {
                    pane_id: state.paneId,
                    tab_id: `${state.agentLabel}-tab`,
                    workspace_id: state.workspaceId,
                    cwd: state.cwd,
                    agent_session: {
                      source: "herdr:pi",
                      agent: "pi",
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
            id: AGENT_ID,
            result: {
              process_info: {
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
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(message);
}

export function consumeMailboxRequest(
  mailbox: string,
  onRequest: (request: RequestRecord) => void | Promise<void>,
): () => void {
  let seen: string | undefined;
  let stopped = false;
  let mailboxInitialized = false;
  let processing = false;
  const poll = () => {
    if (stopped || processing) return;
    try {
      if (readAgentState(mailbox)) mailboxInitialized = true;
      else if (mailboxInitialized) {
        stopped = true;
        clearInterval(timer);
        return;
      }
      const request = readUnacknowledgedRequest(mailbox);
      if (!request || request.requestId === seen) return;
      processing = true;
      Promise.resolve()
        .then(() => onRequest(request))
        .then(() => {
          seen = request.requestId;
        })
        .catch(() => {})
        .finally(() => {
          processing = false;
        });
    } catch {
      // Controller tests retain malformed requests just like a live child.
    }
  };
  const timer = setInterval(poll, 10);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function acceptMailboxRequest(mailbox: string, request: RequestRecord): void {
  const state = readAgentState(mailbox);
  if (!state) return;
  writeAgentState(mailbox, {
    ...state,
    ...(request.kind === "task"
      ? { activeRequestId: request.requestId, completedRequestId: undefined }
      : {}),
    lastAck: {
      requestId: request.requestId,
      accepted: true,
      acknowledgedAt: Date.now(),
    },
    updatedAt: Date.now(),
  });
}

export function createStagedAssignmentFixture(
  label: string,
  fastCompletion = false,
) {
  setLeadEnvironment();
  const startupMailbox = agentMailboxPath(WORKSPACE, label);
  const initialStatus = testGate<ExecResult>();
  const start = testGate<void>();
  const preSubmitValidation = testGate<void>();
  const handoff = testGate<void>();
  let holdInitialStatus = true;
  let holdStart = true;
  let holdPreSubmitValidation = true;
  let holdHandoff = true;
  let started = false;
  let paneClosed = false;
  let requestId: string | undefined;
  let preSubmitValidationReady = false;
  let acceptedRequestIdWritten: string | undefined;
  let workingObservations = 0;
  const startup = startupExecutor(
    label,
    () => DEFAULT_PI_SESSION_ID,
    undefined,
    async (_text, request) => {
      requestId = request?.requestId;
      if (holdHandoff) {
        holdHandoff = false;
        await handoff.promise;
      }
    },
    false,
    undefined,
    "/tmp",
    AGENT_ID,
    false,
    false,
    false,
    (request) => {
      const state = readAgentState(startupMailbox);
      assert.ok(state, "staged request must retain mailbox state");
      acceptedRequestIdWritten = state.activeRequestId;
      writeAgentState(startupMailbox, {
        ...state,
        activeRequestId: undefined,
        completedRequestId: undefined,
        updatedAt: Date.now(),
      });
    },
  );

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
        if (agents.some((agent: any) => agent.agent_status === "working"))
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
    get requestId(): string {
      assert.ok(requestId, "staged fixture did not observe a request");
      return requestId;
    },
    get requestObserved(): boolean {
      return requestId !== undefined;
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
    releaseAcknowledgement: () => handoff.resolve(),
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
  onRequest?: (text: string, request?: RequestRecord) => void | Promise<void>,
  reportNullSession = false,
  onStart?: (args: string[]) => void,
  testCwd = "/tmp",
  testRunId = AGENT_ID,
  includeResult = false,
  closePaneOnClose = false,
  countStartup = false,
  onAccepted?: (request: RequestRecord) => void | Promise<void>,
  sessionFile = "/tmp/registered-agent.jsonl",
): {
  exec: ExecHandler;
  mailbox: string;
  getCount: () => number;
  stopMailboxConsumer: () => void;
} {
  const mailbox = agentMailboxPath(WORKSPACE, label);
  let getCount = 0;
  let runId = testRunId;
  let ownerSessionId = testRunId ? LEAD_SESSION_ID : "";
  let activePaneId = "startup-pane";
  const paneEnvironment: Record<string, string> = {};
  let stopped = false;
  let tabClosed = false;
  let paneClosed = false;
  const emptyList = () => {
    const value = JSON.parse(listResponse(label));
    value.agents = [];
    return JSON.stringify({ id: AGENT_ID, result: value });
  };
  const stopMailboxConsumer = consumeMailboxRequest(
    mailbox,
    async (request) => {
      if (!readAgentState(mailbox)) return;
      await onRequest?.(request.text, request);
      acceptMailboxRequest(mailbox, request);
      await onAccepted?.(request);
    },
  );
  return {
    mailbox,
    getCount: () => getCount,
    stopMailboxConsumer,
    exec: (command, args) => {
      if (command === "herdr" && args[0] === "status" && args[1] === "--json")
        return herdrStatusResult();
      if (command === "herdr" && args[0] === "--version")
        return { stdout: "0.8.0", stderr: "", code: 0 };
      if (command === "herdr" && args[0] === "agent" && args[1] === "get") {
        if (countStartup && args[2] !== "startup-pane") getCount++;
        if (args[2] !== "startup-pane")
          return {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                agent: {
                  name: args[2],
                  pane_id: "startup-pane",
                  tab_id: "startup-tab",
                  workspace_id: WORKSPACE,
                  cwd: testCwd,
                  agent_session: {
                    source: "herdr:pi",
                    agent: "pi",
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
            id: AGENT_ID,
            result: {
              agent: {
                name: runScopedHerdrAlias(WORKSPACE, label, runId || AGENT_ID),
                pane_id: "startup-pane",
                tab_id: "startup-tab",
                workspace_id: WORKSPACE,
                cwd: testCwd,
                ...(session
                  ? {
                      agent_session: {
                        source: "herdr:pi",
                        agent: "pi",
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
      if (command !== "herdr") return { stdout: "{}", stderr: "", code: 0 };
      if (isTabList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              tabs:
                closePaneOnClose && tabClosed
                  ? []
                  : [
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
      if (args[0] === "tab" && args[1] === "create")
        return (() => {
          for (let i = 0; i < args.length - 1; i++) {
            if (args[i] !== "--env") continue;
            const assignment = args[i + 1]!;
            const separator = assignment.indexOf("=");
            if (separator <= 0) continue;
            const key = assignment.slice(0, separator);
            const value = assignment.slice(separator + 1);
            paneEnvironment[key] = value;
            if (key === "PI_HERDSMAN_RUN_ID") runId = value;
            if (key === "PI_HERDSMAN_OWNER_SESSION_ID") ownerSessionId = value;
          }
          return {
            stdout: JSON.stringify({
              id: AGENT_ID,
              result: {
                tab: { tab_id: "startup-tab" },
                root_pane: { pane_id: "startup-pane" },
              },
            }),
            stderr: "",
            code: 0,
          };
        })();
      if (isPaneList(args))
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              panes:
                closePaneOnClose && (paneClosed || tabClosed)
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
            id: AGENT_ID,
            result: {
              process_info: {
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
            id: AGENT_ID,
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
            id: AGENT_ID,
            result: { pane: { pane_id: activePaneId } },
          }),
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "pane" && args[1] === "get")
        return {
          stdout: JSON.stringify({
            id: AGENT_ID,
            result: {
              pane: {
                pane_id: "startup-pane",
                tab_id: "startup-tab",
                workspace_id: WORKSPACE,
                cwd: testCwd,
                agent_session: {
                  source: "herdr:pi",
                  agent: "pi",
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
            id: AGENT_ID,
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
            id: AGENT_ID,
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
                  if (reportNullSession) value.agents[0].agent_session = null;
                  return JSON.stringify({ id: AGENT_ID, result: value });
                })()
              : emptyList(),
          stderr: "",
          code: 0,
        };
      if (isPaneClose(args)) {
        if (closePaneOnClose) {
          stopped = true;
          paneClosed = true;
        }
        return { stdout: "{}", stderr: "", code: 0 };
      }
      if (isTabClose(args)) {
        if (closePaneOnClose) {
          stopped = true;
          tabClosed = true;
        }
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
          source: "herdr:pi",
          agent: "pi",
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
        piSessionFile: sessionFile,
        agentDefinition: "agent",
        cwd: testCwd,
        updatedAt: Date.now(),
      });
      return {
        stdout: JSON.stringify({
          id: AGENT_ID,
          result: {
            tab_id: "startup-tab",
            tab_label: "agents",
            pane_id: activePaneId,
            cwd: testCwd,
            herdr_agent: runScopedHerdrAlias(
              WORKSPACE,
              label,
              runId || AGENT_ID,
            ),
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
    ) {
      const input = args[index + 1]!;
      contents.push(
        input.startsWith("<active_agent ")
          ? input
          : readFileSync(input, "utf8"),
      );
    }
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
  get failNextRequestRemoval() {
    return failNextRequestRemoval;
  },
  set failNextRequestRemoval(value: boolean) {
    failNextRequestRemoval = value;
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
  get configReadHook() {
    return configReadHook;
  },
  set configReadHook(value: typeof configReadHook) {
    configReadHook = value;
  },
};
