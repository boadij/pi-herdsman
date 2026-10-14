import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";

const modelIds = [
  "core",
  "continuation",
  "chief-tree",
  "terminal-failure",
  "terminal-error",
];

function text(message) {
  return typeof message?.content === "string"
    ? message.content
    : (message?.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n") ?? "");
}

function lastUser(messages) {
  return [...messages].reverse().find((message) => message.role === "user");
}

function correlatedCall(messages, name) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const call = message.content?.find(
      (part) => part.type === "toolCall" && part.name === name,
    );
    if (!call) continue;
    const result = messages.find(
      (candidate, resultIndex) =>
        resultIndex > index &&
        candidate.role === "toolResult" &&
        candidate.toolName === name &&
        candidate.toolCallId === call.id,
    );
    if (result && !result.isError)
      return { call, result, resultIndex: messages.indexOf(result) };
    if (result?.isError) throw new Error(`Failed ${name} result`);
  }
  return null;
}

function successfulResult(messages, name) {
  const matched = correlatedCall(messages, name);
  if (!matched) throw new Error(`Missing successful correlated ${name} result`);
  return matched;
}

function packageDetails(value) {
  const source = typeof value === "string" ? value : text(value);
  let pkg;
  try {
    pkg = JSON.parse(source);
  } catch {
    const match = source.match(
      /"name"\s*:\s*("(?:\\.|[^"\\])*")[\s\S]*?"version"\s*:\s*("(?:\\.|[^"\\])*")(?=\s*[,}])/,
    );
    if (!match)
      throw new Error("package result omitted valid package metadata");
    pkg = { name: JSON.parse(match[1]), version: JSON.parse(match[2]) };
  }
  if (
    typeof pkg.name !== "string" ||
    !pkg.name ||
    typeof pkg.version !== "string" ||
    !pkg.version
  )
    throw new Error("package result omitted name or version");
  return pkg;
}

function deliveredResult(messages, toolName, matches) {
  const matched = correlatedCall(messages, toolName);
  if (!matched) return null;
  return messages.find(
    (message, index) =>
      index > matched.resultIndex &&
      message.role === "user" &&
      matches(text(message)),
  );
}

function deliveredAgentResult(messages, toolName, label) {
  const handoff = deliveredResult(messages, toolName, (content) =>
    content.startsWith(`Agent result · agent=${label} ·`),
  );
  if (!handoff) return null;
  const content = text(handoff);
  if (!content.includes("status=completed"))
    throw new Error(
      `Agent ${label} did not complete successfully: ${content.slice(0, 500)}`,
    );
  return content;
}

function completedResultBody(message) {
  const match = text(message).match(
    /status=completed\n\n(?:Result ref: [^\n]+\n\n)?([\s\S]+?)\n\nDelegation status:/,
  );
  if (!match)
    throw new Error("Completed Agent result omitted its response body");
  return match[1].trim();
}

function call(name, arguments_) {
  return fauxAssistantMessage(fauxToolCall(name, arguments_), {
    stopReason: "toolUse",
  });
}

function waitForResult(message) {
  return fauxAssistantMessage(message);
}

function packageRead(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const call = message.content?.find(
      (part) =>
        part.type === "toolCall" &&
        part.name === "read" &&
        part.arguments?.path === "package.json",
    );
    if (!call) continue;
    const result = messages.find(
      (candidate, resultIndex) =>
        resultIndex > index &&
        candidate.role === "toolResult" &&
        candidate.toolName === "read" &&
        candidate.toolCallId === call.id,
    );
    if (!result) continue;
    if (result.isError) throw new Error("package.json read failed");
    return packageDetails(result);
  }
  return null;
}

function rootAgentPrompt(messages, marker) {
  return messages.find(
    (message) => message.role === "user" && text(message).includes(marker),
  );
}

