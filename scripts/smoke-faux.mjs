import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  watch,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getCurrentTools,
  getCurrentSystemPrompt,
} from "@earendil-works/pi-ai";

const MANAGER_HANDOFF_SUPERVISOR_TOOL_NOT_OFFERED =
  "MANAGER_HANDOFF_SUPERVISOR_TOOL_NOT_OFFERED";

const modelIds = [
  "core",
  "continuation",
  "chief-tree",
  "supervisor-agent",
  "terminal-failure",
  "terminal-error",
  "agent-terminal-failure",
  "terminal-agent-error",
  "manager-handoff",
  "manager-handoff-lead",
  "manager-merge",
  "manager-merge-lead",
  "agent-crash-root",
  "agent-crash-recovery",
  "agent-crash-target",
  "agent-crash-parent",
  "agent-crash-child",
  "federated-peer-a",
  "federated-peer-b",
  "federated-peer-lead",
  "federated-peer-researcher",
  "federated-peer-source",
];

function piPackageFromExecutingCli(entryPoint = process.argv[1]) {
  if (entryPoint) {
    try {
      let directory = dirname(realpathSync(entryPoint));
      while (true) {
        try {
          const metadata = JSON.parse(
            readFileSync(join(directory, "package.json"), "utf8"),
          );
          if (metadata.name === "@earendil-works/pi-coding-agent")
            return metadata;
        } catch {}
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    } catch {}
  }
  const version = execFileSync("pi", ["--version"], { encoding: "utf8" })
    .trim()
    .replace(/^v/u, "");
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error("Could not resolve Pi package metadata from executing CLI");
  return { name: "@earendil-works/pi-coding-agent", version };
}

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

function correlatedCall(messages, name, identity) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const call = message.content?.find(
      (part) => part.type === "toolCall" && part.name === name,
    );
    if (!call) continue;
    if (
      identity &&
      call.arguments?.label !== identity &&
      call.arguments?.agent !== identity &&
      call.arguments?.branch !== identity
    )
      continue;
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

function successfulCallCount(messages, name) {
  return messages.filter(
    (message) =>
      message.role === "toolResult" &&
      message.toolName === name &&
      !message.isError,
  ).length;
}

function forwardableRefs(message) {
  const block = text(message).split("Forwardable received files:\n")[1] ?? "";
  return block
    .split("\n")
    .flatMap((line) => {
      const canonical = line.match(/\(canonical (result:[0-9a-f-]{36})\)/u);
      if (canonical) return [canonical[1]];
      const separator = line.indexOf(": ");
      return separator < 0 ? [] : [line.slice(separator + 2).trim()];
    })
    .filter(Boolean);
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

function supervisorAgentResult(messages) {
  const matched = correlatedCall(messages, "delegate_agent");
  if (!matched) return null;
  const details = text(matched.result);
  const sessionId = details.match(/^Session: ([^\n]+)$/m)?.[1];
  const requestId = details.match(/^Request: ([^\n]+)$/m)?.[1];
  if (!sessionId || !requestId)
    throw new Error(
      "Supervisor Agent assignment result omitted session/request identity",
    );
  const expectedHeader = `Agent result · agent=smoke-supervisor-agent · definition=smoke-agent · session=${sessionId} · status=completed`;
  const handoff = messages.find((message, index) => {
    if (index <= matched.resultIndex || message.role !== "user") return false;
    const metadata = message.details;
    const content = text(message);
    return (
      content.startsWith(expectedHeader) &&
      content.includes("SMOKE_SUPERVISOR_AGENT_COMPLETED") &&
      (!metadata ||
        (metadata.agentLabel === "smoke-supervisor-agent" &&
          metadata.agentDefinition === "smoke-agent" &&
          metadata.status === "completed" &&
          metadata.piSessionId === sessionId &&
          metadata.requestId === requestId))
    );
  });
  return handoff ? { sessionId, requestId, content: text(handoff) } : null;
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

export function managerHandoffSupervisorToolAvailable(messages) {
  return getCurrentTools(messages).some(
    (tool) => tool.name === "message_supervisor",
  );
}

function waitForResult(message) {
  return fauxAssistantMessage(message);
}

function logFederatedPeerBDecision({
  inboundRequestPresent,
  importedBindingVisible,
  branch,
  outcome,
  tool,
  modelExpected,
}) {
  const decision = JSON.stringify({
    ...(inboundRequestPresent ? { eventId: "peer-fixture-event" } : {}),
    inboundRequestPresent,
    importedBindingVisible,
    branch,
    outcome,
    ...(modelExpected === undefined ? {} : { modelExpected }),
    ...(tool ? { tool } : {}),
  });
  process.stderr.write(`[peer-faux-decision] ${decision}\n`);
  if (
    process.env.PEER_FEDERATION_DECISION_DIAGNOSTICS === "1" &&
    process.env.PI_CODING_AGENT_DIR
  )
    appendFileSync(
      join(process.env.PI_CODING_AGENT_DIR, "peer-federation-decisions.jsonl"),
      `${decision}\n`,
      { mode: 0o600 },
    );
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

function agentCrashRecoveryDecision(model, context) {
  const messages = context.messages;
  const prompt = text(lastUser(messages));
  const latest = messages.at(-1);
  if (model === "agent-crash-root") {
    const initial = messages.some(
      (message) =>
        message.role === "user" &&
        text(message).includes("PI_HERDSMAN_CRASH_RECOVERY_INITIAL"),
    );
    const postRestart = messages.find(
      (message) =>
        message.role === "user" &&
        text(message).includes("PI_HERDSMAN_CRASH_RECOVERY_AFTER_RESTART"),
    );
    if (initial && !postRestart) {
      if (!correlatedCall(messages, "delegate_agent", "smoke-crash-target"))
        return call("delegate_agent", {
          definition: "smoke-crash-target",
          label: "smoke-crash-target",
          task: "SMOKE_CRASH_TARGET: remain active until the isolated restart interrupts this generation.",
        });
      if (!correlatedCall(messages, "delegate_agent", "smoke-crash-parent"))
        return call("delegate_agent", {
          definition: "implementer",
          label: "smoke-crash-parent",
          task: "SMOKE_CRASH_PARENT: delegate one child that asks its owner a question, then wait for that child.",
        });
      return fauxAssistantMessage(
        "PI_HERDSMAN_CRASH_RECOVERY_ASSIGNMENTS_ACCEPTED",
      );
    }
    if (postRestart) {
      const list = correlatedCall(messages, "list_agents");
      if (!list) return call("list_agents", {});
      const closed = correlatedCall(
        messages,
        "close_agent",
        "smoke-crash-target",
      );
      if (!closed) return call("close_agent", { agent: "smoke-crash-target" });
      const continuePrompt = messages.find(
        (message) =>
          message.role === "user" &&
          text(message).includes("PI_HERDSMAN_CRASH_RECOVERY_CONTINUE"),
      );
      if (!continuePrompt)
        return fauxAssistantMessage("PI_HERDSMAN_CRASH_RECOVERY_CLOSED");
      const session = closed.result?.details?.closed_assignment?.session_path;
      if (!session)
        throw new Error("Restart prompt omitted exact target session path");
      const continued = correlatedCall(messages, "continue_agent");
      if (!continued)
        return call("continue_agent", {
          session,
          task: "SMOKE_CRASH_CONTINUE: return exactly PI_HERDSMAN_CRASH_RECOVERY_CONTINUED without replaying prior work.",
        });
      const sessionId = textFromSessionId(continued.result);
      const handoff = deliveredResult(
        messages,
        "continue_agent",
        (content) =>
          content.startsWith("Agent result · agent=") &&
          content.includes(`session=${sessionId} · status=completed`),
      );
      return handoff
        ? fauxAssistantMessage("PI_HERDSMAN_CRASH_RECOVERY_CONTINUED")
        : waitForResult("Waiting for the continued exact session result.");
    }
    throw new Error("Unexpected agent-crash root transcript");
  }
  if (model === "agent-crash-target") {
    if (prompt.includes("SMOKE_CRASH_CONTINUE:"))
      return fauxAssistantMessage("PI_HERDSMAN_CRASH_RECOVERY_CONTINUED");
    return waitForResult(
      "The original target execution is intentionally left in flight until server stop.",
    );
  }
  if (model === "agent-crash-parent") {
    const delegated = correlatedCall(
      messages,
      "delegate_agent",
      "smoke-crash-child",
    );
    if (!delegated)
      return call("delegate_agent", {
        definition: "scout",
        label: "smoke-crash-child",
        task: "SMOKE_CRASH_CHILD: ask your owner exactly CRASH_CHILD_WAITING and remain blocked.",
      });
    return waitForResult("Parent remains pending on its direct child.");
  }
  if (model === "agent-crash-child") {
    const asked = correlatedCall(messages, "ask_owner");
    if (!asked) return call("ask_owner", { question: "CRASH_CHILD_WAITING" });
    return waitForResult("Child remains blocked on its owner.");
  }
  if (latest?.role === "toolResult")
    throw new Error(`Unexpected recovery result for ${model}`);
  throw new Error(`Unexpected recovery model: ${model}`);
}

export function decide(model, context) {
  const messages = context.messages;
  const prompt = text(lastUser(messages));

  if (model === "terminal-error")
    return fauxAssistantMessage("CONTROLLED_PARTIAL_RESPONSE", {
      stopReason: "error",
      errorMessage: "503 Service Unavailable (controlled smoke failure)",
    });
  if (model === "terminal-agent-error")
    return fauxAssistantMessage("CONTROLLED_PARTIAL_RESPONSE", {
      stopReason: "error",
      errorMessage: "503 Service Unavailable (controlled smoke failure)",
    });
  if (model === "manager-handoff-lead") {
    if (prompt.includes("MANAGER_HANDOFF_READY")) {
      if (
        correlatedCall(messages, "message_supervisor")?.call.arguments
          ?.message === "MANAGER_HANDOFF_READY"
      )
        return fauxAssistantMessage("MANAGER_HANDOFF_READY");
      if (!managerHandoffSupervisorToolAvailable(messages))
        throw new Error(MANAGER_HANDOFF_SUPERVISOR_TOOL_NOT_OFFERED);
      return call("message_supervisor", { message: "MANAGER_HANDOFF_READY" });
    }
    const marker = prompt.match(/MANAGER_HANDOFF_PENDING_[0-9a-f-]+/)?.[0];
    if (!marker) throw new Error("Unexpected manager-handoff-lead transcript");
    if (
      correlatedCall(messages, "message_supervisor")?.call.arguments
        ?.message === marker
    )
      return fauxAssistantMessage("MANAGER_HANDOFF_SENT");
    if (!managerHandoffSupervisorToolAvailable(messages))
      throw new Error(MANAGER_HANDOFF_SUPERVISOR_TOOL_NOT_OFFERED);
    return call("message_supervisor", { message: marker });
  }
  if (model === "manager-merge-lead") {
    const firstSupervisorResult = messages.findIndex(
      (message) =>
        message.role === "toolResult" &&
        message.toolName === "message_supervisor",
    );
    const repairIndex = messages.findIndex(
      (message, index) =>
        index > firstSupervisorResult &&
        message.role === "user" &&
        text(message).includes("MANAGER_MERGE_REPAIR"),
    );
    const repair =
      firstSupervisorResult >= 0 && repairIndex > firstSupervisorResult;
    const command = repair
      ? "git merge --no-edit main && test -f manager-merge-source.txt && git status --porcelain && git rev-parse HEAD"
      : "git config user.name 'Herdsman Smoke' && git config user.email smoke@example.invalid && printf 'source\n' > manager-merge-source.txt && git add manager-merge-source.txt && git commit -m 'Manager merge smoke source' && git rev-parse HEAD";
    const bash = correlatedCall(messages, "bash");
    if (!bash || (repair && bash.resultIndex < repairIndex))
      return call("bash", { command, timeout: 30000 });
    const result = bash.result;
    if (!result || result.isError)
      throw new Error("Manager merge Lead Git command failed");
    const sha = text(result)
      .match(/\b[0-9a-f]{40,64}\b/gi)
      ?.at(-1);
    if (!sha) throw new Error("Manager merge Lead Git command omitted HEAD");
    const message = `${repair ? "MANAGER_MERGE_REPAIRED" : "MANAGER_MERGE_SOURCE_READY"} ${sha}`;
    const reported = correlatedCall(messages, "message_supervisor");
    if (!reported || reported.resultIndex < bash.resultIndex)
      return call("message_supervisor", { message });
    return waitForResult(
      "Waiting for the Manager merge scenario's next Lead instruction.",
    );
  }
  if (model === "manager-merge") {
    const assignment = correlatedCall(messages, "delegate_project");
    if (!assignment && prompt.includes("MANAGER_MERGE_ASSIGN")) {
      const branch = prompt.match(/branch ([^\s]+)/)?.[1];
      if (!branch) throw new Error("Manager merge assignment omitted branch");
      return call("delegate_project", {
        branch,
        task: "Create a committed source change using bash, then message_supervisor with MANAGER_MERGE_SOURCE_READY and its exact full HEAD. Wait for a MANAGER_MERGE_REPAIR message; merge main, validate the source file and clean Git status, then message_supervisor with MANAGER_MERGE_REPAIRED and the exact resulting HEAD.",
      });
    }
    if (!assignment)
      throw new Error("Manager merge decision lacks its assigned Lead");
    const attempt = prompt.match(/MANAGER_MERGE_ATTEMPT ([0-9a-f]{40,64})/i);
    if (attempt) {
      const previous = correlatedCall(messages, "merge_project");
      if (previous?.call.arguments?.expected_head === attempt[1])
        return waitForResult(
          "Waiting for the next explicit Manager merge scenario step.",
        );
      return call("merge_project", {
        branch: assignment.call.arguments.branch,
        expected_head: attempt[1],
      });
    }
    const repair = prompt.match(
      /MANAGER_MERGE_NOTIFY ([A-Za-z0-9._-]+) ([0-9a-f]{40,64})/i,
    );
    if (repair) {
      if (correlatedCall(messages, "message_staff"))
        return waitForResult(
          "Waiting for the assigned Lead's reconciliation report.",
        );
      return call("message_staff", {
        session: repair[1],
        message: `MANAGER_MERGE_REPAIR Incorporate target main at ${repair[2]}, preserve your source change, validate, and report exact final HEAD.`,
      });
    }
    return waitForResult(
      "Waiting for the next explicit Manager merge scenario step.",
    );
  }
  if (model === "manager-handoff") {
    const assignment = correlatedCall(messages, "delegate_project");
    if (!assignment && prompt.includes("Use delegate_project exactly once")) {
      const branch = prompt.match(/branch ([^\s]+) and task exactly/)?.[1];
      const task = prompt.match(/task exactly ("(?:[^"\\]|\\.)*")/)?.[1];
      if (!branch || !task)
        throw new Error("Missing Manager handoff assignment details");
      return call("delegate_project", { branch, task: JSON.parse(task) });
    }
    if (!assignment) throw new Error("Unexpected manager-handoff transcript");
    const branch = assignment.call.arguments?.branch;
    const leadSessionId = text(assignment.result).match(
      /^Session: ([^\n]+)$/m,
    )?.[1];
    if (!branch || !leadSessionId)
      throw new Error("Manager handoff assignment omitted exact identity");
    if (
      messages.some(
        (message, index) =>
          index > assignment.resultIndex &&
          message.role === "user" &&
          text(message) ===
            `Project ${branch} from lead ${leadSessionId}:\n\nMANAGER_HANDOFF_READY`,
      )
    )
      return fauxAssistantMessage("MANAGER_HANDOFF_READY_RECEIVED");
    return waitForResult(
      "Waiting for the exact assigned Lead readiness message.",
    );
  }
  if (model === "federated-peer-a") {
    const managedSession = prompt.match(
      /PEER_E2E_A_TEST_MANAGED ([0-9a-f-]{36})/u,
    )?.[1];
    if (managedSession) {
      const listed = correlatedCall(messages, "list_peers");
      if (!listed) return call("list_peers", {});
      if (text(listed.result).includes(managedSession))
        throw new Error("managed Lead appeared in ordinary peer listing");
      const rejected = messages.find(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "message_peer" &&
          message.isError,
      );
      if (rejected) return fauxAssistantMessage("PEER_E2E_A_MANAGED_REJECTED");
      if (successfulCallCount(messages, "message_peer"))
        throw new Error("managed Lead message unexpectedly succeeded");
      return call("message_peer", {
        session: managedSession,
        message: "must be rejected",
      });
    }
    if (prompt.includes("PEER_E2E_A_LEAD_WAIT_REPLY")) {
      if (
        messages.some(
          (message) =>
            message.type === "custom_message" &&
            message.customType === "pi-herdsman-peer_message" &&
            text(message).includes("PEER_E2E_LEAD_REPLY"),
        )
      )
        return fauxAssistantMessage("PEER_E2E_A_LEAD_REPLY_RECEIVED");
      return waitForResult("Waiting for background Lead reply reconciliation.");
    }
    if (prompt.includes("PEER_E2E_A_LEAD_SEND")) {
      const listed = correlatedCall(messages, "list_peers");
      if (!listed) return call("list_peers", {});
      const peers = JSON.parse(text(listed.result));
      const peer = peers.peers?.find((candidate) => candidate.machine);
      if (!peer) throw new Error("ordinary Lead send found no remote Lead");
      const semantic = prompt.match(/\bresult:[A-Za-z0-9_-]+#\d+\b/u)?.[0];
      if (!semantic)
        throw new Error("ordinary Lead request omitted its result reference");
      if (successfulCallCount(messages, "message_peer") === 0)
        return call("message_peer", {
          session: peer.session,
          message: `PEER_E2E_CORRELATION_ID PEER_E2E_LEAD_REQUEST: inspect the portable file and use ${semantic}.`,
          files: ["spec.md", semantic],
        });
      return fauxAssistantMessage("PEER_E2E_A_LEAD_SENT");
    }
    if (
      messages.some(
        (message) =>
          message.type === "custom_message" &&
          message.customType === "pi-herdsman-peer_message" &&
          text(message).includes("PEER_E2E_LEAD_REPLY"),
      )
    )
      return fauxAssistantMessage("PEER_E2E_A_LEAD_REPLY_RECEIVED");
    if (prompt.includes("PEER_E2E_A_SINGLE_SEND")) {
      const listed = correlatedCall(messages, "list_peers");
      if (!listed) return call("list_peers", {});
      const peers = JSON.parse(text(listed.result));
      const peer = peers.peers?.find((candidate) => candidate.machine);
      if (!peer)
        throw new Error("single-message fixture found no remote Manager");
      if (successfulCallCount(messages, "message_peer") === 0)
        return call("message_peer", {
          session: peer.session,
          message:
            "PEER_E2E_SINGLE_REQUEST: verify receiving Manager delivery.",
        });
      return fauxAssistantMessage("PEER_E2E_A_SINGLE_SENT");
    }
    if (prompt.includes("PEER_E2E_A_DISCOVER")) {
      const listed = correlatedCall(messages, "list_peers");
      if (!listed) return call("list_peers", {});
      const result = JSON.parse(text(listed.result));
      if (!result.peers?.some((peer) => peer.machine))
        throw new Error("federation discovery found no remote Manager");
      return fauxAssistantMessage("PEER_E2E_A_DISCOVERED");
    }
    if (prompt.includes("PEER_E2E_A_OUTBOUND_RECOVERY_FIRST")) {
      return fauxAssistantMessage("PEER_E2E_A_OUTBOUND_RECOVERY_FIRST_DONE");
    }
    if (prompt.includes("PEER_E2E_A_OUTBOUND_RECOVERY_STATUS")) {
      return fauxAssistantMessage("PEER_E2E_A_OUTBOUND_RECOVERY_STATUS_DONE");
    }
    const send = prompt.includes("PEER_E2E_A_SEND");
    const list = correlatedCall(messages, "list_peers");
    if (send && !list) return call("list_peers", {});
    if (send && list && successfulCallCount(messages, "message_peer") === 0) {
      const peers = JSON.parse(text(list.result));
      const peer = peers.peers?.find((candidate) => candidate.machine);
      if (!peer) throw new Error("federation smoke found no remote Manager");
      const semantic = prompt.match(/\bresult:[A-Za-z0-9_-]+#\d+\b/)?.[0];
      if (!semantic)
        throw new Error("federation smoke omitted semantic result evidence");
      return call("message_peer", {
        session: peer.session,
        message:
          "PEER_E2E_REQUEST: delegate the attached Manager spec and report the result.",
        files: ["manager-spec.md", semantic],
      });
    }
    if (send && successfulCallCount(messages, "message_peer") === 1) {
      const peers = JSON.parse(text(list.result));
      const peer = peers.peers?.find((candidate) => candidate.machine);
      return call("message_peer", {
        session: peer.session,
        message: "PEER_E2E_REQUEST_SECOND: same verified Manager pair.",
      });
    }
    if (send && successfulCallCount(messages, "message_peer") >= 2)
      return fauxAssistantMessage("PEER_E2E_A_SENT");
    if (
      messages.some(
        (message) =>
          (message.role === "user" || message.type === "custom_message") &&
          text(message).includes("PEER_E2E_REPLY_FINAL"),
      )
    ) {
      const forwarding = messages.some(
        (message) =>
          message.role === "user" &&
          text(message).includes("PEER_E2E_A_FORWARD_REPLY"),
      );
      if (forwarding) {
        const forwarded = messages.some(
          (message) =>
            message.role === "user" &&
            text(message).includes("PEER_E2E_A_FORWARDED"),
        );
        if (forwarded)
          return fauxAssistantMessage("PEER_E2E_A_REPLY_FORWARDED");
        const reply = [...messages]
          .reverse()
          .find(
            (message) =>
              (message.role === "user" || message.type === "custom_message") &&
              text(message).includes("PEER_E2E_REPLY_FINAL"),
          );
        const files = forwardableRefs(reply);
        if (files.length < 2)
          throw new Error("reply evidence was not forwardable through files");
        const assignment = correlatedCall(messages, "delegate_project");
        if (!assignment)
          return call("delegate_project", {
            branch: `herdsman/peer-reply-${randomUUID().slice(0, 8)}`,
            task: "PEER_E2E_A_FORWARD_TASK: read the returned file and semantic result fallback, then report PEER_E2E_A_FORWARDED.",
            files,
          });
        const done = messages.some(
          (message, index) =>
            index > assignment.resultIndex &&
            (message.role === "user" || message.type === "custom_message") &&
            text(message).includes("PEER_E2E_A_FORWARDED"),
        );
        return done
          ? fauxAssistantMessage("PEER_E2E_A_REPLY_FORWARDED")
          : waitForResult("Waiting for A's local evidence forwarding Lead.");
      }
      return fauxAssistantMessage("PEER_E2E_A_RECEIVED_REPLY");
    }
    if (
      messages.some(
        (message) =>
          message.type === "custom_message" &&
          message.customType === "pi-herdsman-peer_message" &&
          text(message).includes("PEER_E2E_REPLY_PROGRESS"),
      )
    )
      return fauxAssistantMessage("PEER_E2E_A_PROGRESS_RECEIVED");
    throw new Error("Unexpected federated-peer A transcript");
  }
  if (model === "federated-peer-b") {
    const inboundMessage = messages.find(
      (message) =>
        (message.role === "user" || message.type === "custom_message") &&
        text(message).includes("PEER_E2E_LEAD_REQUEST"),
    );
    const inboundRequestPresent = !!inboundMessage;
    const importedBindingVisible = messages.some(
      (message) =>
        message.type === "custom" &&
        message.customType === "pi-herdsman-result-ref" &&
        typeof message.data?.ref === "string" &&
        typeof message.data?.canonicalRef === "string",
    );
    logFederatedPeerBDecision({
      inboundRequestPresent,
      importedBindingVisible,
      branch: inboundRequestPresent
        ? "inbound_lead_request"
        : prompt.includes("PEER_E2E_B_CAPTURE_SESSION")
          ? "capture_session"
          : "other",
      outcome: "decision_started",
    });
    if (prompt.includes("PEER_E2E_B_ASSIGN_MANAGED")) {
      const assignment = correlatedCall(messages, "delegate_project");
      if (!assignment)
        return call("delegate_project", {
          branch: "herdsman/peer-smoke-managed",
          task: "Confirm the assigned task is complete and report PEER_E2E_MANAGED_LEAD_COMPLETE.",
        });
      if (assignment.result.isError)
        throw new Error("managed Lead project assignment failed");
      return fauxAssistantMessage("PEER_E2E_B_MANAGED_ASSIGNED");
    }
    if (inboundRequestPresent) {
      const inbound = inboundMessage;
      const semantic = text(inbound).match(
        /\bresult:[A-Za-z0-9_-]+#\d+\b/u,
      )?.[0];
      const refs = forwardableRefs(inbound);
      if (!semantic || !refs.some((ref) => /^result:[0-9a-f-]{36}$/u.test(ref)))
        throw new Error(
          "Lead recipient did not receive usable result-reference and artifact-content evidence",
        );
      const canonicalRef = refs.find((ref) =>
        /^result:[0-9a-f-]{36}$/u.test(ref),
      );
      const imported =
        context.peerImportedBindingVisible === true ||
        messages.some(
          (message) =>
            message.type === "custom" &&
            message.customType === "pi-herdsman-result-ref" &&
            message.data?.ref === semantic &&
            message.data?.canonicalRef === canonicalRef,
        );
      if (!imported) {
        logFederatedPeerBDecision({
          inboundRequestPresent,
          importedBindingVisible: imported,
          branch: "inbound_lead_request",
          outcome: "waiting_for_binding",
        });
        return waitForResult(
          "Waiting for the received result binding to be imported in this Lead session.",
        );
      }
      const artifactPath = join(
        process.env.PI_CODING_AGENT_DIR,
        "pi-herdsman",
        "results",
        canonicalRef.slice("result:".length),
      );
      const artifactRead = correlatedCall(messages, "read");
      if (!artifactRead) {
        logFederatedPeerBDecision({
          inboundRequestPresent,
          importedBindingVisible: imported,
          branch: "inbound_lead_request",
          outcome: "tool_call",
          tool: "read",
        });
        return call("read", { path: artifactPath });
      }
      if (artifactRead.call.arguments?.path !== artifactPath)
        throw new Error(
          "Lead read a different result artifact than the imported canonical reference",
        );
      const artifact = text(artifactRead.result);
      if (!artifact.includes("PEER_E2E_PORTABLE_RESULT_CONTENT_V1"))
        throw new Error(
          "Imported canonical result artifact omitted expected portable content",
        );
      const artifactSha256 = createHash("sha256")
        .update(artifact)
        .digest("hex");
      const origin = text(inbound).match(
        /Peer message from ([0-9a-f-]{36}):/u,
      )?.[1];
      if (!origin) throw new Error("Lead request omitted exact origin session");
      if (successfulCallCount(messages, "message_peer") === 0) {
        logFederatedPeerBDecision({
          inboundRequestPresent,
          importedBindingVisible: imported,
          branch: "inbound_lead_request",
          outcome: "tool_call",
          tool: "message_peer",
        });
        return call("message_peer", {
          session: origin,
          message: `PEER_E2E_LEAD_REPLY: used ${semantic} (${canonicalRef}, sha256 ${artifactSha256}) after reading PEER_E2E_PORTABLE_RESULT_CONTENT_V1 from the imported artifact.`,
        });
      }
      logFederatedPeerBDecision({
        inboundRequestPresent,
        importedBindingVisible: imported,
        branch: "inbound_lead_request",
        outcome: "assistant_complete",
      });
      return fauxAssistantMessage("PEER_E2E_B_LEAD_REPLIED");
    }
    if (prompt.includes("PEER_E2E_B_CAPTURE_SESSION")) {
      logFederatedPeerBDecision({
        inboundRequestPresent,
        importedBindingVisible,
        branch: "capture_session",
        outcome: "assistant_complete",
      });
      return fauxAssistantMessage("PEER_E2E_B_CAPTURED");
    }
    if (
      messages.some(
        (message) =>
          message.role === "user" &&
          text(message).includes("PEER_E2E_SINGLE_REQUEST"),
      )
    )
      return fauxAssistantMessage("PEER_E2E_B_SINGLE_RECEIVED");
    const inbounds = messages.filter(
      (message) =>
        (message.role === "user" || message.type === "custom_message") &&
        text(message).includes("PEER_E2E_REQUEST"),
    );
    const inbound =
      inbounds.find((message) => forwardableRefs(message).length >= 2) ??
      inbounds[0];
    if (
      inbounds.some((message) =>
        text(message).includes("PEER_E2E_SINGLE_REQUEST"),
      )
    )
      return fauxAssistantMessage("PEER_E2E_B_SINGLE_RECEIVED");
    const origin = text(inbound).match(
      /Peer message from ([0-9a-f-]{36}):/,
    )?.[1];
    if (inbound && !origin)
      throw new Error(
        "federation smoke could not identify the exact origin session",
      );
    const semantic = text(inbound).match(/\bresult:[A-Za-z0-9_-]+#\d+\b/)?.[0];
    if (inbounds.length < 2)
      return waitForResult(
        "Waiting for both requests on the Manager pair route.",
      );
    const branch = `herdsman/federation-smoke-${origin.slice(0, 8)}`;
    const assignment = correlatedCall(messages, "delegate_project", branch);
    if (!assignment) {
      const forwardable =
        text(inbound).split("Forwardable received files:\n")[1] ?? "";
      const refs = forwardableRefs(inbound);
      if (refs.length < 2)
        throw new Error(
          "federation smoke did not receive forwardable evidence",
        );
      return call("delegate_project", {
        branch,
        task: "PEER_E2E_LOCAL_TASK: read the forwarded spec and canonical result artifacts, then message_supervisor with PEER_E2E_LOCAL_RESULT.",
        files: refs,
      });
    }
    if (
      !messages.some(
        (message, index) =>
          index > assignment.resultIndex &&
          (message.role === "user" || message.type === "custom_message") &&
          text(message).includes("PEER_E2E_LOCAL_RESULT"),
      )
    )
      return waitForResult("Waiting for the local Lead result.");
    const replies = successfulCallCount(messages, "message_peer");
    if (replies >= 2) return fauxAssistantMessage("PEER_E2E_B_REPLIED");
    return replies === 0
      ? call("message_peer", {
          session: origin,
          message: "PEER_E2E_REPLY_PROGRESS: delegation is complete.",
        })
      : call("message_peer", {
          session: origin,
          message:
            "PEER_E2E_REPLY_FINAL: local delegation inspected the forwarded evidence.",
          files: ["reply.txt", semantic],
        });
  }
  if (model === "federated-peer-lead") {
    const promptMessage = text(lastUser(messages));
    if (promptMessage.includes("PEER_E2E_MANAGED_LEAD_COMPLETE"))
      return fauxAssistantMessage("PEER_E2E_MANAGED_LEAD_COMPLETE");
    const isBTask = promptMessage.includes("PEER_E2E_LOCAL_TASK");
    const isATask = promptMessage.includes("PEER_E2E_A_FORWARD_TASK");
    if (!isBTask && !isATask)
      throw new Error("Unexpected federation Lead task");
    const paths = [
      ...promptMessage.matchAll(/<file name="([^"]+)" bytes="\d+">/gu),
    ].map((match) => match[1]);
    if (paths.length < 2)
      throw new Error("federation Lead did not receive both evidence refs");
    const successfulReads = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content ?? [])
      .filter(
        (part) =>
          part.type === "toolCall" &&
          part.name === "read" &&
          messages.some(
            (candidate) =>
              candidate.role === "toolResult" &&
              candidate.toolName === "read" &&
              candidate.toolCallId === part.id &&
              !candidate.isError,
          ),
      );
    if (successfulReads.length < paths.length) {
      const path = paths[successfulReads.length];
      return call("read", { path });
    }
    const resultMarker = isBTask
      ? "PEER_E2E_LOCAL_RESULT"
      : "PEER_E2E_A_FORWARDED";
    if (correlatedCall(messages, "message_supervisor"))
      return fauxAssistantMessage(resultMarker);
    return call("message_supervisor", {
      message: `${resultMarker}: inspected forwarded files and result evidence.`,
    });
  }
  if (model === "federated-peer-researcher")
    return fauxAssistantMessage(
      `PEER_E2E_SEED_RESULT_COMPLETE: completed local result artifact for ${text(lastUser(messages))}.`,
    );
  if (model === "federated-peer-source") {
    const side = prompt.match(/PEER_E2E_SOURCE_RESULT ([ab])/u)?.[1];
    if (!side) throw new Error("source-result prompt omitted fixture machine");
    const assignment = correlatedCall(messages, "delegate_agent");
    if (!assignment)
      return call("delegate_agent", {
        definition: "researcher",
        task: `Create a concise completed test-owned result artifact for federation evidence seeding on machine ${side}; include that machine identity and the exact text PEER_E2E_PORTABLE_RESULT_CONTENT_V1 in the result.`,
      });
    return assignment.result && !assignment.result.isError
      ? fauxAssistantMessage("PEER_E2E_SOURCE_RESULT_COMPLETE")
      : waitForResult(
          "Waiting for the exact researcher terminal result handoff.",
        );
  }
  if (model === "agent-terminal-failure") {
    const matched = correlatedCall(messages, "delegate_agent");
    if (matched) {
      const details = text(matched.result);
      const sessionId = details.match(/^Session: ([^\n]+)$/m)?.[1];
      const requestId = details.match(/^Request: ([^\n]+)$/m)?.[1];
      if (!sessionId || !requestId)
        throw new Error("Agent delegation omitted identity");
      const handoff = messages.find(
        (message, index) =>
          index > matched.resultIndex &&
          message.role === "user" &&
          text(message).startsWith(
            `Agent result · agent=smoke-terminal-agent · definition=smoke-failure-agent · session=${sessionId} · status=failed`,
          ),
      );
      return handoff
        ? fauxAssistantMessage("SMOKE_AGENT_FAILURE_DELIVERED")
        : waitForResult("Waiting for the exact Agent failure handoff.");
    }
    if (
      messages.some(
        (message) =>
          message.role === "assistant" &&
          message.content?.some(
            (part) =>
              part.type === "toolCall" && part.name === "delegate_agent",
          ),
      )
    )
      throw new Error("Agent delegation result was missing or unsuccessful");
    return call("delegate_agent", {
      definition: "smoke-failure-agent",
      label: "smoke-terminal-agent",
      task: "Wait for the controlled terminal model failure.",
    });
  }
  if (model === "chief-tree") {
    const marker = prompt.match(
      /PI_HERDSMAN_CHIEF_TREE_(?:STARTUP|POST_CHIEF|FOLLOWUP)/,
    )?.[0];
    if (!marker) throw new Error("Unexpected chief-tree request");
    return fauxAssistantMessage(marker);
  }
  if (model === "supervisor-agent") {
    const latest = messages.at(-1);
    const task = messages.find(
      (message) =>
        message.role === "user" &&
        text(message).includes("SMOKE_SUPERVISOR_AGENT_TASK"),
    );
    if (task) return fauxAssistantMessage("SMOKE_SUPERVISOR_AGENT_COMPLETED");
    if (
      messages.some(
        (message) =>
          message.role === "user" &&
          text(message).includes("SMOKE_SUPERVISOR_AGENT_DELEGATE"),
      )
    ) {
      const result = supervisorAgentResult(messages);
      if (result)
        return fauxAssistantMessage("PI_HERDSMAN_SUPERVISOR_AGENT_DELIVERED");
      if (correlatedCall(messages, "delegate_agent"))
        return waitForResult("Waiting for the completed Agent result.");
      return call("delegate_agent", {
        definition: "smoke-agent",
        label: "smoke-supervisor-agent",
        task: "SMOKE_SUPERVISOR_AGENT_TASK: return SMOKE_SUPERVISOR_AGENT_COMPLETED.",
      });
    }
    if (
      messages.some(
        (message) =>
          message.role === "user" &&
          text(message).includes("PI_HERDSMAN_SUPERVISOR_AGENT_STARTUP"),
      )
    )
      return fauxAssistantMessage("PI_HERDSMAN_SUPERVISOR_AGENT_STARTUP");
    throw new Error(
      `Unexpected supervisor-agent transcript (${latest?.role ?? "empty"})`,
    );
  }
  if (model === "core") return coreDecision(context);
  if (model === "continuation") return continuationDecision(messages);
  if (model.startsWith("agent-crash-"))
    return agentCrashRecoveryDecision(
      model === "agent-crash-recovery" ? "agent-crash-root" : model,
      context,
    );

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

export async function waitForSmokeObservation(directory, filename, signal) {
  signal?.throwIfAborted();
  let watcher;
  let timeout;
  let abort;
  try {
    await new Promise((resolve, reject) => {
      const check = () => {
        if (existsSync(join(directory, filename))) resolve();
      };
      watcher = watch(directory, check);
      watcher.on("error", reject);
      timeout = setTimeout(
        () =>
          reject(
            new Error(`Smoke live evidence was not acknowledged: ${filename}`),
          ),
        120_000,
      );
      abort = () => reject(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else check();
    });
  } finally {
    watcher?.close();
    clearTimeout(timeout);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export function waitForContinuationObservation(directory, signal) {
  return waitForSmokeObservation(
    directory,
    "continuation-first-observed",
    signal,
  );
}

export default function install(pi) {
  let terminalErrorRequests = 0;
  let sessionId;
  let peerImportedBindingVisible = false;
  const recordedSessions = new Set();
  if (process.env.PEER_FEDERATION_DECISION_DIAGNOSTICS === "1") {
    pi.on("before_agent_start", (event, context) => {
      const message =
        event.messageType === "custom" ? event.message : undefined;
      const content = text(message);
      const inboundRequestPresent =
        message?.customType === "pi-herdsman-peer_message" &&
        content.includes("PEER_E2E_LEAD_REQUEST");
      const importedBindingVisible = context.sessionManager
        .getBranch()
        .some(
          (entry) =>
            entry.type === "custom" &&
            entry.customType === "pi-herdsman-result-ref" &&
            typeof entry.data?.ref === "string" &&
            typeof entry.data?.canonicalRef === "string",
        );
      peerImportedBindingVisible = importedBindingVisible;
      logFederatedPeerBDecision({
        inboundRequestPresent,
        importedBindingVisible,
        branch: inboundRequestPresent ? "inbound_lead_request" : "other",
        outcome: "before_agent_start",
      });
    });
  }
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
    if (model.id === "manager-merge" || model.id === "manager-merge-lead") {
      const tools = getCurrentTools(context.messages).map((tool) => tool.name);
      const latestUser = lastUser(context.messages);
      const firstSupervisorResult = context.messages.findIndex(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "message_supervisor",
      );
      const repairInstructionObserved =
        model.id === "manager-merge-lead" &&
        context.messages.some(
          (message, index) =>
            index > firstSupervisorResult &&
            message.role === "user" &&
            text(message).includes("MANAGER_MERGE_REPAIR"),
        );
      appendFileSync(
        join(
          process.env.PI_CODING_AGENT_DIR,
          "pi-herdsman",
          "runtime",
          "smoke-faux-attempts.jsonl",
        ),
        `${JSON.stringify({ model: model.id, prompt: text(latestUser).match(/MANAGER_MERGE_[A-Z_]+/)?.[0] ?? "other", repairInstructionObserved, tools: tools.filter((name) => ["bash", "delegate_project", "merge_project", "message_staff", "message_supervisor"].includes(name)), priorCalls: context.messages.filter((message) => message.role === "toolResult" && ["bash", "message_staff", "message_supervisor", "merge_project"].includes(message.toolName)).map((message) => message.toolName) })}\n`,
      );
    }
    if (!recordedSessions.has(currentSessionId)) {
      let piPackage;
      try {
        piPackage = piPackageFromExecutingCli();
      } catch (error) {
        throw new Error("Could not resolve Pi package metadata", {
          cause: error,
        });
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
        hasLeadIdentity: systemPrompt.includes(
          "You are the Lead for this Pi session.",
        ),
        hasManagerIdentity: systemPrompt.includes(
          "You are the verified Manager for this Pi session.",
        ),
        hasChiefIdentity: systemPrompt.includes(
          "You are the verified workspace-neutral Chief",
        ),
        hasRoleSection: systemPrompt.includes("<pi_herdsman_role>"),
      };
      if (
        provenance.hasRoleSection &&
        provenance.hasLeadIdentity &&
        (provenance.hasManagerIdentity || provenance.hasChiefIdentity)
      )
        throw new Error(
          "Provider request contains contradictory role identities",
        );
      if (model.id === "core" && !process.env.PI_HERDSMAN_AGENT_DEFINITION) {
        if (!provenance.hasRoleSection || !provenance.hasLeadIdentity)
          throw new Error("Provider request omitted the Lead role contract");
        if (provenance.hasManagerIdentity || provenance.hasChiefIdentity)
          throw new Error(
            "Provider request contains a contradictory role identity",
          );
      }
      const expectedRole =
        model.id.startsWith("manager-") && !model.id.endsWith("-lead")
          ? "manager"
          : undefined;
      if (expectedRole) {
        if (!provenance.hasRoleSection)
          throw new Error(
            `Provider request omitted the ${expectedRole} role section`,
          );
        const identity = {
          lead: provenance.hasLeadIdentity,
          manager: provenance.hasManagerIdentity,
          chief: provenance.hasChiefIdentity,
        };
        if (!identity[expectedRole])
          throw new Error(
            `Provider request omitted the ${expectedRole} role contract`,
          );
        if (
          Object.entries(identity).some(
            ([role, present]) => role !== expectedRole && present,
          )
        )
          throw new Error(
            `Provider request contains an identity other than ${expectedRole}`,
          );
      }
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
    if (model.id === "chief-tree") {
      const systemPrompt = getCurrentSystemPrompt(context.messages);
      const request = text(lastUser(context.messages));
      const expectedRole = request.includes("PI_HERDSMAN_CHIEF_TREE_POST_CHIEF")
        ? "chief"
        : request.includes("PI_HERDSMAN_CHIEF_TREE_STARTUP") ||
            request.includes("PI_HERDSMAN_CHIEF_TREE_FOLLOWUP")
          ? "lead"
          : undefined;
      if (expectedRole) {
        const identity = {
          lead: systemPrompt.includes("You are the Lead for this Pi session."),
          manager: systemPrompt.includes(
            "You are the verified Manager for this Pi session.",
          ),
          chief: systemPrompt.includes(
            "You are the verified workspace-neutral Chief",
          ),
        };
        if (!identity[expectedRole])
          throw new Error(
            `Provider request omitted the ${expectedRole} identity`,
          );
        if (
          Object.entries(identity).some(
            ([role, present]) => role !== expectedRole && present,
          )
        )
          throw new Error(
            `Provider request contains an identity other than ${expectedRole}`,
          );
      }
    }
    if (model.id === "terminal-error" || model.id === "terminal-agent-error") {
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
        `${JSON.stringify({ model: model.id, hasRoster, sessionId: currentSessionId })}\n`,
      );
      if (model.id === "terminal-error" && first && !hasRoster)
        throw new Error(
          "Assigned Lead's initial request omitted session-matched agent definitions",
        );
    }
    let answer;
    try {
      if (process.env.PEER_FEDERATION_DECISION_DIAGNOSTICS === "1") {
        const inboundRequestPresent = context.messages.some(
          (message) =>
            (message.role === "user" || message.type === "custom_message") &&
            text(message).includes("PEER_E2E_LEAD_REQUEST"),
        );
        const importedBindingVisible =
          peerImportedBindingVisible ||
          context.messages.some(
            (message) =>
              message.type === "custom" &&
              message.customType === "pi-herdsman-result-ref" &&
              typeof message.data?.ref === "string" &&
              typeof message.data?.canonicalRef === "string",
          );
        const prompt = text(lastUser(context.messages));
        logFederatedPeerBDecision({
          inboundRequestPresent,
          importedBindingVisible,
          branch: inboundRequestPresent
            ? "inbound_lead_request"
            : prompt.includes("PEER_E2E_B_CAPTURE_SESSION")
              ? "capture_session"
              : "other",
          outcome: "model_invocation",
          modelExpected: model.id === "federated-peer-b",
        });
      }
      answer = decide(model.id, {
        ...context,
        peerImportedBindingVisible,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === MANAGER_HANDOFF_SUPERVISOR_TOOL_NOT_OFFERED
      ) {
        appendFileSync(
          join(
            process.env.PI_CODING_AGENT_DIR,
            "pi-herdsman",
            "runtime",
            "smoke-faux-attempts.jsonl",
          ),
          `${JSON.stringify({ model: model.id, supervisorToolAvailability: "not_offered" })}\n`,
        );
      }
      throw error;
    }
    if (
      model.id === "continuation" &&
      answer.stopReason === "stop" &&
      text(answer).includes("CONTINUATION_FIRST_DONE")
    ) {
      return waitForSmokeObservation(
        join(process.env.PI_CODING_AGENT_DIR, "pi-herdsman", "runtime"),
        "continuation-first-observed",
        _options?.signal,
      ).then(() => answer);
    }
    if (
      model.id === "agent-crash-target" &&
      !text(lastUser(context.messages)).includes("SMOKE_CRASH_CONTINUE:")
    )
      return waitForSmokeObservation(
        join(process.env.PI_CODING_AGENT_DIR, "pi-herdsman", "runtime"),
        "crash-target-release",
        _options?.signal,
      ).then(() => answer);
    if (
      model.id === "agent-crash-target" &&
      text(lastUser(context.messages)).includes("SMOKE_CRASH_CONTINUE:")
    )
      return waitForSmokeObservation(
        join(process.env.PI_CODING_AGENT_DIR, "pi-herdsman", "runtime"),
        "crash-continuation-release",
        _options?.signal,
      ).then(() => answer);
    if (
      model.id === "agent-crash-parent" &&
      answer.stopReason === "stop" &&
      correlatedCall(context.messages, "delegate_agent", "smoke-crash-child")
    )
      return waitForSmokeObservation(
        join(process.env.PI_CODING_AGENT_DIR, "pi-herdsman", "runtime"),
        "crash-parent-release",
        _options?.signal,
      ).then(() => answer);
    if (model.id === "terminal-agent-error" && terminalErrorRequests === 1)
      return waitForSmokeObservation(
        join(process.env.PI_CODING_AGENT_DIR, "pi-herdsman", "runtime"),
        "agent-terminal-failure-observed",
        _options?.signal,
      ).then(() => answer);
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
      !["terminal-error", "terminal-agent-error"].includes(ctx.model?.id)
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
