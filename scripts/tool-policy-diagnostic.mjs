import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const providerTools = (value, found = []) => {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((item) => providerTools(item, found));
    return found;
  }
  if (value.type === "namespace") return providerTools(value.tools, found);
  if (Array.isArray(value.tools)) return providerTools(value.tools, found);
  const name =
    value.type === "function"
      ? (value.name ?? value.function?.name)
      : "input_schema" in value
        ? value.name
        : undefined;
  if (typeof name === "string") found.push(name);
  return found;
};

if (process.argv.includes("--provider-tools-check")) {
  const forbidden = "mcp__policy_probe__forbidden";
  const names = providerTools({
    tools: [
      { type: "function", name: "direct" },
      { type: "function", function: { name: "chat" } },
      { name: forbidden, input_schema: {} },
    ],
  });
  assert.deepEqual(names, ["direct", "chat", forbidden]);
  assert.ok(names.includes(forbidden), "Anthropic forbidden tool was missed");
  console.log(JSON.stringify({ pass: true, providerTools: names }));
  process.exit(0);
}

if (process.argv.includes("--dispatch-check")) {
  const { runAgentLoop } = await import("@earendil-works/pi-agent-core");
  const { createAssistantMessageEventStream } =
    await import("../node_modules/@earendil-works/pi-ai/dist/index.js");
  const directory = mkdtempSync(
    join("/tmp", "pi-herdsman-dispatch-"),
  ).toString();
  const sentinel = join(directory, "executed");
  let executionEnd;
  const message = {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "dispatch-check",
        name: "exec_command",
        arguments: { command: `touch ${sentinel}` },
      },
    ],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    stopReason: "toolUse",
  };
  const streamFn = () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: "toolUse", message });
    return stream;
  };
  try {
    await runAgentLoop(
      [
        {
          role: "user",
          content: "Run the restricted dispatch check.",
          timestamp: Date.now(),
        },
      ],
      { systemPrompt: "", messages: [], tools: [] },
      {
        model: {
          provider: "test",
          id: "test",
          api: "test",
          name: "test",
          baseUrl: "",
          reasoning: false,
          input: ["text"],
          contextWindow: 1024,
          maxTokens: 128,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        convertToLlm: async (messages) => messages,
        finishTurn: () => ({ action: "end" }),
      },
      (event) => {
        if (event.type === "tool_execution_end") executionEnd = event;
      },
      undefined,
      streamFn,
    );
    const text = executionEnd?.result?.content?.find(
      (part) => part.type === "text",
    )?.text;
    if (
      executionEnd?.toolName !== "exec_command" ||
      !executionEnd.isError ||
      text !== "Tool exec_command not found" ||
      existsSync(sentinel)
    )
      throw new Error(
        `unexpected dispatch result: ${JSON.stringify({ executionEnd, sentinel: existsSync(sentinel) })}`,
      );
    console.log(
      JSON.stringify({
        pass: true,
        toolName: executionEnd.toolName,
        isError: executionEnd.isError,
        result: text,
        sentinelExists: false,
        executorCalled: false,
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  process.exit(0);
}

const evidenceFile = process.env.POLICY_EVIDENCE;
const expectedLaunch = new Set(
  (process.env.POLICY_LAUNCH ?? "").split(",").filter(Boolean),
);
const expectedActive = new Set(
  (process.env.POLICY_ACTIVE ?? "").split(",").filter(Boolean),
);
const expectedProvider = new Set(
  (process.env.POLICY_PROVIDER ?? "").split(",").filter(Boolean),
);
const forbidden = new Set(
  (process.env.POLICY_FORBIDDEN ?? "").split(",").filter(Boolean),
);
const forbiddenMode = process.env.POLICY_FORBIDDEN_MODE ?? "absent";
const control = process.env.POLICY_CONTROL;

if (
  !evidenceFile ||
  process.env.POLICY_LAUNCH === undefined ||
  !forbidden.size ||
  !["absent", "present"].includes(forbiddenMode)
)
  throw new Error(
    "POLICY_EVIDENCE, POLICY_LAUNCH, POLICY_ACTIVE, POLICY_FORBIDDEN, and a valid POLICY_FORBIDDEN_MODE are required",
  );

const names = (tools) =>
  tools
    .map((tool) => (typeof tool === "string" ? tool : tool.name))
    .filter(Boolean);
const write = (event) =>
  appendFileSync(evidenceFile, `${JSON.stringify(event)}\n`);
const fail = (message) => {
  process.exitCode = 1;
  throw new Error(message);
};
const check = (kind, values) => {
  if (kind === "tool call") {
    if (
      forbiddenMode === "absent" &&
      values.some((name) => forbidden.has(name))
    )
      fail(`${kind} contains forbidden tool(s): ${values.join(",")}`);
    return;
  }
  const present = values.filter((name) => forbidden.has(name));
  if (forbiddenMode === "present" ? !present.length : present.length)
    fail(
      `${kind} ${forbiddenMode === "present" ? "omits" : "contains"} forbidden tool(s): ${[...forbidden].join(",")}`,
    );
};
const same = (actual, expected) =>
  actual.length === expected.size && actual.every((name) => expected.has(name));
const launchTools = () => {
  const index = process.argv.findIndex(
    (arg) => arg === "--tools" || arg.startsWith("--tools="),
  );
  if (index < 0) return [];
  const value = process.argv[index].includes("=")
    ? process.argv[index].split("=", 2)[1]
    : process.argv[index + 1];
  return value?.split(",").filter(Boolean) ?? [];
};

export default function (pi) {
  pi.on("session_start", () => {
    const launch = launchTools();
    const active = names(pi.getActiveTools());
    const all = names(pi.getAllTools());
    if (!same(launch, expectedLaunch))
      fail(`launch tools differ: ${launch.join(",")}`);
    if (forbiddenMode === "absent") check("active", active);
    if (expectedActive.size && !same(active, expectedActive))
      fail(`active tools differ: ${active.join(",")}`);
    write({ event: "session_start", launch, active, all });
  });
  pi.on("before_provider_request", (event) => {
    const provider = [...new Set(providerTools(event.payload))];
    check("provider", provider);
    if (expectedProvider.size && !same(provider, expectedProvider))
      fail(`provider tools differ: ${provider.join(",")}`);
    write({
      event: "before_provider_request",
      active: names(pi.getActiveTools()),
      all: names(pi.getAllTools()),
      provider,
    });
  });
  pi.on("tool_call", (event) => {
    check("tool call", [event.toolName]);
    if (control && event.toolName !== control)
      fail(`unexpected control tool call: ${event.toolName}`);
    write({
      event: "tool_call",
      name: event.toolName,
      allowed: true,
    });
  });
}