function coreDecision(context) {
  const messages = context.messages;
  const latest = messages.at(-1);
  const prompt = text(lastUser(messages));
  const rootTask = rootAgentPrompt(
    messages,
    "Do not read package.json yourself.",
  );
  if (rootTask) {
    const result = deliveredAgentResult(
      messages,
      "delegate_agent",
      "smoke-core-implementer",
    );
    if (result) {
      const systemPrompt = getCurrentSystemPrompt(context.messages);
      if (!/<pi_herdsman_role>\s*## Lead role(?:\r?\n|$)/.test(systemPrompt))
        throw new Error(
          "Lead role context missing or incorrect after Agent result",
        );
      const pkg = packageDetails(result);
      return fauxAssistantMessage(
        `PI_HERDSMAN_SMOKE_OK ${pkg.name}@${pkg.version}`,
      );
    }
    if (correlatedCall(messages, "delegate_agent"))
      return waitForResult("Waiting for the implementer's completed handoff.");
    return call("delegate_agent", {
      definition: "implementer",
      label: "smoke-core-implementer",
      task: "SMOKE_CORE_IMPLEMENTER: delegate exactly one scout with label smoke-core-scout to read package.json and return its exact name and version as JSON.",
    });
  }

  if (rootAgentPrompt(messages, "SMOKE_CORE_IMPLEMENTER:")) {
    const result = deliveredAgentResult(
      messages,
      "delegate_agent",
      "smoke-core-scout",
    );
    if (result)
      return fauxAssistantMessage(JSON.stringify(packageDetails(result)));
    if (correlatedCall(messages, "delegate_agent"))
      return waitForResult("Waiting for the scout's completed handoff.");
    return call("delegate_agent", {
      definition: "scout",
      label: "smoke-core-scout",
      task: "SMOKE_CORE_SCOUT: read package.json and return its exact name and version as JSON.",
    });
  }

  if (prompt.includes("SMOKE_CORE_SCOUT:")) {
    const pkg = packageRead(messages);
    if (pkg) return fauxAssistantMessage(JSON.stringify(pkg));
    if (latest?.role === "toolResult")
      throw new Error("Package read result missing or unsuccessful");
    return call("read", { path: "package.json" });
  }
  throw new Error("Unexpected core transcript");
}

function continuationDecision(messages) {
  const latest = messages.at(-1);
  const prompt = text(lastUser(messages));
  const followupPrompt = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "user" &&
        /Continue the exact saved Pi session at .+?\. This is the same implementer/.test(
          text(message),
        ),
    );
  const followup = text(followupPrompt).match(
    /Continue the exact saved Pi session at (.+?)\. This is the same implementer/,
  );
  if (followup) {
    const completedFirst = deliveredAgentResult(
      messages,
      "delegate_agent",
      "smoke-continuation-implementer",
    );
    if (!completedFirst?.includes("CONTINUATION_FIRST_DONE"))
      throw new Error("First continuation Agent result was not delivered");
    const continued = correlatedCall(messages, "continue_agent");
    if (!continued)
      return call("continue_agent", {
        session: followup[1],
        task: "SMOKE_CONTINUATION_SECOND: use the exact package name from your previous successful package.json read; do not reread package.json; return the name followed by PI_HERDSMAN_CONTINUATION_SECOND.",
      });
    if (continued.call.arguments?.session !== followup[1])
      throw new Error(
        "continue_agent did not target the exact saved session path",
      );
    const sessionId = textFromSessionId(continued.result);
    const result = deliveredResult(
      messages,
      "continue_agent",
      (content) =>
        content.startsWith("Agent result · agent=") &&
        content.includes(`session=${sessionId} · status=completed`),
    );
    if (result) {
      const body = completedResultBody(result);
      if (
        !body.endsWith("PI_HERDSMAN_CONTINUATION_SECOND") ||
        body === "PI_HERDSMAN_CONTINUATION_SECOND"
      )
        throw new Error(
          "Second continuation result omitted its completion marker",
        );
      return lastUser(messages) === result
        ? fauxAssistantMessage(body)
        : waitForResult("Continued Agent result already delivered.");
    }
    if (latest?.role === "toolResult")
      return waitForResult(
        "Waiting for the continued Agent's completed handoff.",
      );
    return waitForResult(
      "Waiting for the continued Agent's completed handoff.",
    );
  }

  if (
    rootAgentPrompt(
      messages,
      "Delegate exactly one bounded task to an implementer:",
    )
  ) {
    const result = deliveredResult(messages, "delegate_agent", (content) =>
      content.startsWith(
        "Agent result · agent=smoke-continuation-implementer ·",
      ),
    );
    if (result) {
      if (!text(result).includes("CONTINUATION_FIRST_DONE"))
        throw new Error(
          "First continuation result omitted its completion marker",
        );
      return lastUser(messages) === result
        ? fauxAssistantMessage("PI_HERDSMAN_CONTINUATION_FIRST")
        : waitForResult("First continuation Agent result already delivered.");
    }
    if (correlatedCall(messages, "delegate_agent"))
      return waitForResult("Waiting for the implementer's completed handoff.");
    return call("delegate_agent", {
      definition: "implementer",
      label: "smoke-continuation-implementer",
      task: "SMOKE_CONTINUATION_FIRST: read package.json, remember its exact name, and return that name followed by CONTINUATION_FIRST_DONE.",
    });
  }

  if (prompt.includes("SMOKE_CONTINUATION_FIRST:")) {
    const pkg = packageRead(messages);
    if (pkg) return fauxAssistantMessage(`${pkg.name} CONTINUATION_FIRST_DONE`);
    if (latest?.role === "toolResult")
      throw new Error("Package read result missing or unsuccessful");
    return call("read", { path: "package.json" });
  }
  if (prompt.includes("SMOKE_CONTINUATION_SECOND:")) {
    const pkg = packageRead(messages);
    if (!pkg)
      throw new Error("Resumed transcript has no successful package.json read");
    return fauxAssistantMessage(`${pkg.name} PI_HERDSMAN_CONTINUATION_SECOND`);
  }
  throw new Error("Unexpected continuation transcript");
}

function textFromSessionId(result) {
  const id = result.details?.session_id;
  if (typeof id !== "string" || !id)
    throw new Error("continue_agent result omitted its exact session identity");
  return id;
}

