import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scenarioNames = ["core", "continuation", "chief-tree"];
const SMOKE_MODEL_KEY = "pi-herdsman.smoke-model";
const MAX_SOCKET_PATH_BYTES = 100;
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
const MAX_CHIEF_TREE_RESULT_BYTES = 16 * 1024;
const HERDR_ROUTING_KEYS = [
  "HERDR_SOCKET_PATH",
  "HERDR_CLIENT_SOCKET_PATH",
  "HERDR_SESSION",
  "HERDR_WORKSPACE_ID",
  "HERDR_TAB_ID",
  "HERDR_PANE_ID",
];

export function parseScenario(args) {
  if (args.length > 1) throw new Error(`unexpected smoke argument: ${args[1]}`);
  const scenario = args[0] ?? "core";
  if (!scenarioNames.includes(scenario))
    throw new Error(`unknown smoke scenario: ${scenario}`);
  return scenario;
}

export function parseSmokeArgs(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { model: { type: "string" } },
  });
  return { scenario: parseScenario(positionals), model: values.model };
}

export async function resolveSmokeModel(override, execute = run) {
  if (override !== undefined) {
    const model = override.trim();
    if (!model) throw new Error("smoke --model must not be empty");
    return model;
  }
  try {
    const { stdout } = await execute(
      "git",
      ["config", "--get", SMOKE_MODEL_KEY],
      { cwd: repoRoot },
    );
    const model = stdout.trim();
    if (model) return model;
  } catch (error) {
    if (error?.code !== 1) throw error;
  }
  throw new Error(
    `smoke model is not configured; run: git config --local ${SMOKE_MODEL_KEY} 'provider/model:thinking' or pass --model`,
  );
}

export function isolatedEnv(base, paths) {
  const env = { ...base };
  for (const key of HERDR_ROUTING_KEYS) delete env[key];
  Object.assign(env, {
    HERDR_CONFIG_PATH: paths.herdrConfig,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_STATE_HOME: paths.xdgState,
    PI_CODING_AGENT_DIR: paths.piAgent,
    PI_CODING_AGENT_SESSION_DIR: paths.piSessions,
  });
  return env;
}

export function nestedControlEnv(base, paths, sessionName) {
  return { ...isolatedEnv(base, paths), HERDR_SESSION: sessionName };
}

function assertNestedSocketPathFits(paths, sessionName) {
  const socketPath = join(
    paths.xdgConfig,
    "herdr",
    "sessions",
    sessionName,
    "herdr-client.sock",
  );
  const bytesIncludingTerminator = Buffer.byteLength(socketPath) + 1;
  assert.ok(
    bytesIncludingTerminator <= MAX_SOCKET_PATH_BYTES,
    `nested Herdr socket path is too long (${bytesIncludingTerminator} bytes; maximum ${MAX_SOCKET_PATH_BYTES})`,
  );
  return socketPath;
}

export function candidateArgs(config) {
  assert.ok(
    typeof config.candidateExtension === "string" &&
      isAbsolute(config.candidateExtension),
    "candidate extension path must be absolute",
  );
  assert.ok(
    typeof config.herdrStateExtension === "string" &&
      isAbsolute(config.herdrStateExtension),
    "Herdr state extension path must be absolute",
  );
  const args = [
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--extension",
    config.candidateExtension,
    "--extension",
    config.herdrStateExtension,
    ...(config.chiefTreeProbeExtension
      ? ["--extension", config.chiefTreeProbeExtension]
      : []),
    "--model",
    config.model,
  ];
  if (config.chiefTreeProbeExtension)
    assert.ok(
      isAbsolute(config.chiefTreeProbeExtension),
      "Chief tree probe path must be absolute",
    );
  return args;
}

export function chiefTreeProbeSource(resultPath) {
  assert.ok(
    typeof resultPath === "string" && isAbsolute(resultPath),
    "Chief tree result path must be absolute",
  );
  return `import { appendFile } from "node:fs/promises";
const resultPath = ${JSON.stringify(resultPath)};
export default function (pi) {
  async function record(label) {
    await appendFile(resultPath, JSON.stringify({ label, tools: [...pi.getActiveTools()].sort() }) + "\\n");
  }
  pi.registerCommand("smoke-tools", {
    description: "Record active tools for isolated smoke",
    handler: async (args) => {
      if (args === "lead" || args === "chief") await record(args);
    },
  });
  pi.on("session_tree", async () => { await record("tree"); });
}`;
}

export function parseToolSnapshots(contents) {
  assert.ok(
    typeof contents === "string" &&
      Buffer.byteLength(contents) <= MAX_CHIEF_TREE_RESULT_BYTES,
  );
  const snapshots = new Map();
  for (const line of contents.trim().split("\n")) {
    const { label, tools } = JSON.parse(line);
    assert.ok(["lead", "chief", "tree"].includes(label));
    assert.ok(Array.isArray(tools));
    assert.ok(tools.every((tool) => typeof tool === "string"));
    assert.ok(!snapshots.has(label));
    snapshots.set(label, [...tools].sort());
  }
  return snapshots;
}

export function distinctPaneCount(processes) {
  return new Set(processes.map(({ paneId }) => paneId)).size;
}

