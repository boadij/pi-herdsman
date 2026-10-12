import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";

const modelIds = ["chief-tree", "terminal-failure", "terminal-error"];

function text(message) {
  return typeof message?.content === "string"
    ? message.content
    : (message?.content
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n") ?? "");
}

function successfulToolResult(messages, name) {
  const result = messages.at(-1);
  if (
    result?.role !== "toolResult" ||
    result.toolName !== name ||
    result.isError
  )
    throw new Error(`Expected successful ${name} result`);
  if (
    !messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content?.some(
          (part) =>
            part.type === "toolCall" &&
            part.id === result.toolCallId &&
            part.name === name,
        ),
    )
  )
    throw new Error(`Unmatched ${name} result`);
  return text(result);
}

export function decide(model, context) {
  const messages = context.messages;
  const latest = messages.at(-1);
  const prompt = text(
    [...messages].reverse().find((message) => message.role === "user"),
  );

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

  if (model === "terminal-failure") {
    if (
      latest?.role === "user" &&
      prompt.includes("Use delegate_project exactly once")
    ) {
      const branch = prompt.match(/branch to exactly ([^,\s]+)/)?.[1];
      const task = prompt.match(/task to exactly ("(?:[^"\\]|\\.)*")/)?.[1];
      if (!branch || !task)
        throw new Error("Missing exact terminal-failure branch or task");
      return fauxAssistantMessage(
        fauxToolCall("delegate_project", {
          branch,
          task: JSON.parse(task),
        }),
        { stopReason: "toolUse" },
      );
    }
    if (latest?.role === "toolResult") {
      successfulToolResult(messages, "delegate_project");
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
  const faux = fauxProvider({
    provider: "smoke-faux",
    api: "smoke-faux-api",
    models: modelIds.map((id) => ({ id, reasoning: false, input: ["text"] })),
  });
  function response(context, _options, _state, model) {
    faux.appendResponses([response]);
    const answer = decide(model.id, context);
    if (model.id === "terminal-error") {
      const evidenceDir = join(
        process.env.PI_CODING_AGENT_DIR,
        "pi-herdsman",
        "runtime",
      );
      appendFileSync(
        join(evidenceDir, "smoke-faux-attempts.jsonl"),
        `${JSON.stringify({ model: model.id })}\n`,
      );
    }
    return answer;
  }
  faux.setResponses([response]);
  pi.registerProvider(faux.provider);
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