export function decide(model, context) {
  const messages = context.messages;
  const prompt = text(lastUser(messages));

  if (model === "terminal-error")
    return fauxAssistantMessage("CONTROLLED_PARTIAL_RESPONSE", {
      stopReason: "error",
      errorMessage: "503 Service Unavailable (controlled smoke failure)",
    });
  if (model === "chief-tree") {
    const marker = prompt.match(
      /PI_HERDSMAN_CHIEF_TREE_(?:STARTUP|POST_CHIEF|FOLLOWUP)/,
    )?.[0];
    if (!marker) throw new Error("Unexpected chief-tree request");
    return fauxAssistantMessage(marker);
  }
  if (model === "core") return coreDecision(context);
  if (model === "continuation") return continuationDecision(messages);

  if (model === "terminal-failure") {
    const latest = messages.at(-1);
    if (
      latest?.role === "user" &&
      prompt.includes("Use delegate_project exactly once")
    ) {
      const branch = prompt.match(/branch to exactly ([^,\s]+)/)?.[1];
      const task = prompt.match(/task to exactly ("(?:[^"\\]|\\.)*")/)?.[1];
      if (!branch || !task)
        throw new Error("Missing exact terminal-failure branch or task");
      return call("delegate_project", { branch, task: JSON.parse(task) });
    }
    if (latest?.role === "toolResult") {
      successfulResult(messages, "delegate_project");
      return fauxAssistantMessage(
        "Assigned Lead started; waiting for its report.",
      );
    }
    if (
      latest?.role === "user" &&
      /Lead model execution failed|Lead execution settled without verified completion/i.test(
        prompt,
      )
    )
      return fauxAssistantMessage("Lead failure report received.");
  }
  throw new Error(`Unexpected ${model} transcript`);
}

export default function install(pi) {
  let terminalErrorRequests = 0;
  let sessionId;
  const recordedSessions = new Set();
  const faux = fauxProvider({
    provider: "smoke-faux",
    api: "smoke-faux-api",
    models: modelIds.map((id) => ({ id, reasoning: false, input: ["text"] })),
  });
  function response(context, _options, _state, model) {
    faux.appendResponses([response]);
    const currentSessionId = sessionId;
    if (typeof currentSessionId !== "string" || !currentSessionId)
      throw new Error("Faux provider request has no Pi session identity");
    if (!recordedSessions.has(currentSessionId)) {
      const packageDir =
        process.env.PI_PACKAGE_DIR ?? dirname(process.execPath);
      let piPackage;
      try {
        piPackage = JSON.parse(
          readFileSync(join(packageDir, "package.json"), "utf8"),
        );
      } catch {
        throw new Error("Could not resolve Pi package metadata");
      }
      if (
        piPackage.name !== "@earendil-works/pi-coding-agent" ||
        typeof piPackage.version !== "string" ||
        !piPackage.version
      )
        throw new Error("Pi package metadata has an unexpected identity");
      const systemPrompt = getCurrentSystemPrompt(context.messages);
      const provenance = {
        pid: process.pid,
        sessionId: currentSessionId,
        packageName: piPackage.name,
        piVersion: piPackage.version,
        model: model.id,
        hasAgentDefinitions: systemPrompt.includes("<agent_definitions>"),
      };
      const evidenceDir = join(
        process.env.PI_CODING_AGENT_DIR,
        "pi-herdsman",
        "runtime",
      );
      appendFileSync(
        join(evidenceDir, "smoke-faux-provenance.jsonl"),
        `${JSON.stringify(provenance)}\n`,
      );
      recordedSessions.add(currentSessionId);
    }
    if (model.id === "terminal-error") {
      const first = terminalErrorRequests++ === 0;
      const systemPrompt = getCurrentSystemPrompt(context.messages);
      const hasRoster = systemPrompt.includes("<agent_definitions>");
      const evidenceDir = join(
        process.env.PI_CODING_AGENT_DIR,
        "pi-herdsman",
        "runtime",
      );
      appendFileSync(
        join(evidenceDir, "smoke-faux-attempts.jsonl"),
        `${JSON.stringify({ model: model.id, hasRoster })}\n`,
      );
      if (first && !hasRoster)
        throw new Error(
          "Assigned Lead's initial request omitted session-matched agent definitions",
        );
    }
    const answer = decide(model.id, context);
    return answer;
  }
  faux.setResponses([response]);
  pi.registerProvider(faux.provider);
  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    const evidenceDir = join(
      process.env.PI_CODING_AGENT_DIR,
      "pi-herdsman",
      "runtime",
    );
    appendFileSync(
      join(evidenceDir, "smoke-faux-session-start.jsonl"),
      `${JSON.stringify({ sessionId, pid: process.pid })}\n`,
    );
  });
  pi.on("agent_settled", (event, ctx) => {
    if (
      ctx.model?.provider !== "smoke-faux" ||
      ctx.model?.id !== "terminal-error"
    )
      return;
    const evidenceDir = join(
      process.env.PI_CODING_AGENT_DIR,
      "pi-herdsman",
      "runtime",
    );
    appendFileSync(
      join(evidenceDir, "smoke-faux-settled.jsonl"),
      `${JSON.stringify({ sessionId: ctx.sessionManager.getSessionId(), aborted: event.aborted })}\n`,
    );
  });
}