export function chiefTreeBranchPlan(
  contents,
  startupPrompt,
  startupMarker,
  chiefPrompt,
  chiefMarker,
) {
  const entries = sessionEntries(contents);
  const byId = new Map(
    entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  const isAncestor = (ancestorId, descendantId) => {
    const visited = new Set();
    let parentId = byId.get(descendantId)?.parentId;
    while (parentId && !visited.has(parentId)) {
      if (parentId === ancestorId) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };
  const userFor = (prompt) =>
    entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "user" &&
        messageText(entry.message.content) === prompt,
    );
  const answerFor = (user, marker) =>
    entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        isAncestor(user?.id, entry.id) &&
        entry.message.stopReason === "stop" &&
        messageText(entry.message.content)
          .split(/\r?\n/)
          .some((line) => line.trim() === marker),
    );
  const startupUser = userFor(startupPrompt);
  const startupAnswer = answerFor(startupUser, startupMarker);
  const chiefUser = userFor(chiefPrompt);
  const chiefAnswer = answerFor(chiefUser, chiefMarker);
  if (
    !startupUser ||
    !startupAnswer ||
    !chiefUser ||
    !chiefAnswer ||
    !isAncestor(startupAnswer.id, chiefUser.id) ||
    !isAncestor(chiefUser.id, chiefAnswer.id)
  )
    return {
      error:
        "saved transcript does not contain one completed Chief turn descended from the startup Lead branch",
    };
  const userPrompts = entries.filter(
    (entry) => entry.type === "message" && entry.message?.role === "user",
  );
  if (
    userPrompts.length !== 2 ||
    userPrompts[0]?.id !== startupUser.id ||
    userPrompts[1]?.id !== chiefUser.id
  )
    return { error: "saved transcript contains an unexpected user prompt" };
  const completedTurns = entries.filter(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "assistant" &&
      entry.message.stopReason === "stop",
  );
  if (
    completedTurns.length !== 2 ||
    completedTurns[0]?.id !== startupAnswer.id ||
    completedTurns[1]?.id !== chiefAnswer.id
  )
    return {
      error: "saved transcript contains an unexpected completed model turn",
    };
  return { targetId: startupAnswer.id };
}

export function chiefTreeFooter(output) {
  const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const matches = [...text.matchAll(/^[ \t]*\((\d+)\/(\d+)\)(?:[ \t]|$)/gm)];
  if (!matches.length) return null;
  const [, selected, total] = matches.at(-1);
  const position = Number(selected);
  const count = Number(total);
  return position > 0 && count > 0 && position <= count
    ? { selected: position, total: count }
    : null;
}

export function chiefTreeSelectedRow(output, marker) {
  output = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  const expected = `assistant: ${marker}`;
  const rows = output.split(/\r?\n/).filter((line) => line.includes(expected));
  return rows.length === 1 && /^[ \t│├└─⊟⊞]*›\s/.test(rows[0]);
}

function shellCommand(args) {
  assert.ok(
    Array.isArray(args) &&
      args.length > 0 &&
      args.every((arg) => typeof arg === "string"),
  );
  return args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}

function sessionEntries(contents) {
  return contents
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function messageText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content)
    ? content
        .filter((block) => block?.type === "text")
        .map((block) => block.text)
        .join("\n")
    : "";
}

function assistantResultsForPrompt(contents, prompt, marker, matchesMarker) {
  const entries = sessionEntries(contents);
  const promptEntry = entries.find(
    (entry) =>
      entry.type === "message" &&
      entry.message?.role === "user" &&
      messageText(entry.message.content) === prompt,
  );
  if (!promptEntry) return [];
  const byId = new Map(
    entries.filter((entry) => entry.id).map((entry) => [entry.id, entry]),
  );
  const descendsFromPrompt = (entry) => {
    let parentId = entry.parentId;
    const visited = new Set();
    while (parentId && !visited.has(parentId)) {
      if (parentId === promptEntry.id) return true;
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return false;
  };
  return entries.filter((entry) => {
    if (
      entry.type !== "message" ||
      entry.message?.role !== "assistant" ||
      entry.message.stopReason !== "stop"
    )
      return false;
    if (!descendsFromPrompt(entry)) return false;
    return matchesMarker(messageText(entry.message.content), marker);
  });
}

function assistantResultForPrompt(contents, prompt, marker) {
  return (
    assistantResultsForPrompt(contents, prompt, marker, (text, expected) =>
      text.split(/\r?\n/).some((line) => line.trim() === expected),
    )[0] ?? null
  );
}

export function continuationResultsForPrompt(contents, prompt, marker) {
  return assistantResultsForPrompt(contents, prompt, marker, (text, expected) =>
    text.split(/\s+/).includes(expected),
  );
}

export function assistantResultForSession(session, prompt, marker) {
  return assistantResultForPrompt(session.contents, prompt, marker);
}

function summarizeSession(contents) {
  const entries = sessionEntries(contents);
  const header = entries.find((entry) => entry.type === "session");
  const tools = new Set();
  const messages = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message ?? {};
    for (const tool of message.toolsAdded ?? [])
      if (tool.name) tools.add(tool.name);
    const text = messageText(message.content);
    const calls = Array.isArray(message.content)
      ? message.content
          .filter((block) => block?.type === "toolCall")
          .map((block) => block.name)
      : [];
    if (
      message.role === "system" &&
      typeof message.sections?.tools === "string"
    ) {
      for (const [, name] of message.sections.tools.matchAll(
        /^\s*-\s+([\w-]+):/gm,
      ))
        tools.add(name);
    }
    if (message.role !== "system" || calls.length || text)
      messages.push({
        role: message.role,
        stopReason: message.stopReason,
        errorMessage:
          typeof message.errorMessage === "string"
            ? message.errorMessage.slice(0, 500)
            : undefined,
        toolName: message.toolName,
        isError: message.isError,
        tools: calls,
        text: text.slice(0, 500),
      });
  }
  return {
    session: header ? { id: header.id, cwd: header.cwd } : null,
    tools: [...tools].slice(0, 100),
    recentMessages: messages.slice(-16),
  };
}

async function run(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
    ...options,
  });
}

function json(output) {
  const text = output.trim();
  const start = text.indexOf("{");
  if (start < 0) throw new Error("Herdr did not return JSON");
  return JSON.parse(text.slice(start));
}

function resultOf(value) {
  return value?.result ?? value;
}

async function herdr(args, options = {}) {
  const { stdout } = await run("herdr", args, options);
  return json(stdout);
}

