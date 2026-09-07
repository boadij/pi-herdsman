import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

if (process.argv.includes("--dispatch-check")) {
  const { runAgentLoop } =
    await import("../node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js");
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
        shouldStopAfterTurn: () => true,
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
const control = process.env.POLICY_CONTROL;

if (
  !evidenceFile ||
  !expectedLaunch.size ||
  !expectedActive.size ||
  !forbidden.size
)
  throw new Error(
    "POLICY_EVIDENCE, POLICY_LAUNCH, POLICY_ACTIVE, and POLICY_FORBIDDEN are required",
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
  const bad = values.filter((name) => forbidden.has(name));
  if (bad.length) fail(`${kind} contains forbidden tool(s): ${bad.join(",")}`);
};
const providerTools = (value, found = []) => {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((item) => providerTools(item, found));
    return found;
  }
  if (value.type === "namespace") return providerTools(value.tools, found);
  if (value.type === "function" && value.name) found.push(value.name);
  return found;
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
    check("active", active);
    if (!same(active, expectedActive))
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