async function tryHerdr(args, options = {}) {
  try {
    return { ok: true, value: await herdr(args, options) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function preflight() {
  if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_WORKSPACE_ID)
    throw new Error("smoke must run from a Herdr-managed Pi session");
}

async function createIsolation() {
  const root = await mkdtemp(join(await realpath("/tmp"), "phs-"));
  const paths = {
    root,
    xdgConfig: join(root, "xdg-config"),
    xdgState: join(root, "xdg-state"),
    herdrConfig: join(root, "herdr.toml"),
    piAgent: join(root, "pi-agent"),
    piSessions: join(root, "pi-sessions"),
    herdrStateExtension: join(
      root,
      "pi-agent",
      "extensions",
      "herdr-agent-state.ts",
    ),
    authLink: join(root, "pi-agent", "auth.json"),
  };
  try {
    await Promise.all([
      mkdir(paths.xdgConfig, { recursive: true }),
      mkdir(paths.xdgState, { recursive: true }),
      mkdir(join(paths.piAgent, "extensions"), { recursive: true }),
      mkdir(paths.piSessions, { recursive: true }),
    ]);
    await writeFile(paths.herdrConfig, "[experimental]\nallow_nested = true\n");
    return paths;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function linkIfPresent(source, target) {
  try {
    await symlink(source, target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function preparePi(paths, model, execute = run) {
  const sourceAgentDir =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const env = isolatedEnv(process.env, paths);
  const authArgs = ["auth", "check", "--model", model, "--no-refresh"];
  try {
    await execute("pi", authArgs, {
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return "ambient";
  } catch {
    if (
      !(await linkIfPresent(join(sourceAgentDir, "auth.json"), paths.authLink))
    )
      throw new Error(
        "Pi auth check failed and no current auth.json is available",
      );
    try {
      await execute("pi", authArgs, {
        env,
        stdio: ["ignore", "ignore", "ignore"],
      });
      return "auth.json symlink";
    } catch {
      throw new Error(
        "Pi auth check failed with ambient credentials and auth.json",
      );
    }
  }
}

async function prepareHerdr(paths) {
  await run("herdr", ["config", "check"], {
    env: isolatedEnv(process.env, paths),
    stdio: ["ignore", "ignore", "pipe"],
  });
  await run("herdr", ["integration", "install", "pi"], {
    env: isolatedEnv(process.env, paths),
    stdio: ["ignore", "ignore", "pipe"],
  });
  await access(paths.herdrStateExtension);
}

async function startNestedHerdr(paths, owned) {
  const id = randomUUID().slice(0, 12);
  const sessionName = `pi-herdsman-smoke-${id}`;
  owned.sessionName = sessionName;
  assertNestedSocketPathFits(paths, sessionName);
  const host = await herdr(
    [
      "tab",
      "create",
      "--workspace",
      process.env.HERDR_WORKSPACE_ID,
      "--cwd",
      repoRoot,
      "--label",
      `smoke-${id}`,
      "--no-focus",
      "--env",
      `HERDR_CONFIG_PATH=${paths.herdrConfig}`,
      "--env",
      `XDG_CONFIG_HOME=${paths.xdgConfig}`,
      "--env",
      `XDG_STATE_HOME=${paths.xdgState}`,
      "--env",
      `PI_CODING_AGENT_DIR=${paths.piAgent}`,
      "--env",
      `PI_CODING_AGENT_SESSION_DIR=${paths.piSessions}`,
    ],
    { env: process.env },
  );
  const result = resultOf(host);
  owned.hostTabId = result.tab?.tab_id;
  owned.hostPaneId = result.root_pane?.pane_id;
  assert.ok(
    owned.hostTabId && owned.hostPaneId,
    "Herdr tab response omitted owned IDs",
  );
  owned.sessionName = sessionName;
  await run(
    "herdr",
    [
      "pane",
      "run",
      owned.hostPaneId,
      shellCommand([
        process.execPath,
        join(repoRoot, "scripts", "smoke.mjs"),
        "--nested-host",
        sessionName,
        paths.root,
      ]),
    ],
    { env: process.env },
  ).catch((error) => {
    throw new Error(`could not launch nested host: ${error.message}`);
  });
}

function nestedHost(args) {
  const [sessionName, root] = args;
  if (!sessionName || !root)
    throw new Error("nested host requires a session and temp root");
  const paths = {
    root,
    xdgConfig: join(root, "xdg-config"),
    xdgState: join(root, "xdg-state"),
    herdrConfig: join(root, "herdr.toml"),
    piAgent: join(root, "pi-agent"),
    piSessions: join(root, "pi-sessions"),
  };
  const result = spawnSync("herdr", ["--session", sessionName], {
    env: isolatedEnv(process.env, paths),
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

async function nestedCommand(ctx, args) {
  return herdr(args, {
    env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
  });
}

export async function nestedPaneInput(ctx, args, execute = run) {
  return execute("herdr", args, {
    env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
  });
}

export async function nestedPaneText(ctx, paneId, source, execute = run) {
  const { stdout } = await nestedPaneInput(
    ctx,
    ["pane", "read", paneId, "--source", source, "--lines", "120"],
    execute,
  );
  return stdout;
}

export async function submitPaneCommand(ctx, paneId, command, execute = run) {
  await nestedPaneInput(ctx, ["pane", "send-text", paneId, command], execute);
  await nestedPaneInput(ctx, ["pane", "send-keys", paneId, "enter"], execute);
}

async function waitForNestedHerdr(ctx) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = await tryHerdr(["pane", "list"], {
      env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
    });
    if (result.ok) return resultOf(result.value);
    await sleep(150);
  }
  throw new Error("nested Herdr session did not become ready");
}

async function startCandidate(ctx) {
  assert.equal(ctx.candidateExtension, join(ctx.repoRoot, "dist", "index.js"));
  assert.equal(
    ctx.herdrStateExtension,
    join(ctx.paths.piAgent, "extensions", "herdr-agent-state.ts"),
  );
  assert.ok(
    isAbsolute(ctx.herdrStateExtension),
    "Herdr state extension path must be absolute",
  );
  await Promise.all([
    access(ctx.candidateExtension),
    access(ctx.herdrStateExtension),
    ...(ctx.chiefTreeProbeExtension
      ? [access(ctx.chiefTreeProbeExtension)]
      : []),
  ]);
  const panes = await nestedCommand(ctx, ["pane", "list"]);
  const result = resultOf(panes);
  const paneList = result.panes ?? result;
  const pane = Array.isArray(paneList)
    ? paneList.find(
        (item) =>
          resolve(item.cwd ?? item.working_directory ?? "") === repoRoot,
      )
    : undefined;
  const paneId = pane?.pane_id ?? pane?.id;
  assert.ok(paneId, "nested primary pane ID was not found");
  assert.equal(resolve(pane.cwd ?? pane.working_directory), repoRoot);
  ctx.rootPaneId = paneId;
  const prompt = ctx.initialPrompt;
  assert.equal(
    typeof prompt,
    "string",
    "candidate initial prompt must be selected before startup",
  );
  const args = candidateArgs({
    candidateExtension: ctx.candidateExtension,
    herdrStateExtension: ctx.herdrStateExtension,
    ...(ctx.chiefTreeProbeExtension
      ? { chiefTreeProbeExtension: ctx.chiefTreeProbeExtension }
      : {}),
    model: ctx.model,
  });
  await run(
    "herdr",
    ["pane", "run", paneId, shellCommand(["pi", ...args, prompt])],
    {
      env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
    },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const info = resultOf(
      await nestedCommand(ctx, ["pane", "process-info", "--pane", paneId]),
    );
    if (
      candidateProcess(info, ctx.candidateExtension, ctx.herdrStateExtension)
        .length
    )
      return paneId;
    await sleep(200);
  }
  throw new Error("candidate Pi did not start with both explicit extensions");
}

function corePrompt(expected) {
  return `Delegate this task to one implementer.\n\nDo not read package.json yourself. The implementer must delegate exactly one scout to read package.json and determine its exact "name" and "version". The implementer must return that result to you.\n\nWhen the delegated work is complete, output exactly:\n\nPI_HERDSMAN_SMOKE_OK ${expected}\n\nDo not output that marker before the implementer reports its result.`;
}

function continuationPrompt() {
  return `Delegate exactly one bounded task to an implementer: read package.json, remember its exact package name, and return only CONTINUATION_FIRST_DONE. After that result reaches you, output exactly PI_HERDSMAN_CONTINUATION_FIRST. Do not read package.json yourself.`;
}

export function initialPromptForScenario(scenario, ctx) {
  switch (scenario) {
    case "core":
      return corePrompt(ctx.expectedPackage);
    case "continuation":
      return continuationPrompt();
    case "chief-tree":
      return "Reply exactly with PI_HERDSMAN_CHIEF_TREE_STARTUP.";
    default:
      throw new Error(`unknown smoke scenario: ${scenario}`);
  }
}

export async function runScenario(ctx, scenario) {
  switch (scenario) {
    case "core":
      return runCoreSmoke(ctx);
    case "continuation":
      return runContinuationSmoke(ctx);
    case "chief-tree":
      return runChiefTreeSmoke(ctx);
    default:
      throw new Error(`unknown smoke scenario: ${scenario}`);
  }
}

function candidateProcess(processInfo, extension, integration) {
  return (processInfo?.process_info?.foreground_processes ?? []).filter(
    (proc) => {
      const argv = Array.isArray(proc.argv) ? proc.argv.join("\0") : "";
      const cmdline = typeof proc.cmdline === "string" ? proc.cmdline : "";
      return [argv, cmdline].some(
        (line) => line.includes(extension) && line.includes(integration),
      );
    },
  );
}

export function listedPanes(value) {
  const result = resultOf(value);
  const panes = Array.isArray(result)
    ? result
    : (result?.panes ?? result?.result?.panes ?? []);
  return panes.flatMap((pane) => {
    const paneId = pane?.pane_id ?? pane?.id;
    return typeof paneId === "string" && paneId ? [{ paneId }] : [];
  });
}

export async function inspectPaneProcesses(
  panes,
  rootPaneId,
  inspect,
  extension,
  integration,
) {
  const paneIds = [
    ...new Set(
      panes.map((pane) =>
        typeof pane === "string"
          ? pane
          : (pane.paneId ?? pane.pane_id ?? pane.id),
      ),
    ),
  ].filter((paneId) => paneId && paneId !== rootPaneId);
  const inspected = await Promise.all(
    paneIds.map(async (paneId) => {
      try {
        return { paneId, info: resultOf(await inspect(paneId)) };
      } catch (error) {
        return { paneId, error: error?.message ?? String(error) };
      }
    }),
  );
  const records = inspected.flatMap(({ paneId, info, error }) => {
    const processes = info?.process_info?.foreground_processes;
    if (error) return [{ paneId, pid: null, processMatch: false, error }];
    if (!Array.isArray(processes) || !processes.length)
      return [
        {
          paneId,
          pid: null,
          processMatch: false,
          error: "no foreground process records",
        },
      ];
    return processes.map((proc) => ({
      paneId,
      pid: proc.pid ?? null,
      processMatch:
        candidateProcess(
          { process_info: { foreground_processes: [proc] } },
          extension,
          integration,
        ).length > 0,
      error: null,
    }));
  });
  const verified = new Map();
  for (const record of records) {
    if (record.processMatch && record.pid != null)
      verified.set(`${record.paneId}\0${record.pid}`, record);
  }
  return { records, verified: [...verified.values()] };
}

async function inspectCandidateProcesses(ctx) {
  const listed = await nestedCommand(ctx, ["pane", "list"]);
  return inspectPaneProcesses(
    listedPanes(listed),
    ctx.rootPaneId,
    (paneId) => nestedCommand(ctx, ["pane", "process-info", "--pane", paneId]),
    ctx.candidateExtension,
    ctx.herdrStateExtension,
  );
}

async function rootSessionSnapshot(ctx) {
  const listed = resultOf(await nestedCommand(ctx, ["agent", "list"]));
  const rootAgent = (listed.agents ?? []).find(
    (agent) => agent.pane_id === ctx.rootPaneId,
  );
  const sessionPath = rootAgent?.agent_session?.value;
  if (!sessionPath || rootAgent.agent_session?.kind !== "path") return null;
  const absolutePath = resolve(sessionPath);
  const sessionRoot = resolve(ctx.paths.piSessions);
  const relativePath = relative(sessionRoot, absolutePath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  )
    throw new Error(
      "root Pi session path is outside the isolated session directory",
    );
  let details;
  try {
    details = await lstat(absolutePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!details.isFile() || details.isSymbolicLink())
    throw new Error("root Pi session is not a regular isolated session file");
  if (details.size > MAX_SESSION_BYTES)
    throw new Error(
      `root Pi session exceeds ${MAX_SESSION_BYTES} byte read limit`,
    );
  const contents = await readFile(absolutePath, "utf8");
  const header = sessionEntries(contents).find(
    (entry) => entry.type === "session",
  );
  if (!header) return null;
  if (header.cwd !== ctx.repoRoot)
    throw new Error(
      "root Pi session cwd does not match the candidate repository",
    );
  return { path: absolutePath, status: rootAgent.agent_status, contents };
}

async function runCoreSmoke(ctx) {
  const deadline = Date.now() + 6 * 60_000;
  const marker = `PI_HERDSMAN_SMOKE_OK ${ctx.expectedPackage}`;
  const observed = new Map();
  let sawRootSession = false;
  while (Date.now() < deadline) {
    const inspection = await inspectCandidateProcesses(ctx);
    for (const item of inspection.verified) {
      observed.set(`${item.paneId}\0${item.pid}`, item);
    }
    ctx.coreProcessEvidence = [...observed.values()].slice(-40);
    ctx.coreProcessDiagnostics = inspection.records.slice(0, 40);
    const session = await rootSessionSnapshot(ctx);
    if (session) {
      sawRootSession = true;
      ctx.rootSessionPath = session.path;
      const assistantResult = assistantResultForSession(
        session,
        ctx.initialPrompt,
        marker,
      );
      if (assistantResult) ctx.assistantResult = assistantResult;
    }
    const paneCount = distinctPaneCount([...observed.values()]);
    if (ctx.assistantResult && paneCount >= 2) {
      ctx.descendantCount = paneCount;
      await waitForDescendantsToExit(ctx);
      return;
    }
    if (!sawRootSession && Date.now() > deadline - 5.5 * 60_000)
      throw new Error(
        "waiting-for-root-session: no saved Pi session identity appeared for the candidate root",
      );
    await sleep(250);
  }
  if (!sawRootSession)
    throw new Error(
      "waiting-for-root-session: candidate root did not save a Pi session",
    );
  const paneCount = distinctPaneCount([...observed.values()]);
  if (ctx.assistantResult && paneCount < 2)
    throw new Error(
      `waiting-for-descendant-processes: expected two distinct panes with both extensions; observed ${paneCount}`,
    );
  throw new Error(
    "waiting-for-assistant-result: saved candidate session had no completed assistant response with the expected marker",
  );
}

async function runContinuationSmoke(ctx) {
  const deadline = Date.now() + 6 * 60_000;
  const firstPrompt = ctx.initialPrompt;
  const firstMarker = "PI_HERDSMAN_CONTINUATION_FIRST";
  const secondMarker = "PI_HERDSMAN_CONTINUATION_SECOND";
  const expectedName = JSON.parse(
    await readFile(join(ctx.repoRoot, "package.json"), "utf8"),
  ).name;
  const isolatedSessions = resolve(ctx.paths.piSessions);
  let firstSession;
  let firstGeneration;
  const firstPids = new Set();

  const sessionDetails = async (agent) => {
    const identity = agent?.agent_session;
    if (identity?.kind !== "path" || typeof identity.value !== "string")
      return null;
    const path = resolve(identity.value);
    const relativePath = relative(isolatedSessions, path);
    if (
      !relativePath ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    )
      throw new Error(
        "managed Pi session path is outside the isolated session directory",
      );
    const details = await lstat(path);
    if (
      !details.isFile() ||
      details.isSymbolicLink() ||
      details.size > MAX_SESSION_BYTES
    )
      throw new Error(
        "managed Pi session is not a bounded regular isolated session file",
      );
    const contents = await readFile(path, "utf8");
    const header = sessionEntries(contents).find(
      (entry) => entry.type === "session",
    );
    if (!header?.id)
      throw new Error("managed Pi session has no persisted session ID");
    return { path, id: header.id, contents };
  };

  const childAgents = async () => {
    const listed = resultOf(await nestedCommand(ctx, ["agent", "list"]));
    return (listed.agents ?? []).filter(
      (agent) => agent.pane_id && agent.pane_id !== ctx.rootPaneId,
    );
  };

  const promptRoot = async (prompt) => {
    await nestedCommand(ctx, ["agent", "prompt", ctx.rootPaneId, prompt]);
  };

  while (Date.now() < deadline && !firstSession) {
    const agents = await childAgents();
    if (agents.length > 1)
      throw new Error(
        `continuation-first-generation: expected one managed Agent, observed ${agents.length}`,
      );
    for (const agent of agents) {
      const session = await sessionDetails(agent).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (session) {
        firstSession = { ...session, paneId: agent.pane_id };
        const info = resultOf(
          await nestedCommand(ctx, [
            "pane",
            "process-info",
            "--pane",
            agent.pane_id,
          ]),
        );
        for (const proc of candidateProcess(
          info,
          ctx.candidateExtension,
          ctx.herdrStateExtension,
        ))
          if (proc.pid != null) firstPids.add(proc.pid);
        break;
      }
    }
    if (!firstSession) await sleep(200);
  }
  if (!firstSession)
    throw new Error(
      "continuation-first-generation: no persisted managed Pi session was observed",
    );
  if (!firstPids.size)
    throw new Error(
      "continuation-first-generation: no candidate process identity was observed",
    );

  const firstResult = new Map();
  while (Date.now() < deadline) {
    const session = await rootSessionSnapshot(ctx);
    if (session) {
      const result = assistantResultForSession(
        session,
        firstPrompt,
        firstMarker,
      );
      if (result) {
        firstResult.set("result", result);
        break;
      }
    }
    await sleep(250);
  }
  if (!firstResult.size)
    throw new Error(
      "continuation-first-result: root did not receive the first delegated result",
    );
  firstSession.contents = await readFile(firstSession.path, "utf8");
  if (
    !sessionEntries(firstSession.contents).some(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        messageText(entry.message.content).includes("CONTINUATION_FIRST_DONE"),
    )
  )
    throw new Error(
      "continuation-first-result: persisted managed session did not contain its first result",
    );

  const firstExitDeadline = Date.now() + 60_000;
  while (Date.now() < firstExitDeadline) {
    const panes = listedPanes(await nestedCommand(ctx, ["pane", "list"]));
    const firstPaneExists = panes.some(
      (pane) => pane.paneId === firstSession.paneId,
    );
    if (!firstPaneExists) break;
    await sleep(300);
  }
  const panesAfterFirst = listedPanes(
    await nestedCommand(ctx, ["pane", "list"]),
  );
  if (panesAfterFirst.some((pane) => pane.paneId === firstSession.paneId))
    throw new Error(
      "continuation-first-cleanup: first managed pane did not disappear",
    );
  const savedAfterCleanup = await sessionDetails({
    agent_session: { kind: "path", value: firstSession.path },
  });
  if (savedAfterCleanup.id !== firstSession.id)
    throw new Error(
      "continuation-session-identity: first cleanup changed the persisted Pi session ID",
    );

  const followup = `Continue the exact saved Pi session at ${firstSession.path}. This is the same implementer you delegated previously. Without rereading package.json, return the package name you were asked to remember, followed by exactly ${secondMarker}. The final answer to me must include that marker.`;
  let followupSubmitted = false;
  while (Date.now() < deadline) {
    if (!followupSubmitted) {
      await promptRoot(followup);
      followupSubmitted = true;
    }
    const agents = await childAgents();
    for (const agent of agents) {
      const session = await sessionDetails(agent).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (session?.path !== firstSession.path || session.id !== firstSession.id)
        continue;
      const info = resultOf(
        await nestedCommand(ctx, [
          "pane",
          "process-info",
          "--pane",
          agent.pane_id,
        ]),
      );
      const matches = candidateProcess(
        info,
        ctx.candidateExtension,
        ctx.herdrStateExtension,
      );
      for (const proc of matches) {
        if (
          proc.pid != null &&
          !firstPids.has(proc.pid) &&
          agent.pane_id !== firstSession.paneId
        ) {
          firstGeneration = proc.pid;
          ctx.continuationSecondPaneId = agent.pane_id;
        }
      }
    }
    if (firstGeneration !== undefined) break;
    await sleep(200);
  }
  if (firstGeneration === undefined)
    throw new Error(
      "continuation-second-generation: no new candidate process used the exact saved session",
    );

  while (Date.now() < deadline) {
    const session = await rootSessionSnapshot(ctx);
    const matchingResults =
      session &&
      continuationResultsForPrompt(session.contents, followup, secondMarker);
    const result = matchingResults?.[0];
    if (result) {
      if (!messageText(result.message.content).includes(expectedName))
        throw new Error(
          "continuation-follow-up: final result did not return the remembered package name",
        );
      if (matchingResults.length !== 1 || matchingResults[0].id !== result.id)
        throw new Error(
          `continuation-follow-up: expected exactly one final result, observed ${matchingResults.length}`,
        );
      const contents = await readFile(firstSession.path, "utf8");
      const entries = sessionEntries(contents);
      const header = entries.find((entry) => entry.type === "session");
      const continued = entries.some(
        (entry) =>
          entry.type === "message" &&
          messageText(entry.message?.content).includes(
            "Without rereading package.json",
          ),
      );
      if (header?.id !== firstSession.id || !continued)
        throw new Error(
          "continuation-session-identity: persisted ID or remembered-context follow-up was not preserved",
        );
      await waitForDescendantsToExit(ctx);
      const finalSession = await rootSessionSnapshot(ctx);
      const finalResults = finalSession
        ? continuationResultsForPrompt(
            finalSession.contents,
            followup,
            secondMarker,
          )
        : [];
      if (finalResults.length !== 1)
        throw new Error(
          `continuation-follow-up: expected one final owner result after cleanup, observed ${finalResults.length}`,
        );
      ctx.continuationSessionId = firstSession.id;
      ctx.continuationSessionPath = firstSession.path;
      ctx.continuationFirstPaneId = firstSession.paneId;
      ctx.continuationGenerationPid = firstGeneration;
      return;
    }
    await sleep(250);
  }
  throw new Error(
    "continuation-follow-up: no completed root response proved the persisted context and result",
  );
}

async function runChiefTreeSmoke(ctx) {
  const deadline = Date.now() + 90_000;
  const startupTurn = (session) => {
    const entries = sessionEntries(session.contents);
    const prompt = entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "user" &&
        messageText(entry.message.content) === ctx.initialPrompt,
    );
    const response = entries.find(
      (entry) =>
        entry.type === "message" &&
        entry.message?.role === "assistant" &&
        entry.parentId === prompt?.id &&
        entry.message.stopReason === "stop" &&
        messageText(entry.message.content)
          .split(/\r?\n/)
          .some((line) => line.trim() === "PI_HERDSMAN_CHIEF_TREE_STARTUP"),
    );
    return prompt && response ? { prompt, response } : null;
  };

  // Establish the exact pre-Chief assistant branch before changing roles.
  let startup;
  while (Date.now() < deadline) {
    const session = await rootSessionSnapshot(ctx);
    startup = session && startupTurn(session);
    if (startup) break;
    await sleep(250);
  }
  if (!startup)
    throw new Error(
      "chief-tree-startup: candidate did not complete the ordinary Lead startup exchange",
    );

  const awaitSnapshot = async (label) => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) {
      try {
        const details = await lstat(ctx.chiefTreeResultFile);
        if (
          !details.isFile() ||
          details.isSymbolicLink() ||
          details.size > MAX_CHIEF_TREE_RESULT_BYTES
        )
          throw new Error(
            "chief-tree-probe: result path is not a bounded regular file",
          );
        const snapshots = parseToolSnapshots(
          await readFile(ctx.chiefTreeResultFile, "utf8"),
        );
        if (snapshots.has(label)) return snapshots;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await sleep(200);
    }
    throw new Error(`chief-tree-probe: missing ${label} tool snapshot`);
  };
  await submitPaneCommand(ctx, ctx.rootPaneId, "/smoke-tools lead");
  await awaitSnapshot("lead");
  await submitPaneCommand(ctx, ctx.rootPaneId, "/chief");
  await nestedCommand(ctx, [
    "pane",
    "wait-output",
    ctx.rootPaneId,
    "--match",
    "Chief mode active.",
    "--timeout",
    "15000",
  ]);

  await submitPaneCommand(ctx, ctx.rootPaneId, "/smoke-tools chief");
  await awaitSnapshot("chief");
  const chiefPrompt = "Reply exactly with PI_HERDSMAN_CHIEF_TREE_POST_CHIEF.";
  await submitPaneCommand(ctx, ctx.rootPaneId, chiefPrompt);
  let branchPlan;
  while (Date.now() < deadline) {
    const session = await rootSessionSnapshot(ctx);
    if (session) {
      branchPlan = chiefTreeBranchPlan(
        session.contents,
        ctx.initialPrompt,
        "PI_HERDSMAN_CHIEF_TREE_STARTUP",
        chiefPrompt,
        "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF",
      );
      if (!branchPlan.error) break;
    }
    await sleep(250);
  }
  if (!branchPlan || branchPlan.error)
    throw new Error(
      `chief-tree-branch: ${branchPlan?.error ?? "no completed post-Chief turn was persisted"}`,
    );
  ctx.chiefTreeBranchPlan = branchPlan;

  await submitPaneCommand(ctx, ctx.rootPaneId, "/tree");
  const treeDeadline = Date.now() + 5_000;
  let footer;
  let treeText;
  while (Date.now() < treeDeadline) {
    treeText = await nestedPaneText(ctx, ctx.rootPaneId, "visible");
    footer = chiefTreeFooter(treeText);
    if (
      footer &&
      chiefTreeSelectedRow(treeText, "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF")
    )
      break;
    await sleep(150);
  }
  if (
    !footer ||
    !chiefTreeSelectedRow(treeText, "PI_HERDSMAN_CHIEF_TREE_POST_CHIEF")
  )
    throw new Error(
      "chief-tree-selection: /tree did not show the post-Chief response selected with a valid footer",
    );

  let startupSelected = false;
  for (let attempt = 0; attempt < footer.total; attempt++) {
    treeText = await nestedPaneText(ctx, ctx.rootPaneId, "visible");
    const currentFooter = chiefTreeFooter(treeText);
    if (!currentFooter || currentFooter.total !== footer.total)
      throw new Error(
        "chief-tree-selection: tree footer disappeared or changed while locating the startup branch",
      );
    if (chiefTreeSelectedRow(treeText, "PI_HERDSMAN_CHIEF_TREE_STARTUP")) {
      startupSelected = true;
      break;
    }
    await nestedPaneInput(ctx, ["pane", "send-keys", ctx.rootPaneId, "up"]);
  }
  if (!startupSelected)
    throw new Error(
      `chief-tree-selection: startup answer was not selected after checking ${footer.total} tree rows; Enter was not sent`,
    );
  await nestedPaneInput(ctx, ["pane", "send-keys", ctx.rootPaneId, "enter"]);
  // Pi may ask whether to summarize the selected branch; its first choice is No summary.
  const summaryDialog = await tryHerdr(
    [
      "pane",
      "wait-output",
      ctx.rootPaneId,
      "--match",
      "Summarize branch?",
      "--timeout",
      "1200",
    ],
    {
      env: nestedControlEnv(process.env, ctx.paths, ctx.sessionName),
    },
  );
  if (summaryDialog.ok)
    await nestedPaneInput(ctx, ["pane", "send-keys", ctx.rootPaneId, "enter"]);

  const snapshots = await awaitSnapshot("tree");
  ctx.chiefTreeProbeDiagnostics = Object.fromEntries(snapshots);
  const lead = snapshots.get("lead");
  const chief = snapshots.get("chief");
  const tree = snapshots.get("tree");
  assert.ok(
    lead && chief && tree,
    "chief-tree-probe: three snapshots required",
  );
  assert.notDeepEqual(
    chief,
    lead,
    "Chief tools must differ from ordinary Lead tools",
  );
  assert.deepEqual(
    tree,
    lead,
    "selecting the pre-Chief branch must restore ordinary Lead tools",
  );

  const followup = "Reply exactly PI_HERDSMAN_CHIEF_TREE_FOLLOWUP.";
  await submitPaneCommand(ctx, ctx.rootPaneId, followup);
  while (Date.now() < deadline) {
    const session = await rootSessionSnapshot(ctx);
    if (
      session &&
      assistantResultForSession(
        session,
        followup,
        "PI_HERDSMAN_CHIEF_TREE_FOLLOWUP",
      )
    )
      return;
    await sleep(250);
  }
  throw new Error(
    "chief-tree-follow-up: Lead did not complete the follow-up action",
  );
}

async function waitForDescendantsToExit(ctx) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const inspection = await inspectCandidateProcesses(ctx);
    if (!inspection.verified.length) return;
    await sleep(500);
  }
  throw new Error(
    "candidate descendant processes did not disappear from non-root panes",
  );
}

async function collectDiagnostics(ctx, owned) {
  const diagnostics = {};
  const env = nestedControlEnv(process.env, ctx.paths, ctx.sessionName);
  diagnostics.chiefTreeProbe = ctx.chiefTreeProbeDiagnostics ?? null;
  diagnostics.agents = await tryHerdr(["agent", "list"], { env });
  diagnostics.panes = await tryHerdr(["pane", "list"], { env });
  diagnostics.observedCoreProcesses = ctx.coreProcessEvidence ?? [];
  diagnostics.coreProcessDiagnostics = ctx.coreProcessDiagnostics ?? [];
  const processDiagnostics = await inspectPaneProcesses(
    listedPanes(diagnostics.panes.value),
    ctx.rootPaneId,
    async (paneId) => {
      const result = await tryHerdr(
        ["pane", "process-info", "--pane", paneId],
        { env },
      );
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
    ctx.candidateExtension,
    ctx.herdrStateExtension,
  );
  diagnostics.processes = processDiagnostics.records.slice(0, 40);
  try {
    const session = await rootSessionSnapshot(ctx);
    diagnostics.rootSession = session
      ? {
          path: session.path,
          status: session.status,
          ...summarizeSession(session.contents),
        }
      : { error: "no saved root Pi session was available" };
  } catch (error) {
    diagnostics.rootSession = { error: error.message };
  }
  if (ctx.rootPaneId)
    diagnostics.root = await run(
      "herdr",
      [
        "pane",
        "read",
        ctx.rootPaneId,
        "--source",
        "recent-unwrapped",
        "--lines",
        "120",
      ],
      { env },
    ).catch((error) => ({ error: error.message }));
  if (owned.hostPaneId)
    diagnostics.host = await run(
      "herdr",
      [
        "pane",
        "read",
        owned.hostPaneId,
        "--source",
        "recent-unwrapped",
        "--lines",
        "80",
      ],
      {},
    ).catch((error) => ({ error: error.message }));
  try {
    const serialized = JSON.stringify(diagnostics);
    console.error(`diagnostics: ${serialized}`);
  } catch {
    console.error("diagnostics: collection failed");
  }
}

async function cleanup(paths, owned) {
  const failures = [];
  try {
    await unlink(paths.authLink);
  } catch (error) {
    if (error.code !== "ENOENT")
      failures.push(`auth symlink: ${error.message}`);
  }
  if (owned.sessionName) {
    const env = nestedControlEnv(process.env, paths, owned.sessionName);
    await tryHerdr(["session", "stop", owned.sessionName, "--json"], { env });
    let deleted = false;
    for (let i = 0; i < 3 && !deleted; i++) {
      await tryHerdr(["session", "delete", owned.sessionName, "--json"], {
        env,
      });
      const sessions = await tryHerdr(["session", "list", "--json"], { env });
      const all = resultOf(sessions.value);
      const rows = Array.isArray(all) ? all : (all?.sessions ?? []);
      deleted =
        sessions.ok &&
        !rows.some((item) => (item.name ?? item.session) === owned.sessionName);
      if (!deleted) await sleep(300);
    }
    if (!deleted)
      failures.push(
        `nested session remains: ${owned.sessionName}; temp=${paths.root}`,
      );
  }
  if (owned.hostTabId) {
    try {
      await herdr(["tab", "close", owned.hostTabId]);
    } catch (error) {
      failures.push(`host tab ${owned.hostTabId}: ${error.message}`);
    }
  }
  if (
    !failures.some((failure) => failure.startsWith("nested session remains"))
  ) {
    try {
      await rm(paths.root, { recursive: true, force: true });
    } catch (error) {
      failures.push(`temporary state: ${error.message}`);
    }
  }
  return failures.length ? failures.join("\n") : null;
}

function cleanupEvidence(owned) {
  return `session=${owned.sessionName ?? "not-created"} host-tab=${owned.hostTabId ?? "not-created"} host-pane=${owned.hostPaneId ?? "not-created"}`;
}

async function main() {
  const args = parseSmokeArgs(process.argv.slice(2));
  preflight();
  const model = await resolveSmokeModel(args.model);
  const scenario = args.scenario;
  await run("npm", ["run", "build"], { cwd: repoRoot });
  const paths = await createIsolation();
  const owned = {};
  const pkg = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  );
  const ctx = {
    repoRoot,
    candidateExtension: join(repoRoot, "dist", "index.js"),
    herdrStateExtension: paths.herdrStateExtension,
    ...(scenario === "chief-tree"
      ? {
          chiefTreeProbeExtension: join(
            paths.piAgent,
            "extensions",
            "chief-tree-tools.mjs",
          ),
          chiefTreeResultFile: join(paths.root, "chief-tree-tools.json"),
        }
      : {}),
    sessionName: undefined,
    paths,
    model,
    expectedPackage: `${pkg.name}@${pkg.version}`,
  };
  ctx.initialPrompt = initialPromptForScenario(scenario, ctx);
  let failure;
  try {
    ctx.authMechanism = await preparePi(paths, model);
    await prepareHerdr(paths);
    if (ctx.chiefTreeProbeExtension)
      await writeFile(
        ctx.chiefTreeProbeExtension,
        chiefTreeProbeSource(ctx.chiefTreeResultFile),
        { flag: "wx" },
      );
    await startNestedHerdr(paths, owned);
    ctx.sessionName = owned.sessionName;
    await waitForNestedHerdr(ctx);
    ctx.rootPaneId = await startCandidate(ctx);
    await runScenario(ctx, scenario);
    console.log(`smoke ${scenario}: PASS`);
    console.log(`model: ${ctx.model}`);
    console.log(`candidate: ${ctx.candidateExtension}`);
    if (scenario === "core") {
      console.log(`descendant panes: ${ctx.descendantCount}`);
      console.log(
        `process evidence: ${JSON.stringify(ctx.coreProcessEvidence)}`,
      );
      console.log(`package result: ${ctx.expectedPackage}`);
    }
    if (scenario === "continuation")
      console.log(
        `continuation: ${JSON.stringify({
          sessionId: ctx.continuationSessionId,
          sessionPath: ctx.continuationSessionPath,
          firstPane: ctx.continuationFirstPaneId,
          secondPane: ctx.continuationSecondPaneId,
          secondPid: ctx.continuationGenerationPid,
          result: "one final remembered-context owner result",
        })}`,
      );
    if (scenario === "chief-tree")
      console.log(
        `chief-tree: ${JSON.stringify({
          snapshots: ctx.chiefTreeProbeDiagnostics,
          selectedBranch: ctx.chiefTreeBranchPlan,
        })}`,
      );
    console.log(`authentication: ${ctx.authMechanism}`);
  } catch (error) {
    failure = error;
    console.error(`smoke ${scenario}: FAIL\nstage: ${error.message}`);
    await collectDiagnostics(ctx, owned);
  } finally {
    const cleanupError = await cleanup(paths, owned);
    if (cleanupError) {
      console.error(`cleanup: FAIL ${cleanupEvidence(owned)}\n${cleanupError}`);
      process.exitCode = 1;
    } else {
      console.log(`cleanup: PASS ${cleanupEvidence(owned)}`);
    }
    if (failure) process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "--nested-host") nestedHost(process.argv.slice(3));
  else await main();
}
