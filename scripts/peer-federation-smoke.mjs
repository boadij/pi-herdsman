#!/usr/bin/env node
// Disposable, explicitly owned Docker fixture for the real peer-federation smoke.
// Run with `node scripts/peer-federation-smoke.mjs`; set PEER_SMOKE_KEEP=1 to
// retain resources for diagnosis (the printed manifest is the cleanup authority).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  cleanupSmokeFixture,
  isMissingDockerResource,
} from "./peer-federation-cleanup.mjs";
import {
  assertPeerInListPeersResult,
  delegateResultEvidence,
  isLiveCorrespondenceRecipient,
  matchedManagedLeadDenial,
  matchedDelegateResult,
  parseDelegateResult,
  ordinaryLeadDeliveryReady,
} from "./peer-federation-result.mjs";

let runId = `peer474-${randomUUID()}`;
let root = join(tmpdir(), runId);
let manifestPath = join(root, "resources.json");
const resources = {
  runId,
  startedAt: new Date().toISOString(),
  root,
  network: null,
  volumes: [],
  image: null,
  imageTag: null,
  containers: [],
};
resources.diagnosticsEnabled = process.env.PEER_SMOKE_DIAGNOSTICS === "1";
resources.evidence = {
  semanticRef: undefined,
};
if (process.argv[2] === "--cleanup") {
  const manifest = process.argv[3];
  if (!manifest)
    throw new Error("usage: peer-federation-smoke.mjs --cleanup <manifest>");
  Object.assign(resources, JSON.parse(readFileSync(manifest, "utf8")));
  runId = resources.runId;
  root = resources.root;
  manifestPath = manifest;
}
const save = () =>
  writeFileSync(manifestPath, `${JSON.stringify(resources, null, 2)}\n`, {
    mode: 0o600,
  });
const stage = (name, details = {}) => {
  resources.stages ??= [];
  resources.stages.push({ at: new Date().toISOString(), name, ...details });
  save();
  console.log(`[peer-smoke-stage] ${JSON.stringify(resources.stages.at(-1))}`);
};

function command(bin, args, { allowFailure = false, input } = {}) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    input,
    stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
  });
  if (result.error || (!allowFailure && result.status !== 0))
    throw new Error(
      `${bin} ${args.join(" ")} failed: ${result.error ?? result.stderr}`,
    );
  return result.stdout.trim();
}

function sanitizeStartupDiagnostics(value) {
  const sanitized = value
    .replace(/(?:Bearer\s+)[^\s"']+/giu, "Bearer [redacted]")
    .replace(
      /((?:token|password|secret|credential|private[_ -]?key)\s*[:=]\s*)[^\s,"']+/giu,
      "$1[redacted]",
    )
    .replace(/(?:\/[\w.@+-]+){2,}/gu, "[path]");
  return Buffer.from(sanitized).subarray(0, 2048).toString("utf8");
}

function cleanup() {
  const inspectResource = (kind, id) => {
    const inspect = (args) => {
      const result = spawnSync("docker", args, { encoding: "utf8" });
      if (result.error)
        throw new Error(`unable to inspect smoke fixture ${kind}`);
      if (result.status !== 0) {
        if (isMissingDockerResource(kind, id, result.stderr)) return undefined;
        throw new Error(`unable to inspect smoke fixture ${kind}`);
      }
      return result.stdout.trim();
    };
    let args;
    if (kind === "container")
      args = ["inspect", "--format", "{{json .Config.Labels}}", id];
    else if (kind === "network")
      args = ["network", "inspect", "--format", "{{json .Labels}}", id];
    else if (kind === "volume")
      args = ["volume", "inspect", "--format", "{{json .Labels}}", id];
    else args = ["image", "inspect", "--format", "{{.Id}}", id];
    const first = inspect(args);
    if (first === undefined) return undefined;
    if (kind === "image") {
      const labels = inspect([
        "image",
        "inspect",
        "--format",
        "{{json .Config.Labels}}",
        id,
      ]);
      return labels === undefined
        ? undefined
        : { id: first, labels: JSON.parse(labels || "null") };
    }
    return { labels: JSON.parse(first || "null") };
  };
  const removeResource = (kind, id) => {
    const args =
      kind === "container"
        ? ["rm", "-f", id]
        : kind === "image"
          ? ["image", "rm", id]
          : [kind, "rm", id];
    command("docker", args, { allowFailure: true });
  };
  cleanupSmokeFixture(resources, manifestPath, {
    canonicalize: realpathSync,
    fixtureBase: tmpdir(),
    inspectResource,
    removeResource,
    removeRoot: (path) => rmSync(path, { recursive: true, force: true }),
  });
  console.log(
    `Verified fixture cleanup: ${JSON.stringify({ runId: resources.runId, containers: resources.containers, volumes: resources.volumes, network: resources.network, image: resources.imageTag })}`,
  );
}

if (process.argv[2] !== "--cleanup") {
  mkdirSync(root, { mode: 0o700 });
  save();
  const importerEntry = join(root, "peer-result-import-entry.mjs");
  const importerBundle = join(root, "peer-result-import.mjs");
  writeFileSync(
    importerEntry,
    `import { readFileSync, writeFileSync } from "node:fs";\nimport { join } from "node:path";\nimport { importResultBindings } from ${JSON.stringify(`${process.cwd()}/extension/agent-controller.ts`)};\nexport default function(pi) { pi.registerCommand("peer-import-result", { description: "Import test-owned evidence through Herdman's result importer", handler(_args, ctx) { const dir = process.env.PI_CODING_AGENT_DIR; writeFileSync(join(dir, "peer-result-import.started"), "started"); try { const binding = JSON.parse(readFileSync(join(dir, "peer-result-binding.json"), "utf8")); importResultBindings(pi, ctx, [binding], "peer.fixture"); const found = ctx.sessionManager.getBranch().some((entry) => entry.type === "custom" && entry.customType === "pi-herdsman-result-ref" && entry.data?.ref === binding.ref && entry.data?.canonicalRef === binding.canonicalRef); if (!found) throw new Error("fixture result binding was not imported"); writeFileSync(join(dir, "peer-result-import.done"), JSON.stringify(binding)); } catch (error) { writeFileSync(join(dir, "peer-result-import.error"), String(error)); throw error; } } }); }\n`,
    { mode: 0o600 },
  );
  const { build } = await import("esbuild");
  await build({
    entryPoints: [importerEntry],
    outfile: importerBundle,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"],
  });
}

try {
  if (process.argv[2] === "--cleanup") {
    cleanup();
    console.log(`Removed and verified exact resources for ${resources.runId}`);
    process.exit(0);
  }
  const imageTag = `${runId}:fixture`;
  resources.imageTag = imageTag;
  save();
  command("docker", [
    "build",
    "--label",
    `pi-herdsman.run=${runId}`,
    "--tag",
    imageTag,
    ".",
  ]);
  resources.image = command("docker", [
    "image",
    "inspect",
    "--format",
    "{{.Id}}",
    imageTag,
  ]);
  save();
  resources.network = command("docker", [
    "network",
    "create",
    "--internal",
    "--label",
    `pi-herdsman.run=${runId}`,
    runId,
  ]);
  save();

  // Create the test client identities before containers start so sshd receives
  // only the opposite fixture key at first boot.
  for (const side of ["a", "b"]) {
    const dir = join(root, side);
    mkdirSync(dir, { mode: 0o700 });
    command("ssh-keygen", [
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      join(dir, "id_ed25519"),
    ]);
    chmodSync(join(dir, "id_ed25519"), 0o600);
    resources[side] = {
      hostHome: dir,
      agentDir: join(dir, "agent"),
      workspace: join(dir, "workspace"),
      herdrConfigPath: join(dir, "herdr", "config.toml"),
    };
    mkdirSync(resources[side].agentDir, { recursive: true, mode: 0o700 });
    mkdirSync(resources[side].workspace, { mode: 0o700 });
    mkdirSync(join(dir, "herdr"), { mode: 0o700 });
    writeFileSync(join(dir, "known_hosts"), "", { mode: 0o600 });
    save();
  }

  for (const side of ["a", "b"]) {
    const home = `ph-${side}-home-${runId}`;
    const ssh = `ph-${side}-ssh-${runId}`;
    command("docker", [
      "volume",
      "create",
      "--label",
      `pi-herdsman.run=${runId}`,
      home,
    ]);
    resources.volumes.push(home);
    save();
    command("docker", [
      "volume",
      "create",
      "--label",
      `pi-herdsman.run=${runId}`,
      ssh,
    ]);
    resources.volumes.push(ssh);
    save();
    const opposite = side === "a" ? "b" : "a";
    const authorizedKey = readFileSync(
      join(root, opposite, "id_ed25519.pub"),
      "utf8",
    ).trim();
    const id = command("docker", [
      "run",
      "--detach",
      "--init",
      "--network",
      resources.network,
      "--label",
      `pi-herdsman.run=${runId}`,
      "--label",
      `pi-herdsman.side=${side}`,
      "--network-alias",
      `peer-${side}`,
      "--volume",
      `${home}:/home/herdsman`,
      "--volume",
      `${ssh}:/var/lib/herdsman/ssh`,
      "--env",
      `SSH_AUTHORIZED_KEYS=${authorizedKey}`,
      ...(resources.diagnosticsEnabled
        ? ["--env", "PEER_FEDERATION_DIAGNOSTICS=1"]
        : []),
      imageTag,
    ]);
    resources.containers.push(id);
    save();
    Object.assign(resources[side], {
      home,
      ssh,
      container: id,
      dataRoot: join(resources[side].agentDir, "pi-herdsman"),
    });
    save();
  }

  // Place fixture-only SSH clients in each owned container and pin the opposite
  // container's host key (never accept new keys during subsequent SSH use).
  for (const side of ["a", "b"]) {
    const id = resources[side].container;
    const dir = resources[side].hostHome;
    command("docker", ["cp", join(dir, "id_ed25519"), `${id}:/tmp/peer_id`]);
    command("docker", [
      "exec",
      id,
      "sh",
      "-c",
      "install -d -m 0700 /home/herdsman/.ssh && install -m 0600 /tmp/peer_id /home/herdsman/.ssh/id_ed25519 && chown herdsman:herdsman /home/herdsman/.ssh/id_ed25519",
    ]);
    const other = side === "a" ? "b" : "a";
    let key = "";
    for (
      let attempt = 0;
      attempt < 20 && !key.includes("ssh-ed25519");
      attempt++
    ) {
      const scan = spawnSync(
        "docker",
        [
          "exec",
          id,
          "ssh-keyscan",
          "-T",
          "2",
          "-t",
          "ed25519",
          `peer-${other}`,
        ],
        { encoding: "utf8" },
      );
      key = scan.stdout.trim();
      if (!key.includes("ssh-ed25519"))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (!key.includes("ssh-ed25519"))
      throw new Error(`could not pin ${other} host key`);
    writeFileSync(join(dir, "known_hosts"), key, { mode: 0o600 });
    command("docker", [
      "cp",
      join(dir, "known_hosts"),
      `${id}:/tmp/known_hosts`,
    ]);
    command("docker", [
      "exec",
      id,
      "sh",
      "-c",
      "install -m 0600 /tmp/known_hosts /home/herdsman/.ssh/known_hosts && chown herdsman:herdsman /home/herdsman/.ssh/known_hosts",
    ]);
    save();
  }

  for (const side of ["a", "b"]) {
    const other = side === "a" ? "b" : "a";
    const id = resources[side].container;
    const result = command("docker", [
      "exec",
      id,
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UserKnownHostsFile=/home/herdsman/.ssh/known_hosts",
      "-i",
      "/home/herdsman/.ssh/id_ed25519",
      `herdsman@peer-${other}`,
      "pi-herdsman-peer",
      "probe",
    ]);
    resources[side].sshProbe = JSON.parse(result);
    save();
  }

  // Prepare isolated Pi/Herdr roots inside each owned container. Keep Herdr's
  // server and workspace data test-local rather than using its default config.
  const exec = (side, args, extra = []) =>
    command("docker", ["exec", ...extra, resources[side].container, ...args]);
  const fixturePath = (side) => `/tmp/p${runId.slice(-8)}${side}`;
  const herdrEnv = (side) => [
    "-e",
    `HOME=${fixturePath(side)}`,
    "-e",
    `HERDR_CONFIG_PATH=${fixturePath(side)}/herdr.toml`,
    "-e",
    `PI_CODING_AGENT_DIR=${fixturePath(side)}/.pi/agent`,
    "-e",
    `PI_CODING_AGENT_SESSION_DIR=${fixturePath(side)}/sessions`,
    "-e",
    `XDG_CONFIG_HOME=${fixturePath(side)}/xdg-config`,
    "-e",
    `XDG_STATE_HOME=${fixturePath(side)}/xdg-state`,
    "-e",
    `PATH=${fixturePath(side)}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  ];
  const readContainerText = (side, path) => {
    const result = spawnSync(
      "docker",
      [
        "exec",
        "--user",
        "herdsman",
        ...herdrEnv(side),
        resources[side].container,
        "cat",
        path,
      ],
      { encoding: "utf8" },
    );
    return result.status === 0 ? result.stdout : undefined;
  };
  const readContainerJsonLines = (side, path) =>
    (readContainerText(side, path) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { malformed: line.slice(0, 200) };
        }
      });
  const readOrdinaryLeadSession = (side, kind, id, ref) => {
    const script = `
      const fs = require("node:fs");
      const path = process.argv[1], kind = process.argv[2], id = process.argv[3], ref = process.argv[4];
      const text = fs.readFileSync(path, "utf8");
      const lines = text.split("\\n");
      let matchingDeliveryCount = 0, matchingReplyCount = 0, inboundLeadRequestCount = 0, modelTurnsAfterInbound = 0, modelTurnsBeforeBinding = 0, modelTurnsAfterBinding = 0, artifactReadCount = 0, replyCallCount = 0, successfulReplyCount = 0, delivered, importedResultBinding;
      let hasLeadReplyRef = false, hasLeadReply = false, hasPortableContent = false;
      const replyCalls = new Map(), replyResults = [];
      let inSendTurn = false, receipt = null, listPeersCalls = 0, inboundSeen = false, bindingSeen = false;
      for (const line of lines) {
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.message?.role === "user") {
          inSendTurn = entry.message.content?.some?.(part => part.type === "text" && part.text?.startsWith("PEER_E2E_A_LEAD_SEND ")) ?? false;
          if (inSendTurn) receipt = null;
        }
        const details = entry.message?.details ?? entry.details;
        if (inSendTurn && details?.queued === true && typeof details.id === "string")
          receipt = { id: details.id, fromSessionId: details.fromSessionId, remoteSessionId: details.remoteSessionId };
        const hasListPeers = Array.isArray(entry.message?.content) && entry.message.content.some(part => part.type === "toolCall" && part.name === "list_peers");
        if (hasListPeers) listPeersCalls++;
        if (kind === "recipient" && entry.message?.role === "assistant") {
          if (inboundSeen) {
            modelTurnsAfterInbound++;
            if (bindingSeen) modelTurnsAfterBinding++;
            else modelTurnsBeforeBinding++;
          }
          for (const part of entry.message.content ?? []) {
            if (part.type === "toolCall" && part.name === "read") artifactReadCount++;
            if (part.type === "toolCall" && part.name === "message_peer") replyCallCount++;
            if (part.type === "toolCall" && part.name === "message_peer" && typeof part.id === "string") replyCalls.set(part.id, JSON.stringify(part.arguments ?? {}));
          }
        }
        if (kind === "recipient" && entry.message?.role === "toolResult" && entry.message.toolName === "message_peer") {
          replyResults.push(entry);
        }
        if (kind === "recipient" && entry.type === "custom_message" && entry.customType === "pi-herdsman-peer_message" && entry.details?.id === id) {
          matchingDeliveryCount++;
          delivered ??= entry;
        }
        if (kind === "recipient" && entry.type === "custom_message" && entry.customType === "pi-herdsman-peer_message" && entry.content?.includes("PEER_E2E_LEAD_REQUEST")) {
          inboundLeadRequestCount++;
          inboundSeen = true;
        }
        if (kind === "recipient" && entry.type === "custom" && entry.customType === "pi-herdsman-result-ref" && entry.data?.ref === ref && entry.data?.canonicalRef)
          importedResultBinding ??= entry, bindingSeen = true;
        if (kind === "reply" && entry.type === "custom_message" && entry.customType === "pi-herdsman-peer_message" && entry.details?.id === id && entry.content?.includes("PEER_E2E_LEAD_REPLY")) {
          matchingReplyCount++;
          delivered ??= entry;
        }
      }
      for (const result of replyResults) {
        const call = replyCalls.get(result.message.toolCallId);
        if (call && result.message.isError !== true) {
          successfulReplyCount++;
          const evidence = call + JSON.stringify(result.message.content ?? []);
          hasLeadReplyRef ||= evidence.includes(ref);
          hasLeadReply ||= evidence.includes("PEER_E2E_LEAD_REPLY");
          hasPortableContent ||= evidence.includes("PEER_E2E_PORTABLE_RESULT_CONTENT_V1");
        }
      }
      const tail = Buffer.from(text).subarray(-2048).toString("utf8");
      const recentTools = [];
      for (const line of tail.split("\\n")) {
        try {
          const entry = JSON.parse(line);
          for (const part of entry.message?.content ?? []) if (part.type === "toolCall" && typeof part.name === "string") recentTools.push({ id: part.id, name: part.name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40), outcome: "called" });
          if (entry.message?.role === "toolResult") {
            const call = recentTools.findLast(item => item.id === entry.message.toolCallId);
            if (call) {
              call.outcome = entry.message.isError ? "error" : "result";
              if (call.name === "message_peer" && entry.message.isError) {
                const errorText = (entry.message.content ?? []).filter(part => part.type === "text").map(part => part.text).join(" ");
                call.errorCategory = errorText.includes("not available on the current branch") ? "missing-result-binding" : errorText.includes("same-role peer") ? "peer-authorization" : "other";
              }
            }
          }
        } catch {}
      }
      const safeTools = recentTools.slice(-12).map(({ id, name, outcome, errorCategory }) => ({ name, outcome, ...(name === "message_peer" ? { toolCallId: typeof id === "string" ? id.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) : undefined } : {}), ...(errorCategory ? { errorCategory } : {}) }));
      process.stdout.write(JSON.stringify({ receipt, delivered, matchingDeliveryCount, matchingReplyCount, inboundLeadRequestCount, modelTurnsAfterInbound, modelTurnsBeforeBinding, modelTurnsAfterBinding, artifactReadCount, replyCallCount, successfulReplyCount, bindingPresent: !!importedResultBinding, importedResultBinding, hasLeadReplyRef, hasLeadReply, hasPortableContent, listPeersCalls, diagnostics: { sessionBytes: Buffer.byteLength(text), exactReceiptExists: !!receipt, recentTools: safeTools } }));
    `;
    const output = exec(side, [
      "node",
      "-e",
      script,
      resources[side].ordinaryLead.sessionPath,
      kind,
      id ?? "",
      ref ?? "",
    ]);
    return JSON.parse(output);
  };
  const readBDecisionDiagnostics = () => {
    const path = `${resources.b.runtime.piAgentDir}/peer-federation-decisions.jsonl`;
    const output = exec("b", [
      "sh",
      "-c",
      `test -f '${path}' && tail -c 8192 '${path}' || true`,
    ]);
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line);
          if (
            value.eventId === "peer-fixture-event" &&
            ((value.event === "inbound_persisted" &&
              value.outcome === "persisted") ||
              (value.event === "send_invoked" &&
                ["followUp", "busy"].includes(value.outcome) &&
                typeof value.triggerTurn === "boolean" &&
                typeof value.idle === "boolean"))
          )
            return [
              {
                eventId: value.eventId,
                event: value.event,
                outcome: value.outcome,
                ...(value.event === "send_invoked"
                  ? { triggerTurn: value.triggerTurn, idle: value.idle }
                  : {}),
              },
            ];
          if (
            typeof value.inboundRequestPresent === "boolean" &&
            typeof value.importedBindingVisible === "boolean" &&
            ["capture_session", "inbound_lead_request", "other"].includes(
              value.branch,
            ) &&
            [
              "assistant_complete",
              "before_agent_start",
              "decision_started",
              "model_invocation",
              "tool_call",
              "waiting_for_binding",
            ].includes(value.outcome) &&
            (value.modelExpected === undefined ||
              typeof value.modelExpected === "boolean") &&
            (value.tool === undefined ||
              ["read", "message_peer"].includes(value.tool))
          )
            return [
              {
                ...(value.eventId === "peer-fixture-event"
                  ? { eventId: value.eventId }
                  : {}),
                inboundRequestPresent: value.inboundRequestPresent,
                importedBindingVisible: value.importedBindingVisible,
                branch: value.branch,
                outcome: value.outcome,
                ...(value.modelExpected === undefined
                  ? {}
                  : { modelExpected: value.modelExpected }),
                ...(value.tool ? { tool: value.tool } : {}),
              },
            ];
        } catch {}
        return [];
      })
      .slice(-16);
  };
  const capturePeerDiagnostics = () => {
    if (!resources.diagnosticsEnabled) return undefined;
    const diagnostics = {
      runId,
      outbox: [],
      sshWrapper: {},
      recipientAcceptanceMarkers: [],
      recipientInbox: [],
      runtimeTrace: {},
    };
    const outboxDirectory = `${resources.a.runtime.piAgentDir}/pi-herdsman/runtime/peers-v2/remote-outbound`;
    const outboxFiles = exec("a", [
      "sh",
      "-c",
      `find ${outboxDirectory} -maxdepth 1 -type f -name '*.json' -print 2>/dev/null || true`,
    ])
      .split("\n")
      .filter(Boolean);
    diagnostics.outbox = outboxFiles.flatMap((path) => {
      try {
        const outbound = JSON.parse(
          exec("a", ["cat", path], ["--user", "herdsman"]),
        );
        const envelope = JSON.parse(outbound.envelope);
        return [
          {
            id: outbound.id,
            digest: outbound.digest,
            machine: outbound.machine,
            recipientSession: outbound.recipientSession,
            originSession: outbound.session,
            record: {
              id: envelope.record?.id,
              kind: envelope.record?.kind,
              fromSessionId: envelope.record?.fromSessionId,
              toSessionId: envelope.record?.toSessionId,
              leaseId: envelope.record?.leaseId,
              textMarkers: [
                ...(envelope.record?.text ?? "").matchAll(/PEER_E2E_[A-Z_]+/gu),
              ].map(([marker]) => marker),
            },
            recipientClaimId: envelope.recipientClaimId,
          },
        ];
      } catch (error) {
        return [{ path, error: String(error) }];
      }
    });
    for (const [side, paths] of Object.entries({
      a: [
        `${fixturePath("a")}/last-status-request.json`,
        `${fixturePath("a")}/last-status-response.json`,
        `${fixturePath("a")}/last-status.stderr`,
        `${fixturePath("a")}/last-accept.json`,
        `${fixturePath("a")}/last-accept.stderr`,
      ],
      b: [],
    })) {
      diagnostics.sshWrapper[side] = Object.fromEntries(
        paths.map((path) => [
          path.split("/").at(-1),
          readContainerText(side, path),
        ]),
      );
    }
    const acceptanceDirectory = `${resources.b.runtime.piAgentDir}/pi-herdsman/runtime/peers-v2/peer-acceptances`;
    const markerPaths = exec("b", [
      "sh",
      "-c",
      `find ${acceptanceDirectory} -maxdepth 1 -type f -name '*.json' -print 2>/dev/null || true`,
    ])
      .split("\n")
      .filter(Boolean);
    diagnostics.recipientAcceptanceMarkers = markerPaths.flatMap((path) => {
      try {
        return [
          {
            path: path.split("/").at(-1),
            ...JSON.parse(exec("b", ["cat", path], ["--user", "herdsman"])),
          },
        ];
      } catch {
        return [];
      }
    });
    const inboxDirectory = `${resources.b.runtime.piAgentDir}/pi-herdsman/runtime/peers-v2/inbox`;
    const inboxPaths = exec("b", [
      "sh",
      "-c",
      `find ${inboxDirectory} -maxdepth 1 -type f -name '*.json' -print 2>/dev/null || true`,
    ])
      .split("\n")
      .filter(Boolean);
    diagnostics.recipientInbox = inboxPaths.flatMap((path) => {
      try {
        const record = JSON.parse(
          exec("b", ["cat", path], ["--user", "herdsman"]),
        );
        return [
          {
            path: path.split("/").at(-1),
            id: record.id,
            from: record.fromSessionId,
            to: record.toSessionId,
            kind: record.kind,
          },
        ];
      } catch {
        return [];
      }
    });
    for (const side of ["a", "b"]) {
      diagnostics.runtimeTrace[side] = readContainerJsonLines(
        side,
        `${resources[side].runtime.piAgentDir}/pi-herdsman/runtime/peer-federation-diagnostics.jsonl`,
      );
    }
    resources.peerDiagnostics = diagnostics;
    save();
    return diagnostics;
  };
  for (const side of ["a", "b"]) {
    const container = resources[side].container;
    const base = fixturePath(side);
    exec(side, [
      "sh",
      "-c",
      `mkdir -p ${base}/.pi/agent/extensions ${base}/.pi/agent/agents ${base}/.pi/agent/pi-herdsman/runtime ${base}/sessions ${base}/workspace ${base}/xdg-config ${base}/xdg-state ${base}/.ssh && cp -a /home/herdsman/.ssh/. ${base}/.ssh/ && chown -R herdsman:herdsman ${base} && chmod 0700 ${base}/.ssh && usermod -d ${base} herdsman && printf '[experimental]\\nallow_nested = true\\n' > ${base}/herdr.toml`,
    ]);
    const sshWrapper = join(root, `ssh-${side}`);
    writeFileSync(
      sshWrapper,
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *'pi-herdsman-peer accept'*) umask 077; cat > ${base}/last-accept.json; test -f ${base}/first-accept.json || cp ${base}/last-accept.json ${base}/first-accept.json; node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(r.record?.id ?? r.id ?? "")' ${base}/last-accept.json >> ${base}/accept-attempts; test ! -f ${base}/block-accept || exit 255; if test -f ${base}/drop-accept-ack; then rm ${base}/drop-accept-ack; /usr/bin/ssh "$@" < ${base}/last-accept.json >/dev/null 2> ${base}/last-accept.stderr; exit $?; fi; exec /usr/bin/ssh "$@" < ${base}/last-accept.json 2> ${base}/last-accept.stderr ;;`,
        `  *'pi-herdsman-peer status'*) umask 077; cat > ${base}/last-status-request.json; /usr/bin/ssh "$@" < ${base}/last-status-request.json > ${base}/last-status-response.json 2> ${base}/last-status.stderr; rc=$?; if test -s ${base}/last-status-request.json; then node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(r.id)' ${base}/last-status-request.json >> ${base}/status-attempts; fi; if test -s ${base}/last-status-response.json; then node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); console.log(JSON.stringify({id:r.id,status:r.status}))' ${base}/last-status-response.json >> ${base}/status-responses; fi; cat ${base}/last-status-response.json; exit $rc ;;`,
        `  *'pi-herdsman-peer recover-recipient'*) umask 077; cat > ${base}/last-recipient-recovery.json; exec /usr/bin/ssh "$@" < ${base}/last-recipient-recovery.json ;;`,
        `  *'pi-herdsman-peer poll'*) test ! -f ${base}/block-poll || { cat > /dev/null; exit 255; }; exec /usr/bin/ssh "$@" ;;`,
        '  *) exec /usr/bin/ssh "$@" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    command("docker", ["exec", container, "mkdir", "-p", `${base}/.local/bin`]);
    command("docker", [
      "cp",
      sshWrapper,
      `${container}:${base}/.local/bin/ssh`,
    ]);
    exec(side, ["chown", "herdsman:herdsman", `${base}/.local/bin/ssh`]);
    command("docker", [
      "cp",
      "scripts/smoke-faux.mjs",
      `${container}:${base}/.pi/agent/extensions/smoke-faux.mjs`,
    ]);
    exec(
      side,
      ["pi", "install", "/opt/pi-herdsman"],
      ["--user", "herdsman", ...herdrEnv(side)],
    );
    exec(
      side,
      ["herdr", "integration", "install", "pi"],
      ["--user", "herdsman", ...herdrEnv(side)],
    );
    resources[side].runtime = {
      home: base,
      herdrConfig: `${base}/herdr.toml`,
      piAgentDir: `${base}/.pi/agent`,
      sessionDir: `${base}/sessions`,
      workspace: `${base}/workspace`,
    };
    const importerPath = `${resources[side].runtime.piAgentDir}/extensions/peer-result-import.mjs`;
    command("docker", [
      "cp",
      join(root, "peer-result-import.mjs"),
      `${container}:${importerPath}`,
    ]);
    exec(side, ["chown", "herdsman:herdsman", importerPath]);
    command("docker", [
      "cp",
      "extension/storage.ts",
      `${container}:${fixturePath(side)}/storage.ts`,
    ]);
    save();
  }

  for (const side of ["a", "b"]) {
    const session = `p${runId.slice(-8)}${side}`;
    resources[side].herdrSession = session;
    save();
    command("docker", [
      "exec",
      "--detach",
      "--user",
      "herdsman",
      ...herdrEnv(side),
      resources[side].container,
      "herdr",
      "--session",
      session,
      "server",
    ]);
    let server;
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = spawnSync(
        "docker",
        [
          "exec",
          "--user",
          "herdsman",
          ...herdrEnv(side),
          resources[side].container,
          "herdr",
          "--session",
          session,
          "status",
          "--json",
        ],
        { encoding: "utf8" },
      );
      if (result.status === 0) {
        try {
          server = JSON.parse(result.stdout);
          if (server.server?.running) break;
        } catch {}
      }
      server = undefined;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (!server?.server?.running)
      throw new Error(`${side}: isolated Herdr server did not become ready`);
    resources[side].serverStatus = server;
    save();
  }

  const herdr = (side, args) =>
    command("docker", [
      "exec",
      "--user",
      "herdsman",
      ...herdrEnv(side),
      resources[side].container,
      "herdr",
      "--session",
      resources[side].herdrSession,
      ...args,
    ]);
  for (const side of ["a", "b"]) {
    const created = JSON.parse(
      herdr(side, [
        "workspace",
        "create",
        "--cwd",
        resources[side].runtime.workspace,
        "--label",
        `${runId}-${side}`,
        "--focus",
      ]),
    );
    const pane = created.result?.root_pane?.pane_id;
    if (!pane)
      throw new Error(`${side}: workspace create omitted the root pane`);
    resources[side].workspaceId = created.result.workspace.workspace_id;
    resources[side].paneId = pane;
    save();
    exec(
      side,
      ["git", "-C", resources[side].runtime.workspace, "init", "-q"],
      ["--user", "herdsman"],
    );
    if (side === "b") {
      const replyHostPath = join(root, "reply.txt");
      writeFileSync(replyHostPath, `reply evidence for ${runId}\n`, {
        mode: 0o600,
      });
      command("docker", [
        "cp",
        replyHostPath,
        `${resources.b.container}:${resources.b.runtime.workspace}/reply.txt`,
      ]);
      exec("b", [
        "chown",
        "herdsman:herdsman",
        `${resources.b.runtime.workspace}/reply.txt`,
      ]);
    }
    exec(
      side,
      [
        "git",
        "-C",
        resources[side].runtime.workspace,
        "config",
        "user.name",
        "Peer Smoke",
      ],
      ["--user", "herdsman"],
    );
    exec(
      side,
      [
        "git",
        "-C",
        resources[side].runtime.workspace,
        "config",
        "user.email",
        "peer-smoke@example.invalid",
      ],
      ["--user", "herdsman"],
    );
    exec(
      side,
      [
        "git",
        "-C",
        resources[side].runtime.workspace,
        "commit",
        "--allow-empty",
        "-m",
        "peer smoke fixture base",
      ],
      ["--user", "herdsman"],
    );
    herdr(side, [
      "pane",
      "run",
      pane,
      "pi",
      "--model",
      `smoke-faux/federated-peer-${side}`,
      "--extension",
      `${resources[side].runtime.piAgentDir}/extensions/smoke-faux.mjs`,
      "--extension",
      `${resources[side].runtime.piAgentDir}/extensions/peer-result-import.mjs`,
    ]);
    herdr(side, [
      "pane",
      "wait-output",
      pane,
      "--match",
      "Press ctrl+o",
      "--timeout",
      "30000",
    ]);
    herdr(side, ["pane", "send-text", pane, "/manager"]);
    herdr(side, ["pane", "send-keys", pane, "Enter"]);
    try {
      herdr(side, [
        "pane",
        "wait-output",
        pane,
        "--match",
        "Manager mode active.",
        "--timeout",
        "45000",
      ]);
    } catch (error) {
      const diag = spawnSync(
        "docker",
        [
          "exec",
          "--user",
          "herdsman",
          ...herdrEnv(side),
          resources[side].container,
          "herdr",
          "--session",
          resources[side].herdrSession,
          "pane",
          "read",
          pane,
          "--source",
          "recent",
          "--lines",
          "100",
        ],
        { encoding: "utf8" },
      );
      throw new Error(
        `${side}: Manager activation failed; pane=${pane}; output=${diag.stdout}; error=${error.message}`,
      );
    }
    resources[side].managerActivated = true;
    save();
  }

  // Keep the existing Manager pair alive while adding a separate ordinary
  // Lead on each machine. This makes the probe prove role isolation rather
  // than relying on a Manager session being reinterpreted as a Lead.
  const startOrdinaryLead = (side) => {
    const split = JSON.parse(
      herdr(side, [
        "pane",
        "split",
        resources[side].paneId,
        "--direction",
        "down",
        "--ratio",
        "0.5",
        "--cwd",
        resources[side].runtime.workspace,
      ]),
    );
    const pane = split.result?.pane?.pane_id;
    if (!pane)
      throw new Error(
        `${side}: ordinary Lead pane split omitted pane identity`,
      );
    resources[side].ordinaryLeadPaneId = pane;
    herdr(side, [
      "pane",
      "run",
      pane,
      ...(side === "b" && resources.diagnosticsEnabled
        ? ["env", "PEER_FEDERATION_DECISION_DIAGNOSTICS=1"]
        : []),
      "pi",
      "--model",
      `smoke-faux/federated-peer-${side}`,
      "--extension",
      `${resources[side].runtime.piAgentDir}/extensions/smoke-faux.mjs`,
      "--extension",
      `${resources[side].runtime.piAgentDir}/extensions/peer-result-import.mjs`,
    ]);
    herdr(side, [
      "pane",
      "wait-output",
      pane,
      "--match",
      "Press ctrl+o",
      "--timeout",
      "30000",
    ]);
    // New sessions start as ordinary Leads; unlike Managers they need no role
    // activation command.
    const output = herdr(side, [
      "agent",
      "prompt",
      pane,
      "PEER_E2E_B_CAPTURE_SESSION",
      "--wait",
      "--timeout",
      "60000",
    ]);
    const sessionPath = JSON.parse(output).result.agent.agent_session.value;
    const sessionId = sessionPath.match(/_([0-9a-f-]{36})\.jsonl$/u)?.[1];
    if (!sessionId)
      throw new Error(`${side}: ordinary Lead omitted its exact session ID`);
    resources[side].ordinaryLead = { pane, sessionPath, sessionId };
    save();
  };
  startOrdinaryLead("b");

  // Create test-owned ordinary files. Result references are created below by
  // each live Manager's actual local project-delegation/result-import path.
  const specText = `# Federation smoke ${runId}\n\nRead this exact specification and report the supplied canonical artifact digest.\n`;
  const managerSpecText = `# Manager federation smoke ${runId}\n\nPEER_E2E_MANAGER_FILE_CONTENT_V1\n`;
  const escapedText = `${"é".repeat(39_000)}${'"\\\n\u0001'.repeat(3_500)}`;
  const specHostPath = join(root, "spec.md");
  const managerSpecHostPath = join(root, "manager-spec.md");
  const escapedHostPath = join(root, "escaped.txt");
  writeFileSync(specHostPath, specText, { mode: 0o600 });
  writeFileSync(managerSpecHostPath, managerSpecText, { mode: 0o600 });
  writeFileSync(escapedHostPath, escapedText, { mode: 0o600 });
  command("docker", [
    "cp",
    specHostPath,
    `${resources.a.container}:${resources.a.runtime.workspace}/spec.md`,
  ]);
  exec("a", [
    "chown",
    "herdsman:herdsman",
    `${resources.a.runtime.workspace}/spec.md`,
  ]);
  command("docker", [
    "cp",
    managerSpecHostPath,
    `${resources.a.container}:${resources.a.runtime.workspace}/manager-spec.md`,
  ]);
  exec("a", [
    "chown",
    "herdsman:herdsman",
    `${resources.a.runtime.workspace}/manager-spec.md`,
  ]);
  command("docker", [
    "cp",
    escapedHostPath,
    `${resources.a.container}:${resources.a.runtime.workspace}/escaped.txt`,
  ]);
  exec("a", [
    "chown",
    "herdsman:herdsman",
    `${resources.a.runtime.workspace}/escaped.txt`,
  ]);
  command("docker", [
    "cp",
    "extension/storage.ts",
    `${resources.a.container}:${fixturePath("a")}/storage.ts`,
  ]);
  command("docker", [
    "cp",
    "extension/storage.ts",
    `${resources.b.container}:${fixturePath("b")}/storage.ts`,
  ]);
  command("docker", [
    "cp",
    "extension/peer-correspondence.ts",
    `${resources.b.container}:${fixturePath("b")}/peer-correspondence.ts`,
  ]);
  command("docker", [
    "cp",
    "extension/peer-transport.ts",
    `${resources.b.container}:${fixturePath("b")}/peer-transport.ts`,
  ]);
  command("docker", [
    "cp",
    "extension/lock.ts",
    `${resources.b.container}:${fixturePath("b")}/lock.ts`,
  ]);
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  resources.evidence = {
    ...resources.evidence,
    specSha256: digest(specText),
    managerSpecSha256: digest(managerSpecText),
    escapedSha256: digest(escapedText),
    escapedBytes: Buffer.byteLength(escapedText),
  };
  for (const side of ["a", "b"]) {
    const leadProfilePath = join(root, `managed-lead-${side}.md`);
    writeFileSync(
      leadProfilePath,
      `---\nname: managed-lead\nmodel: smoke-faux/federated-peer-lead\ntools: [read]\nextensions: [${JSON.stringify(`${resources[side].runtime.piAgentDir}/extensions/smoke-faux.mjs`)}]\n---\n`,
      { mode: 0o644 },
    );
    command("docker", [
      "cp",
      leadProfilePath,
      `${resources[side].container}:${resources[side].runtime.piAgentDir}/agents/managed-lead.md`,
    ]);
    exec(side, [
      "chown",
      "herdsman:herdsman",
      `${resources[side].runtime.piAgentDir}/agents/managed-lead.md`,
    ]);
    const researcherProfilePath = join(root, `researcher-${side}.md`);
    writeFileSync(
      researcherProfilePath,
      `---\nname: researcher\nmodel: smoke-faux/federated-peer-researcher\nnoExtensions: false\nextensions: [${JSON.stringify(`${resources[side].runtime.piAgentDir}/extensions/smoke-faux.mjs`)}]\ntools: [read]\n---\n`,
      { mode: 0o644 },
    );
    command("docker", [
      "cp",
      researcherProfilePath,
      `${resources[side].container}:${resources[side].runtime.piAgentDir}/agents/researcher.md`,
    ]);
    exec(side, [
      "chown",
      "herdsman:herdsman",
      `${resources[side].runtime.piAgentDir}/agents/researcher.md`,
    ]);
  }
  save();

  const addedMachine = herdr("a", [
    "machine",
    "add",
    "ssh://herdsman@peer-b",
    "--label",
    `${runId}-b`,
    "--remote-session",
    resources.b.herdrSession,
  ]);
  const addedMachineId = addedMachine.match(
    /Saved SSH machine ([a-f0-9]+)/,
  )?.[1];
  if (!addedMachineId)
    throw new Error(
      `Herdr did not report the created isolated machine ID: ${addedMachine}`,
    );
  resources.a.savedPeer = { id: addedMachineId, output: addedMachine };
  startOrdinaryLead("a");
  const managedAssignmentOutput = herdr("b", [
    "agent",
    "prompt",
    resources.b.paneId,
    "PEER_E2E_B_ASSIGN_MANAGED",
    "--wait",
    "--timeout",
    "60000",
  ]);
  const managedManagerSessionPath = JSON.parse(managedAssignmentOutput).result
    .agent.agent_session.value;
  const managedManagerSessionId = managedManagerSessionPath.match(
    /_([0-9a-f-]{36})\.jsonl$/u,
  )?.[1];
  if (!managedManagerSessionId)
    throw new Error(
      "B Manager omitted exact session identity for managed Lead assignment",
    );
  const managedManagerEntries = exec("b", ["cat", managedManagerSessionPath])
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  const { toolCallId, message: managedResult } = matchedDelegateResult(
    managedManagerEntries,
  );
  resources.evidence.managedDelegateResult = delegateResultEvidence(
    toolCallId,
    managedResult,
  );
  save();
  let resultData;
  try {
    resultData = parseDelegateResult(managedResult);
  } catch (error) {
    if (managedResult.isError) throw error;
    throw new Error(
      `Manager delegate_project returned an invalid JSON result: ${error.message}`,
    );
  }
  const assignedLeadSessionId =
    resultData &&
    typeof resultData === "object" &&
    !Array.isArray(resultData) &&
    resultData.ok === true &&
    resultData.action === "delegate" &&
    typeof resultData.session === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      resultData.session,
    )
      ? resultData.session
      : undefined;
  if (!assignedLeadSessionId)
    throw new Error(
      "Manager delegate_project did not return a successful exact assigned Lead session",
    );
  const assignmentsDir = `${resources.b.runtime.piAgentDir}/pi-herdsman/runtime/supervision-v2`;
  const assignmentFiles = exec("b", [
    "find",
    assignmentsDir,
    "-type",
    "f",
    "-path",
    "*/assignments/*/*.json",
  ])
    .trim()
    .split("\n")
    .filter(Boolean);
  const projectAssignment = assignmentFiles
    .map((file) => JSON.parse(exec("b", ["cat", file])))
    .find(
      (assignment) =>
        assignment.branch === "herdsman/peer-smoke-managed" &&
        assignment.piSessionFile?.match(/_([0-9a-f-]{36})\.jsonl$/u)?.[1] ===
          assignedLeadSessionId,
    );
  if (
    !projectAssignment ||
    projectAssignment.piSessionFile?.match(/_([0-9a-f-]{36})\.jsonl$/u)?.[1] !==
      assignedLeadSessionId
  )
    throw new Error(
      `Authoritative ProjectAssignment did not bind the exact assigned Lead session ${assignedLeadSessionId}`,
    );
  resources.b.managedLead = {
    sessionId: assignedLeadSessionId,
    assignmentId: projectAssignment.id,
    managerSessionId: managedManagerSessionId,
  };
  save();
  herdr("a", [
    "agent",
    "prompt",
    resources.a.ordinaryLead.pane,
    `PEER_E2E_A_TEST_MANAGED ${assignedLeadSessionId}`,
    "--wait",
    "--timeout",
    "60000",
  ]);
  const managedDenial = exec("a", ["cat", resources.a.ordinaryLead.sessionPath])
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  const denialResult = matchedManagedLeadDenial(
    managedDenial,
    assignedLeadSessionId,
  );
  stage("assigned-managed-lead-excluded-and-denied", {
    sessionId: assignedLeadSessionId,
    assignmentId: projectAssignment.id,
    denial: denialResult.text,
  });
  const ordinaryLeadSession = resources.a.ordinaryLead.sessionPath;
  const discoveryStartLine = Number(
    exec("a", ["wc", "-l", ordinaryLeadSession]).trim().split(/\s/u)[0],
  );
  herdr("a", [
    "agent",
    "prompt",
    resources.a.ordinaryLead.pane,
    "PEER_E2E_A_DISCOVER",
    "--wait",
    "--timeout",
    "60000",
  ]);
  try {
    herdr("a", [
      "pane",
      "wait-output",
      resources.a.ordinaryLeadPaneId,
      "--match",
      "PEER_E2E_A_DISCOVERED",
      "--timeout",
      "60000",
    ]);
  } catch (error) {
    const entries = exec("a", ["tail", "-n", "200", ordinaryLeadSession])
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    const endLine = Number(
      exec("a", ["wc", "-l", ordinaryLeadSession]).trim().split(/\s/u)[0],
    );
    const firstTailLine = endLine - entries.length + 1;
    const turnStart = Math.max(0, discoveryStartLine + 1 - firstTailLine);
    const turn = entries.slice(turnStart);
    const promptObserved =
      turn[0]?.message?.role === "user" &&
      JSON.stringify(turn[0].message.content).includes("PEER_E2E_A_DISCOVER");
    const toolCalls = new Map();
    const toolResults = new Map();
    const assistantErrors = new Map();
    for (const { message } of turn) {
      if (message?.role === "assistant") {
        const category = message.errorMessage ? "provider_error" : "none";
        assistantErrors.set(category, (assistantErrors.get(category) ?? 0) + 1);
        for (const part of message.content ?? [])
          if (part.type === "toolCall")
            toolCalls.set(part.name, (toolCalls.get(part.name) ?? 0) + 1);
      }
      if (message?.role === "toolResult") {
        const key = `${message.toolName}:${message.isError ? "error" : "ok"}`;
        toolResults.set(key, (toolResults.get(key) ?? 0) + 1);
      }
    }
    const pane = herdr("a", [
      "pane",
      "read",
      resources.a.ordinaryLeadPaneId,
      "--source",
      "recent",
      "--lines",
      "40",
    ]);
    stage("ordinary-lead-discovery-prompt-failed", {
      sessionId: resources.a.ordinaryLead.sessionId,
      paneId: resources.a.ordinaryLeadPaneId,
      promptObserved,
      markerObserved: entries.some((entry) =>
        JSON.stringify(entry.message?.content ?? "").includes(
          "PEER_E2E_A_DISCOVERED",
        ),
      ),
      paneHasError: /\b(?:error|failed|crashed)\b/iu.test(pane),
      paneHasProviderError: /\b(?:provider|model|rate limit|quota)\b/iu.test(
        pane,
      ),
      toolCalls: Object.fromEntries(toolCalls),
      toolResults: Object.fromEntries(toolResults),
      assistantErrors: Object.fromEntries(assistantErrors),
      tailWasCapped: entries.length === 200,
    });
    throw error;
  }
  const ordinaryLeadTranscript = exec("a", [
    "cat",
    resources.a.ordinaryLead.sessionPath,
  ])
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  assertPeerInListPeersResult(
    ordinaryLeadTranscript,
    resources.b.ordinaryLead.sessionId,
  );
  stage("ordinary-lead-discovery-confirmed", {
    senderSession: resources.a.ordinaryLead.sessionId,
    remoteSession: resources.b.ordinaryLead.sessionId,
  });
  stage("saved-machine-added", {
    machineId: addedMachineId,
    output: addedMachine,
  });
  const machineList = herdr("a", ["machine", "list", "--json"]);
  stage("saved-machine-list", { output: machineList });
  if (!machineList.includes(`${runId}-b`))
    throw new Error(
      `isolated B profile missing from exact Herdr config machine list: ${machineList}`,
    );
  const machineStatus = herdr("a", ["machine", "status", "--json"]);
  stage("saved-machine-status", { output: machineStatus });
  if (!machineStatus.includes(`${runId}-b`))
    throw new Error(
      `isolated B profile missing from exact Herdr config machine status: ${machineStatus}`,
    );
  for (const side of ["a", "b"]) {
    const other = side === "a" ? "b" : "a";
    const result = command("docker", [
      "exec",
      "--user",
      "herdsman",
      ...herdrEnv(side),
      resources[side].container,
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${resources[side].runtime.home}/.ssh/known_hosts`,
      "-i",
      `${resources[side].runtime.home}/.ssh/id_ed25519`,
      `herdsman@peer-${other}`,
      "pi-herdsman-peer",
      "probe",
    ]);
    const probe = JSON.parse(result);
    const expectedRoot = `${resources[other].runtime.piAgentDir}/pi-herdsman`;
    const remoteManager = probe.peers.find((peer) => peer.role === "manager");
    const remoteLead = probe.peers.find(
      (peer) =>
        peer.role === "lead" &&
        peer.sessionKind === "ordinary" &&
        peer.piSessionId === resources[other].ordinaryLead.sessionId,
    );
    const managedLeadExposed = probe.peers.some(
      (peer) => peer.piSessionId === resources[other].managedLead?.sessionId,
    );
    if (
      probe.dataRoot !== expectedRoot ||
      !remoteManager ||
      !remoteLead ||
      managedLeadExposed
    )
      throw new Error(
        `${side}->${other}: SSH endpoint did not independently observe the exact live Manager and ordinary Lead at expected root ${expectedRoot}; got ${result}`,
      );
    if (
      probe.peers.some(
        (peer) =>
          peer.piSessionId === resources[other].ordinaryLead.sessionId &&
          peer.role !== "lead",
      )
    )
      throw new Error(
        `${side}->${other}: ordinary Lead was exposed under another role`,
      );
    resources[side].remoteProbe = {
      dataRoot: probe.dataRoot,
      session: remoteManager.piSessionId,
      generation: remoteManager.claim?.id,
      ordinaryLeadSession: remoteLead.piSessionId,
      ordinaryLeadGeneration: remoteLead.claim?.id,
    };
    save();
  }
  const captureManagerSession = (side, prompt) => {
    const output = herdr(side, [
      "agent",
      "prompt",
      resources[side].paneId,
      prompt,
      "--wait",
      "--timeout",
      "60000",
    ]);
    const sessionPath = JSON.parse(output).result.agent.agent_session.value;
    if (typeof sessionPath !== "string" || !sessionPath)
      throw new Error(
        `${side}: Manager prompt omitted its exact Pi session file`,
      );
    return { output, sessionPath };
  };
  resources.b.managerSessionFile = captureManagerSession(
    "b",
    "PEER_E2E_B_CAPTURE_SESSION",
  ).sessionPath;
  const aSession = captureManagerSession("a", "PEER_E2E_A_DISCOVER");
  resources.a.managerSessionFile = aSession.sessionPath;
  resources.a.managerSessionId = aSession.sessionPath.match(
    /_([0-9a-f-]{36})\.jsonl$/u,
  )?.[1];
  if (!resources.a.managerSessionId)
    throw new Error("A Manager session file omitted its exact Pi session ID");
  stage("manager-sessions-captured", {
    a: aSession.sessionPath,
    b: resources.b.managerSessionFile,
  });
  try {
    herdr("a", [
      "pane",
      "wait-output",
      resources.a.paneId,
      "--match",
      "PEER_E2E_A_DISCOVERED",
      "--timeout",
      "60000",
    ]);
  } catch (error) {
    throw new Error(
      `A discovery failed; pane=${herdr("a", ["pane", "read", resources.a.paneId, "--source", "recent", "--lines", "120"])}; session=${exec("a", ["tail", "-n", "80", resources.a.managerSessionFile])}; B=${herdr("b", ["pane", "read", resources.b.paneId, "--source", "recent", "--lines", "80"])}; ${error.message}`,
    );
  }
  stage("pi-list-peers-confirmed", {
    session: resources.a.remoteProbe?.session,
    listedManager: resources.b.remoteProbe?.session,
  });
  const statusRoundTrip = JSON.parse(
    command(
      "docker",
      [
        "exec",
        "-i",
        "--user",
        "herdsman",
        ...herdrEnv("a"),
        resources.a.container,
        "ssh",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "ConnectTimeout=10",
        "herdsman@peer-b",
        "pi-herdsman-peer",
        "status",
      ],
      {
        input: JSON.stringify({
          id: randomUUID(),
          originSession: resources.a.managerSessionId,
          recipientSession: resources.a.remoteProbe.session,
          digest: "0".repeat(64),
          expectedDataRoot: resources.a.remoteProbe.dataRoot,
        }),
      },
    ),
  );
  if (statusRoundTrip.status !== "absent")
    throw new Error(
      `test SSH wrapper did not return the acceptance status response: ${JSON.stringify(statusRoundTrip)}`,
    );
  stage("acceptance-status-stdout-round-trip", {
    status: statusRoundTrip.status,
  });
  const sourceResult = (side) => {
    const split = JSON.parse(
      herdr(side, [
        "pane",
        "split",
        resources[side].paneId,
        "--direction",
        "down",
        "--ratio",
        "0.5",
        "--cwd",
        resources[side].runtime.workspace,
      ]),
    );
    const pane = split.result?.pane?.pane_id;
    if (!pane)
      throw new Error(
        `${side}: source Lead pane split omitted pane identity: ${JSON.stringify(split)}`,
      );
    save();
    try {
      herdr(side, [
        "agent",
        "start",
        `peer-source-${side}`,
        "--kind",
        "pi",
        "--pane",
        pane,
        "--timeout",
        "30000",
        "--",
        "--model",
        "smoke-faux/federated-peer-source",
        "--extension",
        `${resources[side].runtime.piAgentDir}/extensions/smoke-faux.mjs`,
      ]);
    } catch (error) {
      let terminal = "terminal diagnostics unavailable";
      try {
        terminal = herdr(side, [
          "pane",
          "read",
          pane,
          "--source",
          "recent",
          "--lines",
          "30",
        ]);
      } catch {}
      resources.sourceStartupFailure = {
        side,
        terminal: sanitizeStartupDiagnostics(terminal),
      };
      save();
      throw new Error(`${side}: native source Pi startup failed`, {
        cause: error,
      });
    }
    const submitted = JSON.parse(
      herdr(side, [
        "agent",
        "prompt",
        pane,
        `PEER_E2E_SOURCE_RESULT ${side}`,
        "--wait",
        "--timeout",
        "45000",
      ]),
    );
    const sessionFile = submitted.result?.agent?.agent_session?.value;
    if (!sessionFile)
      throw new Error(`${side}: source Lead prompt omitted exact session file`);
    let entries;
    let terminal;
    for (let attempt = 0; attempt < 240; attempt++) {
      entries = exec(side, ["cat", sessionFile])
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      terminal = entries
        .map((entry) => entry.message?.details ?? entry.details)
        .find(
          (details) =>
            details?.agentLabel === "researcher" &&
            details?.status === "completed" &&
            typeof details.resultRef === "string" &&
            Number.isSafeInteger(details.resultIndex),
        );
      if (terminal) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (!terminal || terminal.resultIndex !== 1)
      throw new Error(
        `${side}: source Lead did not retain the exact completed Agent result terminal record in ${sessionFile}; entries=${JSON.stringify(entries.slice(-20))}; pane=${herdr(side, ["pane", "read", pane, "--source", "recent", "--lines", "80"])}`,
      );
    const binding = {
      ref: `result:${terminal.agentLabel}#${terminal.resultIndex}`,
      canonicalRef: terminal.resultRef,
    };
    const artifactText = exec(side, [
      "cat",
      `${resources[side].runtime.piAgentDir}/pi-herdsman/results/${binding.canonicalRef.slice("result:".length)}`,
    ]);
    const artifactSha256 = digest(artifactText);
    stage("source-result-bound", {
      side,
      exactSessionFile: sessionFile,
      binding,
      artifactSha256,
      terminal,
    });
    return {
      pane,
      sessionFile,
      terminal,
      binding,
      semanticRef: binding.ref,
      resultRef: binding.canonicalRef,
      artifactText,
      artifactSha256,
    };
  };

  if (process.env.PEER_SMOKE_PHASE === "delivery") {
    const leadResult = sourceResult("a");
    resources.evidence.leadResultRef = leadResult.semanticRef;
    resources.evidence.leadResultSha256 = leadResult.artifactSha256;
    save();
    const bindingHost = join(root, "peer-result-binding-lead-a.json");
    writeFileSync(bindingHost, `${JSON.stringify(leadResult.binding)}\n`, {
      mode: 0o600,
    });
    command("docker", [
      "cp",
      bindingHost,
      `${resources.a.container}:${resources.a.runtime.piAgentDir}/peer-result-binding.json`,
    ]);
    exec("a", [
      "chown",
      "herdsman:herdsman",
      `${resources.a.runtime.piAgentDir}/peer-result-binding.json`,
    ]);
    herdr("a", [
      "pane",
      "send-text",
      resources.a.ordinaryLead.pane,
      "/peer-import-result",
    ]);
    herdr("a", ["pane", "send-keys", resources.a.ordinaryLead.pane, "Enter"]);
    const leadImportMarker = `${resources.a.runtime.piAgentDir}/peer-result-import.done`;
    let leadImported;
    for (let attempt = 0; attempt < 80; attempt++) {
      const result = spawnSync(
        "docker",
        [
          "exec",
          "--user",
          "herdsman",
          ...herdrEnv("a"),
          resources.a.container,
          "cat",
          leadImportMarker,
        ],
        { encoding: "utf8" },
      );
      if (result.status === 0) {
        leadImported = JSON.parse(result.stdout);
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (
      leadImported?.ref !== leadResult.binding.ref ||
      leadImported?.canonicalRef !== leadResult.binding.canonicalRef
    )
      throw new Error(
        "A ordinary Lead did not import its result binding before sending",
      );
    if (
      readOrdinaryLeadSession("b", "recipient", "", leadResult.binding.ref)
        .importedResultBinding
    )
      throw new Error(
        "B ordinary Lead was pre-seeded with A's result binding before delivery",
      );
    exec("a", [
      "rm",
      "-f",
      `${fixturePath("a")}/status-attempts`,
      `${fixturePath("a")}/status-responses`,
    ]);
    // Drop the first SSH acceptance response after B durably accepts it. A's
    // retry must resolve the same transfer without duplicate delivery.
    exec("a", ["touch", `${resources.a.runtime.home}/drop-accept-ack`]);
    herdr("a", [
      "pane",
      "send-text",
      resources.a.ordinaryLead.pane,
      `PEER_E2E_A_LEAD_SEND ${leadResult.semanticRef}`,
    ]);
    herdr("a", ["pane", "send-keys", resources.a.ordinaryLead.pane, "Enter"]);
    let acceptance;
    for (let attempt = 0; attempt < 120; attempt++) {
      const sendRead = readOrdinaryLeadSession("a", "send");
      acceptance = sendRead.receipt;
      if (acceptance) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (!acceptance) {
      const diagnostics = readOrdinaryLeadSession("a", "send").diagnostics;
      throw new Error(
        `A ordinary Lead's Pi session has no durable remote peer queue receipt; diagnostics=${JSON.stringify(diagnostics)}`,
      );
    }
    resources.acceptanceMessageId = acceptance.id;
    exec("a", [
      "sh",
      "-c",
      `printf '%s' ${acceptance.id} > ${fixturePath("a")}/tracked-outbound-id`,
    ]);
    stage("peer-message-queued", {
      id: acceptance.id,
      from: acceptance.fromSessionId,
      to: acceptance.remoteSessionId,
      bSession: resources.a.remoteProbe.ordinaryLeadSession,
      bGeneration: resources.a.remoteProbe.ordinaryLeadGeneration,
    });
    stage("lead-outbound-retry-released", { id: acceptance.id });
    let inbox = "";
    for (let attempt = 0; attempt < 80; attempt++) {
      const bRead = readOrdinaryLeadSession(
        "b",
        "recipient",
        acceptance.id,
        resources.evidence.leadResultRef,
      );
      inbox = exec(
        "b",
        [
          "sh",
          "-c",
          `find ${resources.b.runtime.piAgentDir}/pi-herdsman/runtime/peers-v2/inbox -type f -name '*.json' -print`,
        ],
        ["--user", "herdsman"],
      );
      if (
        ordinaryLeadDeliveryReady(
          bRead.matchingDeliveryCount === 1 ? [bRead.delivered] : [],
          acceptance.id,
          inbox,
        )
      )
        break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (inbox.trim())
      throw new Error(
        `B observed the single peer message but its inbox record remains: ${inbox}`,
      );
    const bRead = readOrdinaryLeadSession(
      "b",
      "recipient",
      acceptance.id,
      resources.evidence.leadResultRef,
    );
    if (resources.diagnosticsEnabled)
      stage("peer-correlation", { events: readBDecisionDiagnostics() });
    const delivered = bRead.delivered;
    const importedResultBinding = bRead.importedResultBinding;
    const checks = {
      deliveredOnce: bRead.matchingDeliveryCount === 1,
      correctRecipient:
        delivered?.details?.toSessionId ===
        resources.a.remoteProbe.ordinaryLeadSession,
      bindingPresent:
        importedResultBinding?.data?.ref === leadResult.binding.ref &&
        importedResultBinding?.data?.canonicalRef ===
          leadResult.binding.canonicalRef,
      artifactIncluded:
        typeof delivered?.content === "string" &&
        delivered.content.includes(leadResult.artifactText),
      markerPresent: leadResult.artifactText.includes(
        "PEER_E2E_PORTABLE_RESULT_CONTENT_V1",
      ),
      digestMatches:
        digest(leadResult.artifactText) === resources.evidence.leadResultSha256,
    };
    if (Object.values(checks).some((passed) => !passed))
      throw new Error(
        `B's ordinary Lead delivery verification failed: ${JSON.stringify(checks)}`,
      );
    const recipientArtifactPath = `${resources.b.runtime.piAgentDir}/pi-herdsman/results/${leadResult.binding.canonicalRef.slice("result:".length)}`;
    const recipientArtifact = exec("b", ["cat", recipientArtifactPath]);
    const artifactChecks = {
      canonicalArtifactMatches: recipientArtifact === leadResult.artifactText,
      canonicalArtifactDigestMatches:
        digest(recipientArtifact) === leadResult.artifactSha256,
    };
    if (Object.values(artifactChecks).some((passed) => !passed))
      throw new Error(
        `B's canonical result artifact verification failed: ${JSON.stringify(artifactChecks)}`,
      );
    let replyEvidence;
    let replied = false;
    let terminalMarker = false;
    const replyDeadline = Date.now() + 60_000;
    while (Date.now() < replyDeadline) {
      replyEvidence = readOrdinaryLeadSession(
        "b",
        "recipient",
        acceptance.id,
        resources.evidence.leadResultRef,
      );
      if (
        replyEvidence.successfulReplyCount > 0 &&
        replyEvidence.hasLeadReplyRef &&
        replyEvidence.hasLeadReply &&
        replyEvidence.hasPortableContent
      ) {
        replied = true;
        break;
      }
      try {
        herdr("b", [
          "pane",
          "wait-output",
          resources.b.ordinaryLead.pane,
          "--match",
          "PEER_E2E_B_LEAD_REPLIED",
          "--timeout",
          String(Math.max(1, Math.min(250, replyDeadline - Date.now()))),
        ]);
        terminalMarker = true;
      } catch {}
      if (terminalMarker) break;
    }
    if (!replyEvidence)
      replyEvidence = readOrdinaryLeadSession(
        "b",
        "recipient",
        acceptance.id,
        resources.evidence.leadResultRef,
      );
    if (!replied && !terminalMarker) {
      const correspondenceCount = Number(
        exec("b", [
          "sh",
          "-c",
          `find ${resources.b.runtime.piAgentDir}/pi-herdsman/runtime/peer-correspondences -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' '`,
        ]).trim(),
      );
      throw new Error(
        `B Lead reply wait timed out: ${JSON.stringify({ inboundMessages: replyEvidence.inboundLeadRequestCount, modelTurnsAfterInbound: replyEvidence.modelTurnsAfterInbound, modelTurnsBeforeBinding: replyEvidence.modelTurnsBeforeBinding, modelTurnsAfterBinding: replyEvidence.modelTurnsAfterBinding, artifactReads: replyEvidence.artifactReadCount, replyCalls: replyEvidence.replyCallCount, successfulReplies: replyEvidence.successfulReplyCount, bindingPresent: replyEvidence.bindingPresent, correspondences: Number.isFinite(correspondenceCount) ? correspondenceCount : 0, decisions: readBDecisionDiagnostics() })}`,
      );
    }
    if (
      !replyEvidence.hasLeadReplyRef ||
      !replyEvidence.hasLeadReply ||
      !replyEvidence.hasPortableContent
    )
      throw new Error(
        "B ordinary Lead did not use the received result in its correlated message_peer reply",
      );
    let resolvedStatus;
    let leadAcceptAttempts = [];
    let leadStatusAttempts = [];
    let leadStatusResponses = [];
    for (let attempt = 0; attempt < 120; attempt++) {
      const request = exec("a", [
        "sh",
        "-c",
        `test ! -f ${fixturePath("a")}/last-status-request.json || cat ${fixturePath("a")}/last-status-request.json`,
      ]);
      const response = exec("a", [
        "sh",
        "-c",
        `test ! -f ${fixturePath("a")}/last-status-response.json || cat ${fixturePath("a")}/last-status-response.json`,
      ]);
      leadAcceptAttempts = exec("a", [
        "sh",
        "-c",
        `test ! -f ${fixturePath("a")}/accept-attempts || cat ${fixturePath("a")}/accept-attempts`,
      ])
        .trim()
        .split("\n")
        .filter(Boolean);
      leadStatusAttempts = exec("a", [
        "sh",
        "-c",
        `test ! -f ${fixturePath("a")}/status-attempts || cat ${fixturePath("a")}/status-attempts`,
      ])
        .trim()
        .split("\n")
        .filter(Boolean);
      leadStatusResponses = exec("a", [
        "sh",
        "-c",
        `test ! -f ${fixturePath("a")}/status-responses || cat ${fixturePath("a")}/status-responses`,
      ])
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      const parsedRequest = request ? JSON.parse(request) : undefined;
      const parsedResponse = response ? JSON.parse(response) : undefined;
      if (
        parsedRequest?.id === acceptance.id &&
        parsedResponse?.id === acceptance.id &&
        parsedResponse?.status === "accepted" &&
        leadStatusAttempts.includes(acceptance.id) &&
        leadStatusResponses.some(
          (response) =>
            response.id === acceptance.id && response.status === "accepted",
        )
      ) {
        resolvedStatus = parsedResponse;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (
      !resolvedStatus ||
      leadAcceptAttempts.filter((id) => id === acceptance.id).length !== 1 ||
      !leadStatusAttempts.includes(acceptance.id)
    )
      throw new Error(
        `Lead lost-acceptance recovery did not resolve exact message ${acceptance.id} by accepted status without resubmission: status=${JSON.stringify(resolvedStatus)}, attempts=${JSON.stringify(leadAcceptAttempts)}`,
      );
    const outboundPath = `${resources.a.runtime.piAgentDir}/pi-herdsman/runtime/peers-v2/remote-outbound/${acceptance.id}.json`;
    exec("a", ["test", "!", "-f", outboundPath], ["--user", "herdsman"]);
    stage("lead-lost-acceptance-resolved-by-status", {
      id: acceptance.id,
      status: resolvedStatus.status,
      acceptAttempts: 1,
      statusAttempts: leadStatusAttempts.filter((id) => id === acceptance.id)
        .length,
      outboundResolved: true,
    });
    stage("peer-message-accepted-and-delivered", { id: acceptance.id });
    stage("single-peer-message-delivered", {
      id: acceptance.id,
      bSession: resources.a.remoteProbe.ordinaryLeadSession,
      bGeneration: resources.a.remoteProbe.ordinaryLeadGeneration,
      inbox,
    });
    const leadEvidenceDir = `${resources.b.runtime.piAgentDir}/pi-herdsman/runtime/peers-v2/received-evidence`;
    const leadEvidence = exec("b", [
      "sh",
      "-c",
      `find ${leadEvidenceDir} -maxdepth 1 -type f -name '*-spec.md' -print`,
    ]).trim();
    const leadEvidenceSha256 = leadEvidence
      ? exec("b", ["sha256sum", leadEvidence]).split(/\s+/u)[0]
      : undefined;
    if (!leadEvidence || leadEvidenceSha256 !== resources.evidence.specSha256)
      throw new Error(
        `B's ordinary Lead did not receive the exact portable file: ${leadEvidence}`,
      );
    stage("ordinary-lead-file-evidence-verified", {
      path: leadEvidence,
      sha256: resources.evidence.specSha256,
    });
    stage("ordinary-lead-result-reference-used", {
      ref: resources.evidence.leadResultRef,
      canonicalRef: leadResult.binding.canonicalRef,
      artifactSha256: resources.evidence.leadResultSha256,
      artifactContentVerified: true,
      bindingImportedOnRecipient: true,
    });
    const replyFiles = exec("b", [
      "sh",
      "-c",
      `find ${resources.b.runtime.piAgentDir}/pi-herdsman/runtime/peer-correspondences -maxdepth 1 -type f -name '*.json' -print`,
    ])
      .split("\n")
      .filter(Boolean);
    if (replyFiles.length !== 1)
      throw new Error(
        `expected one Lead reply correspondence, got ${replyFiles.length}`,
      );
    const replyCorrespondence = JSON.parse(exec("b", ["cat", replyFiles[0]]));
    if (
      replyCorrespondence.role !== "lead" ||
      replyCorrespondence.replies?.length !== 1
    )
      throw new Error(
        `B did not create a Lead-bound reply: ${JSON.stringify(replyCorrespondence)}`,
      );
    if (resources.b.savedPeer)
      throw new Error("B unexpectedly has a reverse SSH peer route");
    stage("lead-reply-queued-without-reverse-route", {
      correspondenceId: replyCorrespondence.id,
      replyId: replyCorrespondence.replies[0].id,
      reverseRoute: false,
    });
    const listPeersBeforeReply = readOrdinaryLeadSession(
      "a",
      "reply",
    ).listPeersCalls;
    herdr("a", [
      "agent",
      "prompt",
      resources.a.ordinaryLead.pane,
      "PEER_E2E_A_LEAD_WAIT_REPLY",
      "--wait",
      "--timeout",
      "60000",
    ]);
    let aReplyRead;
    let receivedReplies = [];
    let acknowledged;
    for (let attempt = 0; attempt < 120; attempt++) {
      aReplyRead = readOrdinaryLeadSession(
        "a",
        "reply",
        replyCorrespondence.replies[0].id,
      );
      receivedReplies = aReplyRead.matchingReplyCount;
      acknowledged = JSON.parse(exec("b", ["cat", replyFiles[0]]));
      if (receivedReplies === 1 && acknowledged.replies?.[0]?.acknowledged)
        break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    const listPeersAfterReply = aReplyRead.listPeersCalls;
    if (receivedReplies !== 1 || listPeersAfterReply !== listPeersBeforeReply)
      throw new Error(
        `A did not retrieve exactly one Lead correspondence reply unattended: replies=${receivedReplies}, list_peers before=${listPeersBeforeReply}, after=${listPeersAfterReply}`,
      );
    stage("lead-reply-retrieved-and-acked-unattended", {
      correspondenceId: replyCorrespondence.id,
      replyId: replyCorrespondence.replies[0].id,
      aSession: resources.a.ordinaryLead.sessionId,
      deliveredExactlyOnce: receivedReplies === 1,
      modelListPeersCallsAdded: listPeersAfterReply - listPeersBeforeReply,
      acknowledged: acknowledged.replies[0].acknowledged,
      reverseRoute: false,
    });
    if (process.env.PEER_SMOKE_KEEP === "1")
      console.log(`Retained exact resource manifest: ${manifestPath}`);
    else cleanup();
    process.exit(0);
  }
  const importResultIntoManager = (side, source) => {
    const bindingHost = join(root, `peer-result-binding-${side}.json`);
    writeFileSync(bindingHost, `${JSON.stringify(source.binding)}\n`, {
      mode: 0o600,
    });
    command("docker", [
      "cp",
      bindingHost,
      `${resources[side].container}:${resources[side].runtime.piAgentDir}/peer-result-binding.json`,
    ]);
    exec(side, [
      "chown",
      "herdsman:herdsman",
      `${resources[side].runtime.piAgentDir}/peer-result-binding.json`,
    ]);
    herdr(side, [
      "pane",
      "send-text",
      resources[side].paneId,
      "/peer-import-result",
    ]);
    herdr(side, ["pane", "send-keys", resources[side].paneId, "Enter"]);
    const marker = `${resources[side].runtime.piAgentDir}/peer-result-import.done`;
    let imported;
    for (let attempt = 0; attempt < 80; attempt++) {
      const result = spawnSync(
        "docker",
        [
          "exec",
          "--user",
          "herdsman",
          ...herdrEnv(side),
          resources[side].container,
          "cat",
          marker,
        ],
        { encoding: "utf8" },
      );
      if (result.status === 0) {
        imported = JSON.parse(result.stdout);
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (
      !imported ||
      imported.ref !== source.binding.ref ||
      imported.canonicalRef !== source.binding.canonicalRef
    )
      throw new Error(
        `${side}: test-only extension import evidence: started=${spawnSync("docker", ["exec", "--user", "herdsman", ...herdrEnv(side), resources[side].container, "test", "-f", `${resources[side].runtime.piAgentDir}/peer-result-import.started`]).status === 0}, error=${spawnSync("docker", ["exec", "--user", "herdsman", ...herdrEnv(side), resources[side].container, "cat", `${resources[side].runtime.piAgentDir}/peer-result-import.error`], { encoding: "utf8" }).stdout}; pane=${herdr(side, ["pane", "read", resources[side].paneId, "--source", "recent", "--lines", "80"])}`,
      );
    const managerSession = exec(side, [
      "cat",
      resources[side].managerSessionFile,
    ])
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    if (
      !managerSession.some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "pi-herdsman-result-ref" &&
          entry.data?.ref === imported.ref &&
          entry.data?.canonicalRef === imported.canonicalRef,
      )
    )
      throw new Error(
        `${side}: imported binding is not present in the Manager session branch`,
      );
    const managerArtifact = exec(side, [
      "cat",
      `${resources[side].runtime.piAgentDir}/pi-herdsman/results/${imported.canonicalRef.slice("result:".length)}`,
    ]);
    if (
      digest(managerArtifact) !== source.artifactSha256 ||
      managerArtifact !== source.artifactText
    )
      throw new Error(
        `${side}: Manager canonical artifact differs from the source Lead result`,
      );
    return { ...source, imported };
  };
  const bSeed = importResultIntoManager("b", sourceResult("b"));
  resources.evidence.bResultRef = bSeed.resultRef;
  resources.evidence.bResultSha256 = bSeed.artifactSha256;
  const aSeed = importResultIntoManager("a", sourceResult("a"));
  resources.evidence.semanticRef = aSeed.semanticRef;
  resources.evidence.resultRef = aSeed.resultRef;
  resources.evidence.artifactSha256 = aSeed.artifactSha256;
  if (aSeed.semanticRef !== bSeed.semanticRef)
    throw new Error(
      `fixture result alias mismatch: A=${aSeed.semanticRef}, B=${bSeed.semanticRef}`,
    );
  if (
    aSeed.artifactSha256 === bSeed.artifactSha256 ||
    aSeed.artifactText === bSeed.artifactText
  )
    throw new Error(
      "collision fixture source results are not distinct artifacts",
    );
  stage("semantic-collision-sources-proven", {
    semanticRef: aSeed.semanticRef,
    a: {
      binding: aSeed.binding,
      sha256: aSeed.artifactSha256,
      bytes: Buffer.byteLength(aSeed.artifactText),
    },
    b: {
      binding: bSeed.binding,
      sha256: bSeed.artifactSha256,
      bytes: Buffer.byteLength(bSeed.artifactText),
    },
  });
  const resultRef = aSeed.resultRef;
  // Force both outgoing requests into the durable outbox and prevent reply
  // polling until the recipient has restarted under its new generation.
  exec("a", ["touch", `${resources.a.runtime.home}/block-accept`]);
  exec("a", ["touch", `${resources.a.runtime.home}/block-poll`]);
  let submitted;
  try {
    submitted = herdr("a", [
      "agent",
      "prompt",
      resources.a.paneId,
      `PEER_E2E_A_SEND ${resultRef} ${resources.evidence.semanticRef}`,
      "--wait",
      "--timeout",
      "60000",
    ]);
  } catch (error) {
    throw new Error(
      `A send turn did not finish; pane=${herdr("a", ["pane", "read", resources.a.paneId, "--source", "recent", "--lines", "120"])}; ${error.message}`,
    );
  }
  resources.a.requestSubmission = submitted;
  exec("a", ["rm", `${resources.a.runtime.home}/block-accept`]);
  save();
  if (resources.diagnosticsEnabled)
    stage("outbound-retry-observation-start", {
      diagnostics: capturePeerDiagnostics(),
    });

  // B's marker proves the background outbox retry delivered two requests,
  // delegated the evidence locally, and queued progress plus completion.
  try {
    herdr("b", [
      "pane",
      "wait-output",
      resources.b.paneId,
      "--match",
      "PEER_E2E_B_REPLIED",
      "--timeout",
      "60000",
    ]);
  } catch (error) {
    const diagnostics = capturePeerDiagnostics();
    if (diagnostics) stage("B-reply-wait-failed-diagnostics", diagnostics);
    throw new Error(
      `B did not finish the peer request; diagnostics=${JSON.stringify(diagnostics)}; B=${herdr("b", ["pane", "read", resources.b.paneId, "--source", "recent", "--lines", "120"])}; BLogs=${command("docker", ["logs", "--since", resources.startedAt, resources.b.container], { allowFailure: true })}; A=${herdr("a", ["pane", "read", resources.a.paneId, "--source", "recent", "--lines", "120"])}; Aoutbox=${exec("a", ["sh", "-c", `find ${resources.a.runtime.piAgentDir}/pi-herdsman/runtime/peers-v2/remote-outbound -maxdepth 1 -type f -print -exec cat {} \\;`], ["--user", "herdsman"])}; ${error.message}`,
    );
  }
  if (resources.diagnosticsEnabled)
    stage("B-replied-diagnostics", capturePeerDiagnostics());
  const correspondenceFiles = exec("b", [
    "sh",
    "-c",
    `find ${resources.b.runtime.piAgentDir}/pi-herdsman/runtime/peer-correspondences -maxdepth 1 -type f -name '*.json' -print`,
  ])
    .split("\n")
    .filter(Boolean);
  if (correspondenceFiles.length !== 1)
    throw new Error(
      `expected exactly one test correspondence, got ${correspondenceFiles.length}`,
    );
  const correspondence = JSON.parse(exec("b", ["cat", correspondenceFiles[0]]));
  if (
    correspondence.replies.length !== 2 ||
    correspondence.replies.some((reply) => reply.acknowledged)
  )
    throw new Error(
      `B did not retain progress and completion replies: ${JSON.stringify(correspondence)}`,
    );
  const finalReply = correspondence.replies[1];
  if (
    !finalReply.attachments?.some(
      (attachment) => attachment.name === "reply.txt",
    ) ||
    !finalReply.resultBindings?.some(
      (binding) => binding.ref === resources.evidence.semanticRef,
    )
  )
    throw new Error(
      `reply did not preserve ordinary and semantic evidence: ${JSON.stringify(finalReply)}`,
    );
  const duplicateReplyCheck = `import {listPeerCorrespondences,queuePeerReply} from 'file://${fixturePath("b")}/peer-correspondence.ts';\nconst c=listPeerCorrespondences().find(x=>x.id===${JSON.stringify(correspondence.id)});const r=c?.replies.find(reply=>reply.id===${JSON.stringify(finalReply.id)});if(!r||queuePeerReply(c,r.id,r.text,{attachments:r.attachments,resultBindings:r.resultBindings})!=='duplicate')throw Error('evidence-bearing reply retry was not idempotent');let rejected=false;try{queuePeerReply(c,r.id,r.text+' conflict',{attachments:r.attachments,resultBindings:r.resultBindings})}catch(e){rejected=/conflicting peer reply identity/.test(e.message)}if(!rejected)throw Error('conflicting reply identity was accepted');console.log('duplicate-and-conflict-reply-ok');\n`;
  const replyCheck = exec(
    "b",
    [
      "node",
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      duplicateReplyCheck,
    ],
    ["--user", "herdsman", ...herdrEnv("b")],
  );
  if (!replyCheck.includes("duplicate-and-conflict-reply-ok"))
    throw new Error(`reply retry assertion failed: ${replyCheck}`);
  const pollRequest = {
    id: correspondence.id,
    expectedDataRoot: `${resources.b.runtime.piAgentDir}/pi-herdsman`,
    capability: correspondence.capability,
    originSession: correspondence.originSession,
    originGeneration: correspondence.originGeneration,
    recipientSession: correspondence.recipientSession,
    recipientGeneration: correspondence.recipientGeneration,
  };
  const pollArgs = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${resources.a.runtime.home}/.ssh/known_hosts`,
    "-i",
    `${resources.a.runtime.home}/.ssh/id_ed25519`,
    "herdsman@peer-b",
    "pi-herdsman-peer",
    "poll",
  ];
  const firstPoll = JSON.parse(
    command(
      "docker",
      [
        "exec",
        "-i",
        "--user",
        "herdsman",
        ...herdrEnv("a"),
        resources.a.container,
        "/usr/bin/ssh",
        ...pollArgs,
      ],
      { input: JSON.stringify(pollRequest) },
    ),
  );
  const repeatedPoll = JSON.parse(
    command(
      "docker",
      [
        "exec",
        "-i",
        "--user",
        "herdsman",
        ...herdrEnv("a"),
        resources.a.container,
        "/usr/bin/ssh",
        ...pollArgs,
      ],
      { input: JSON.stringify(pollRequest) },
    ),
  );
  if (
    JSON.stringify(firstPoll.replies?.map((reply) => reply.id)) !==
      JSON.stringify(correspondence.replies.map((reply) => reply.id)) ||
    JSON.stringify(repeatedPoll.replies?.map((reply) => reply.id)) !==
      JSON.stringify(correspondence.replies.map((reply) => reply.id))
  )
    throw new Error(
      `repeated reply poll changed/lost the pending reply: ${JSON.stringify({ firstPoll, repeatedPoll })}`,
    );
  for (const tamper of [
    {
      change: { originSession: randomUUID() },
      expectedError: "exact correspondence recipient is not live or authorized",
    },
    {
      change: { originGeneration: randomUUID() },
      expectedError: "peer correspondence authorization failed",
    },
  ]) {
    const liveRecipientProbe = JSON.parse(
      command("docker", [
        "exec",
        "--user",
        "herdsman",
        ...herdrEnv("a"),
        resources.a.container,
        "ssh",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${resources.a.runtime.home}/.ssh/known_hosts`,
        "-i",
        `${resources.a.runtime.home}/.ssh/id_ed25519`,
        "herdsman@peer-b",
        "pi-herdsman-peer",
        "probe",
      ]),
    );
    if (!isLiveCorrespondenceRecipient(liveRecipientProbe, correspondence))
      throw new Error(
        `intended correspondence recipient is not live: ${JSON.stringify({ recipientSession: correspondence.recipientSession, recipientGeneration: correspondence.recipientGeneration, peers: liveRecipientProbe.peers })}`,
      );
    const rejected = spawnSync(
      "docker",
      [
        "exec",
        "-i",
        "--user",
        "herdsman",
        ...herdrEnv("a"),
        resources.a.container,
        "/usr/bin/ssh",
        ...pollArgs,
      ],
      {
        input: JSON.stringify({ ...pollRequest, ...tamper.change }),
        encoding: "utf8",
      },
    );
    if (
      rejected.status === 0 ||
      !`${rejected.stderr}${rejected.stdout}`.includes(tamper.expectedError)
    )
      throw new Error(
        `stale/replaced origin identity did not fail with ${tamper.expectedError}: ${rejected.stderr}${rejected.stdout}`,
      );
  }
  resources.replyId = finalReply.id;
  resources.replyRetryAssertions = {
    duplicateReply: true,
    conflictingReplyRejected: true,
    repeatedPoll: true,
    staleSessionRejected: true,
    staleGenerationRejected: true,
  };
  save();
  const envelopeText = exec("a", [
    "cat",
    `${fixturePath("a")}/first-accept.json`,
  ]);
  const envelope = JSON.parse(envelopeText);
  resources.acceptanceMessageId = envelope.record?.id;
  if (!resources.acceptanceMessageId)
    throw new Error("captured SSH acceptance omitted the message ID");
  const sshArgs = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${resources.a.runtime.home}/.ssh/known_hosts`,
    "-i",
    `${resources.a.runtime.home}/.ssh/id_ed25519`,
    "herdsman@peer-b",
    "pi-herdsman-peer",
    "accept",
  ];
  const duplicate = command(
    "docker",
    [
      "exec",
      "-i",
      "--user",
      "herdsman",
      ...herdrEnv("a"),
      resources.a.container,
      "/usr/bin/ssh",
      ...sshArgs,
    ],
    { input: envelopeText },
  );
  const duplicateResult = JSON.parse(duplicate);
  if (
    !duplicateResult.accepted ||
    duplicateResult.id !== resources.acceptanceMessageId
  )
    throw new Error(
      `duplicate transfer was not idempotently accepted: ${duplicate}`,
    );
  const conflictingEnvelope = {
    ...envelope,
    record: {
      ...envelope.record,
      text: `${envelope.record.text}\nconflicting payload`,
    },
  };
  const conflict = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "--user",
      "herdsman",
      ...herdrEnv("a"),
      resources.a.container,
      "/usr/bin/ssh",
      ...sshArgs,
    ],
    { input: JSON.stringify(conflictingEnvelope), encoding: "utf8" },
  );
  if (
    conflict.status === 0 ||
    !`${conflict.stderr}${conflict.stdout}`.includes(
      "conflicting peer message identity",
    )
  )
    throw new Error(
      `conflicting duplicate transfer was not rejected: ${conflict.stderr}${conflict.stdout}`,
    );
  resources.duplicateAcceptance = {
    sameIdAccepted: duplicateResult.id,
    conflictRejected: true,
  };
  const receivedDir = `${resources.b.runtime.piAgentDir}/pi-herdsman/runtime/peers-v2/received-evidence`;
  const resultArtifact = `${resources.b.runtime.piAgentDir}/pi-herdsman/results/${resultRef.slice("result:".length)}`;
  const digestOutput = exec("b", [
    "sha256sum",
    `${receivedDir}/${resources.evidence.managerSpecSha256}-manager-spec.md`,
    resultArtifact,
  ]);
  const receivedDigests = digestOutput
    .split("\n")
    .map((line) => line.split(/\s+/u)[0]);
  if (
    receivedDigests.length !== 2 ||
    receivedDigests[0] !== resources.evidence.managerSpecSha256 ||
    receivedDigests[1] !== resources.evidence.artifactSha256
  )
    throw new Error(
      `Manager federation evidence digest mismatch: ${digestOutput}`,
    );
  const evidenceSnapshots = exec("b", [
    "sh",
    "-c",
    `find ${resources.b.runtime.piAgentDir}/pi-herdsman/evidence -type f -exec sha256sum '{}' +`,
  ]);
  const snapshotDigests = evidenceSnapshots
    .split("\n")
    .map((line) => line.split(/\s+/u)[0]);
  if (
    !snapshotDigests.includes(resources.evidence.managerSpecSha256) ||
    !snapshotDigests.includes(resources.evidence.artifactSha256)
  )
    throw new Error(
      `B's local assignment snapshots did not preserve both Manager evidence digests: ${evidenceSnapshots}`,
    );
  resources.evidence.receivedManagerSpecSha256 = receivedDigests[0];
  resources.evidence.receivedResultSha256 = receivedDigests[1];
  resources.evidence.assignmentSnapshotDigests = snapshotDigests;
  save();
  const originalSession = resources.a.remoteProbe.session;
  const originalGeneration = resources.a.remoteProbe.generation;
  command("docker", [
    "network",
    "disconnect",
    resources.network,
    resources.a.container,
  ]);
  resources.a.disconnected = true;
  save();
  const paneProcesses = (side) =>
    JSON.parse(
      herdr(side, ["pane", "process-info", "--pane", resources[side].paneId]),
    ).result.process_info.foreground_processes;
  const restartExactManagerSession = (side, sessionFile) => {
    const processes = paneProcesses(side);
    const oldPi = processes.find((process) => process.name === "pi");
    if (!oldPi?.pid)
      throw new Error(`${side}: Manager Pi process missing before restart`);
    exec(side, ["kill", "-TERM", String(oldPi.pid)]);
    let stopped = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      if (!paneProcesses(side).some((process) => process.name === "pi")) {
        stopped = true;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (!stopped) throw new Error(`${side}: Manager Pi did not stop`);
    const resumeArgs = [
      "--model",
      `smoke-faux/federated-peer-${side}`,
      "--extension",
      `${resources[side].runtime.piAgentDir}/extensions/smoke-faux.mjs`,
      "--extension",
      `${resources[side].runtime.piAgentDir}/extensions/peer-result-import.mjs`,
      "--session",
      sessionFile,
    ];
    // Use Herdr's supported startup path from the exact pane shell. --session
    // reopens this persisted Pi session rather than creating a replacement.
    herdr(side, [
      "agent",
      "start",
      `peer-${side}`,
      "--kind",
      "pi",
      "--pane",
      resources[side].paneId,
      "--timeout",
      "30000",
      "--",
      ...resumeArgs,
    ]);
    let resumed = false;
    for (let attempt = 0; attempt < 80; attempt++) {
      if (
        paneProcesses(side).some(
          (process) =>
            process.name === "pi" && process.argv?.includes(sessionFile),
        )
      ) {
        resumed = true;
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (resumed) {
      return;
    }
    const output = herdr(side, [
      "pane",
      "read",
      resources[side].paneId,
      "--source",
      "recent",
      "--lines",
      "80",
    ]);
    throw new Error(
      `${side}: Pi did not resume exact session file ${sessionFile}; pane: ${output}`,
    );
  };
  restartExactManagerSession("a", resources.a.managerSessionFile);
  restartExactManagerSession("b", resources.b.managerSessionFile);
  const bLocalProbe = () =>
    JSON.parse(
      exec(
        "b",
        ["pi-herdsman-peer", "probe"],
        ["--user", "herdsman", ...herdrEnv("b")],
      ),
    );
  const expectedBDataRoot = `${resources.b.runtime.piAgentDir}/pi-herdsman`;
  const readExactBManager = () => {
    const probe = bLocalProbe();
    return {
      probe,
      record: probe.peers.find((peer) => peer.piSessionId === originalSession),
    };
  };
  let authority = readExactBManager();
  // The endpoint returns only currently live peer records, including role,
  // process-lock claim and session identity. Its dataRoot proves lease parity;
  // no terminal presentation string is used as authority evidence.
  if (
    authority.record?.role !== "manager" ||
    authority.probe.dataRoot !== expectedBDataRoot
  ) {
    resources.b.restartAuthorityBeforeActivation = authority;
    const activationCommand = {
      sendText: herdr("b", [
        "pane",
        "send-text",
        resources.b.paneId,
        "/manager",
      ]),
      enter: herdr("b", ["pane", "send-keys", resources.b.paneId, "Enter"]),
    };
    resources.b.managerActivationCommand = activationCommand;
    save();
    for (let attempt = 0; attempt < 180; attempt++) {
      authority = readExactBManager();
      if (
        authority.record?.role === "manager" &&
        authority.probe.dataRoot === expectedBDataRoot
      )
        break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  resources.b.restartAuthority = authority;
  stage("b-restarted-authority-probe", {
    exactSessionFile: resources.b.managerSessionFile,
    expectedSession: originalSession,
    endpointProbe: authority.probe,
    exactPeerRecord: authority.record ?? null,
    activation: resources.b.managerActivationCommand ?? null,
  });
  save();
  if (
    authority.record?.role !== "manager" ||
    authority.probe.dataRoot !== expectedBDataRoot
  )
    throw new Error(
      `B exact resumed session lacks live Manager authority/data-root parity: ${JSON.stringify(authority)}`,
    );
  let recoveredRecipient;
  let bRestartProbe;
  for (let attempt = 0; attempt < 40; attempt++) {
    bRestartProbe = bLocalProbe();
    recoveredRecipient = bRestartProbe.peers.find(
      (peer) => peer.role === "manager" && peer.piSessionId === originalSession,
    );
    if (recoveredRecipient?.claim.id !== originalGeneration) break;
    recoveredRecipient = undefined;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!recoveredRecipient)
    throw new Error(
      `B same-session Manager restart did not publish a new generation: ${JSON.stringify(bRestartProbe)}`,
    );
  resources.b.recoveredSession = recoveredRecipient.piSessionId;
  resources.b.recoveredGeneration = recoveredRecipient.claim.id;
  resources.b.sameSessionRestart = true;
  save();
  command("docker", [
    "network",
    "connect",
    "--alias",
    "peer-a",
    resources.network,
    resources.a.container,
  ]);
  resources.a.disconnected = false;
  resources.a.reconnected = true;
  exec("a", ["rm", `${resources.a.runtime.home}/block-poll`]);
  save();
  let resumedProbe;
  let resumedManager;
  for (let attempt = 0; attempt < 40; attempt++) {
    resumedProbe = JSON.parse(
      command("docker", [
        "exec",
        "--user",
        "herdsman",
        ...herdrEnv("b"),
        resources.b.container,
        "/usr/bin/ssh",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        `UserKnownHostsFile=${resources.b.runtime.home}/.ssh/known_hosts`,
        "-i",
        `${resources.b.runtime.home}/.ssh/id_ed25519`,
        "herdsman@peer-a",
        "pi-herdsman-peer",
        "probe",
      ]),
    );
    resumedManager = resumedProbe.peers.find(
      (peer) =>
        peer.role === "manager" &&
        peer.piSessionId === resources.a.managerSessionId,
    );
    if (
      resumedManager &&
      resumedProbe.dataRoot ===
        `${resources.a.runtime.piAgentDir}/pi-herdsman` &&
      resumedManager.claim.id !== originalGeneration
    )
      break;
    resumedManager = undefined;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!resumedManager)
    throw new Error(
      `same-session Manager recovery did not preserve identity and replace generation: ${JSON.stringify(resumedProbe)}`,
    );
  // Persist one queued transfer addressed to B's old generation while A is
  // offline. The first reconnect loses the acceptance ACK; the next poll must
  // resolve the durable marker instead of resubmitting the transfer.
  const queued = JSON.parse(envelopeText);
  const queuedId = randomUUID();
  queued.record.id = queuedId;
  queued.record.fromSessionId = resources.a.managerSessionId;
  queued.record.leaseId = resumedManager.claim.id;
  queued.record.toSessionId = originalSession;
  queued.record.text = `${queued.record.text}\nPEER_E2E_RESTART_QUEUED_OUTBOUND`;
  queued.record.createdAt = Date.now();
  queued.recipientClaimId = originalGeneration;
  queued.correspondence = {
    id: randomUUID(),
    capability: randomBytes(32).toString("hex"),
    originSession: resources.a.managerSessionId,
    originGeneration: resumedManager.claim.id,
    recipientSession: originalSession,
    recipientGeneration: originalGeneration,
    acceptanceId: queuedId,
    replies: [],
  };
  const canonical = (value) => {
    if (value === null || typeof value !== "object")
      return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  };
  const queuedDigest = digest(
    canonical({ record: queued.record, attachments: queued.attachments }),
  );
  const outbound = {
    id: queuedId,
    machine: {
      id: resources.a.savedPeer.id,
      label: `${runId}-b`,
      target: "ssh://herdsman@peer-b",
      reachable: true,
    },
    dataRoot: expectedBDataRoot,
    session: resources.a.managerSessionId,
    claimId: resumedManager.claim.id,
    recipientSession: originalSession,
    digest: queuedDigest,
    envelope: JSON.stringify(queued),
  };
  const outboxPath = `${resources.a.runtime.piAgentDir}/pi-herdsman/runtime/peers-v2/remote-outbound/${queuedId}.json`;
  const outboxFile = join(root, `${queuedId}.json`);
  writeFileSync(outboxFile, `${JSON.stringify(outbound)}\n`, { mode: 0o600 });
  exec("a", [
    "mkdir",
    "-p",
    join(
      resources.a.runtime.piAgentDir,
      "pi-herdsman/runtime/peers-v2/remote-outbound",
    ),
  ]);
  exec("a", [
    "chown",
    "-R",
    "herdsman:herdsman",
    join(
      resources.a.runtime.piAgentDir,
      "pi-herdsman/runtime/peers-v2/remote-outbound",
    ),
  ]);
  command("docker", [
    "cp",
    outboxFile,
    `${resources.a.container}:${outboxPath}`,
  ]);
  exec("a", ["chown", "herdsman:herdsman", outboxPath]);
  exec("a", ["touch", `${fixturePath("a")}/drop-accept-ack`]);
  exec("a", [
    "sh",
    "-c",
    `printf '%s' ${queuedId} > ${fixturePath("a")}/tracked-outbound-id`,
  ]);
  resources.outboundGenerationRecovery = {
    id: queuedId,
    digest: queuedDigest,
    recipientSession: originalSession,
    oldGeneration: originalGeneration,
    newGeneration: recoveredRecipient.claim.id,
  };
  save();
  const firstRecoveryPrompt = herdr("a", [
    "agent",
    "prompt",
    resources.a.paneId,
    "PEER_E2E_A_OUTBOUND_RECOVERY_FIRST",
    "--wait",
    "--timeout",
    "60000",
  ]);
  const acceptanceKey = digest(`${resources.a.managerSessionId}\0${queuedId}`);
  const markerPath = `${resources.b.runtime.piAgentDir}/pi-herdsman/runtime/peers-v2/peer-acceptances/${acceptanceKey}.json`;
  let markerExists = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    markerExists =
      spawnSync("docker", [
        "exec",
        "--user",
        "herdsman",
        ...herdrEnv("b"),
        resources.b.container,
        "test",
        "-f",
        markerPath,
      ]).status === 0;
    if (markerExists) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  const outboxExists =
    spawnSync("docker", [
      "exec",
      "--user",
      "herdsman",
      ...herdrEnv("a"),
      resources.a.container,
      "test",
      "-f",
      outboxPath,
    ]).status === 0;
  const attemptLog = spawnSync(
    "docker",
    [
      "exec",
      "--user",
      "herdsman",
      ...herdrEnv("a"),
      resources.a.container,
      "cat",
      `${fixturePath("a")}/accept-attempts`,
    ],
    { encoding: "utf8" },
  );
  const statusRequestLog = spawnSync(
    "docker",
    [
      "exec",
      "--user",
      "herdsman",
      ...herdrEnv("a"),
      resources.a.container,
      "cat",
      `${fixturePath("a")}/last-status-request.json`,
    ],
    { encoding: "utf8" },
  );
  const statusResponseLog = spawnSync(
    "docker",
    [
      "exec",
      "--user",
      "herdsman",
      ...herdrEnv("a"),
      resources.a.container,
      "cat",
      `${fixturePath("a")}/last-status-response.json`,
    ],
    { encoding: "utf8" },
  );
  stage("queued-outbound-first-attempt", {
    queuedId,
    markerExists,
    outboxExists,
    attempts: attemptLog.stdout,
    statusRequest: statusRequestLog.stdout,
    statusResponse: statusResponseLog.stdout,
    prompt: firstRecoveryPrompt.slice(-500),
  });
  if (!markerExists)
    throw new Error(
      `queued outbound recovery did not create its acceptance marker (outbox=${outboxExists})`,
    );
  const acceptedMarker = JSON.parse(
    exec("b", ["cat", markerPath], ["--user", "herdsman"]),
  );
  if (
    acceptedMarker.status !== "accepted" ||
    acceptedMarker.digest !== queuedDigest ||
    acceptedMarker.recipientSession !== originalSession
  )
    throw new Error(
      `queued transfer was not durably accepted after recipient generation recovery: ${JSON.stringify(acceptedMarker)}`,
    );
  herdr("a", [
    "agent",
    "prompt",
    resources.a.paneId,
    "PEER_E2E_A_OUTBOUND_RECOVERY_STATUS",
    "--wait",
    "--timeout",
    "60000",
  ]);
  let stillQueued = true;
  for (let attempt = 0; attempt < 240; attempt++) {
    stillQueued =
      spawnSync("docker", [
        "exec",
        "--user",
        "herdsman",
        ...herdrEnv("a"),
        resources.a.container,
        "test",
        "-f",
        outboxPath,
      ]).status === 0;
    if (!stillQueued) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (stillQueued)
    throw new Error(
      "accepted transfer was resubmitted/retained instead of resolved by its durable status",
    );
  const attempts = exec(
    "a",
    ["cat", `${fixturePath("a")}/accept-attempts`],
    ["--user", "herdsman"],
  )
    .trim()
    .split("\n");
  if (attempts.filter((attempt) => attempt === queuedId).length !== 1)
    throw new Error(
      `lost-ACK recovery resubmitted accepted transfer: ${JSON.stringify(attempts)}`,
    );
  resources.outboundGenerationRecovery.lostAckResolved = true;
  stage(
    "queued-outbound-generation-recovered",
    resources.outboundGenerationRecovery,
  );
  save();
  resources.a.recoveredOriginSession = resumedManager.piSessionId;
  resources.a.recoveredOriginGeneration = resumedManager.claim.id;
  resources.a.staleGenerationRejected = true;
  save();
  const replyCompletion = herdr("a", [
    "pane",
    "wait-output",
    resources.a.paneId,
    "--match",
    "PEER_E2E_A_RECEIVED_REPLY",
    "--timeout",
    "240000",
  ]);
  const autoRecovery = JSON.parse(
    exec("a", [
      "cat",
      `${resources.a.runtime.home}/last-recipient-recovery.json`,
    ]),
  );
  if (
    autoRecovery.recipientSession !== originalSession ||
    autoRecovery.newRecipientGeneration !== resources.b.recoveredGeneration
  )
    throw new Error(
      `automatic recipient recovery was not exercised: ${JSON.stringify(autoRecovery)}`,
    );
  const aTranscript = herdr("a", [
    "pane",
    "read",
    resources.a.paneId,
    "--source",
    "recent",
    "--lines",
    "240",
  ]);
  const aReplyEntries = exec("a", ["cat", resources.a.managerSessionFile])
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse)
    .filter((entry) =>
      /PEER_E2E_REPLY|researcher#1|canonical|peer_message/iu.test(
        JSON.stringify(entry),
      ),
    )
    .slice(-20);
  const persistedReply = JSON.stringify(aReplyEntries);
  if (
    (persistedReply.match(/PEER_E2E_REPLY_PROGRESS/gu) ?? []).length !== 1 ||
    (persistedReply.match(/PEER_E2E_REPLY_FINAL/gu) ?? []).length !== 1
  )
    throw new Error(
      `A did not persist each progress/final reply exactly once: ${persistedReply}`,
    );
  const fallbackRef = resources.evidence.bResultRef;
  const sourceArtifactPath = `${resources.a.runtime.piAgentDir}/pi-herdsman/results/${resources.evidence.resultRef.slice("result:".length)}`;
  const fallbackArtifactPath = `${resources.a.runtime.piAgentDir}/pi-herdsman/results/${fallbackRef.slice("result:".length)}`;
  const sourceArtifact = exec("a", ["cat", sourceArtifactPath]);
  const fallbackArtifact = exec("a", ["cat", fallbackArtifactPath]);
  if (
    !persistedReply.includes("Semantic result reference conflict") ||
    !persistedReply.includes(
      `${resources.evidence.semanticRef} → ${fallbackRef}`,
    ) ||
    digest(sourceArtifact) !== resources.evidence.artifactSha256 ||
    digest(fallbackArtifact) !== resources.evidence.bResultSha256 ||
    sourceArtifact === fallbackArtifact
  )
    throw new Error(
      `A did not receive an explicit canonical fallback for the conflicting semantic result: pane=${aTranscript}; persistedUserMessages=${JSON.stringify(aReplyEntries)}`,
    );
  stage("semantic-collision-fallback-proven", {
    semanticRef: resources.evidence.semanticRef,
    fallbackRef,
    originalCanonicalRef: resources.evidence.resultRef,
    sourceArtifactSha256: digest(sourceArtifact),
    fallbackArtifactSha256: digest(fallbackArtifact),
    persistedReply,
  });
  const aForward = herdr("a", [
    "agent",
    "prompt",
    resources.a.paneId,
    "PEER_E2E_A_FORWARD_REPLY",
    "--wait",
    "--timeout",
    "180000",
  ]);
  try {
    herdr("a", [
      "pane",
      "wait-output",
      resources.a.paneId,
      "--match",
      "PEER_E2E_A_REPLY_FORWARDED",
      "--timeout",
      "60000",
    ]);
  } catch (error) {
    throw new Error(
      `A reply evidence forwarding did not complete: pane=${herdr("a", ["pane", "read", resources.a.paneId, "--source", "recent", "--lines", "120"])}; session=${exec("a", ["tail", "-n", "40", resources.a.managerSessionFile])}; ${error.message}`,
    );
  }
  const aSessionEntries = exec("a", ["cat", resources.a.managerSessionFile])
    .split("\n")
    .filter(Boolean)
    .map(JSON.parse);
  const lastMessagePeerCall = aSessionEntries.findLastIndex((entry) =>
    entry.message?.content?.some(
      (part) => part.type === "toolCall" && part.name === "message_peer",
    ),
  );
  const firstReplyReceipt = aSessionEntries.findIndex(
    (entry) =>
      entry.type === "custom_message" &&
      entry.content.includes("PEER_E2E_REPLY_PROGRESS"),
  );
  const modelPolledBeforeReceipt = aSessionEntries.some(
    (entry, index) =>
      index > lastMessagePeerCall &&
      index < firstReplyReceipt &&
      entry.message?.content?.some(
        (part) => part.type === "toolCall" && part.name === "list_peers",
      ),
  );
  const autonomousReceipt = {
    messagePeerAt: aSessionEntries[lastMessagePeerCall]?.timestamp,
    replyReceiptAt: aSessionEntries[firstReplyReceipt]?.timestamp,
    replyIds: aSessionEntries
      .filter(
        (entry) =>
          entry.type === "custom_message" &&
          entry.content.includes("PEER_E2E_REPLY_"),
      )
      .map((entry) => entry.details?.id),
    modelListPeersBeforeReceipt: aSessionEntries.filter(
      (entry, index) =>
        index > lastMessagePeerCall &&
        index < firstReplyReceipt &&
        entry.message?.content?.some(
          (part) => part.type === "toolCall" && part.name === "list_peers",
        ),
    ).length,
  };
  if (
    lastMessagePeerCall < 0 ||
    firstReplyReceipt <= lastMessagePeerCall ||
    modelPolledBeforeReceipt
  )
    throw new Error(
      `reply receipt depended on a model list_peers call (message_peer=${lastMessagePeerCall}, reply receipt=${firstReplyReceipt}, model list_peers before receipt=${modelPolledBeforeReceipt})`,
    );
  stage("autonomous-reply-receipt-proven", autonomousReceipt);
  resources.exchange = {
    requestReplyComplete: true,
    replyCompletionMarker: "PEER_E2E_A_RECEIVED_REPLY",
    replyEvidenceForwarded: true,
    backgroundReconciliation: true,
    autonomousReplyReceipt: autonomousReceipt,
    disconnectedAndReconnected: true,
    aForwardResult: aForward.slice(-300),
  };
  save();

  // A different live Manager session cannot inherit B's persistent route.
  const bPi = paneProcesses("b").find((process) => process.name === "pi");
  if (!bPi?.pid) throw new Error("B replacement test has no live Manager Pi");
  exec("b", ["kill", "-TERM", String(bPi.pid)]);
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!paneProcesses("b").some((process) => process.name === "pi")) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  herdr("b", [
    "agent",
    "start",
    "peer-b-replacement",
    "--kind",
    "pi",
    "--pane",
    resources.b.paneId,
    "--timeout",
    "30000",
    "--",
    "--model",
    "smoke-faux/federated-peer-b",
    "--extension",
    `${resources.b.runtime.piAgentDir}/extensions/smoke-faux.mjs`,
    "--extension",
    `${resources.b.runtime.piAgentDir}/extensions/peer-result-import.mjs`,
  ]);
  herdr("b", ["pane", "send-text", resources.b.paneId, "/manager"]);
  herdr("b", ["pane", "send-keys", resources.b.paneId, "Enter"]);
  let replacementProbe;
  let replacementManager;
  for (let attempt = 0; attempt < 180; attempt++) {
    replacementProbe = bLocalProbe();
    replacementManager = replacementProbe.peers.find(
      (peer) => peer.role === "manager" && peer.piSessionId !== originalSession,
    );
    if (replacementManager) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  if (!replacementManager || replacementManager.piSessionId === originalSession)
    throw new Error(
      `fixture did not create a replacement Pi Manager session: probe=${JSON.stringify(replacementProbe)}; pane=${herdr("b", ["pane", "read", resources.b.paneId, "--source", "recent", "--lines", "80"])}`,
    );
  const updatedCorrespondence = JSON.parse(
    exec("b", ["cat", correspondenceFiles[0]]),
  );
  const recoverArgs = [...pollArgs.slice(0, -1), "recover-recipient"];
  const rejectReplacement = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "--user",
      "herdsman",
      ...herdrEnv("a"),
      resources.a.container,
      "/usr/bin/ssh",
      ...recoverArgs,
    ],
    {
      input: JSON.stringify({
        id: updatedCorrespondence.id,
        expectedDataRoot: `${resources.b.runtime.piAgentDir}/pi-herdsman`,
        capability: updatedCorrespondence.capability,
        originSession: updatedCorrespondence.originSession,
        originGeneration: updatedCorrespondence.originGeneration,
        recipientSession: updatedCorrespondence.recipientSession,
        recipientGeneration: updatedCorrespondence.recipientGeneration,
        newRecipientGeneration: replacementManager.claim.id,
      }),
      encoding: "utf8",
    },
  );
  if (
    rejectReplacement.status === 0 ||
    !`${rejectReplacement.stderr}${rejectReplacement.stdout}`.includes(
      "exact correspondence recipient is not live or authorized",
    )
  )
    throw new Error(
      `replacement Pi Manager stole the reply correspondence: ${rejectReplacement.stderr}${rejectReplacement.stdout}`,
    );
  resources.b.replacementRejected = replacementManager.piSessionId;
  save();

  console.log(
    `Fixture acceptance evidence: ${JSON.stringify({ runId, image: resources.image, network: resources.network, containers: resources.containers, volumes: resources.volumes, messageId: resources.acceptanceMessageId, replyId: resources.replyId, managers: { recipientBeforeRestart: resources.a.remoteProbe, recipientRecoveredSession: resources.b.recoveredSession, recipientRecoveredGeneration: resources.b.recoveredGeneration, originBeforeRestart: resources.b.remoteProbe, originRecoveredSession: resources.a.recoveredOriginSession, originRecoveredGeneration: resources.a.recoveredOriginGeneration }, evidence: resources.evidence, assertions: { duplicateAcceptance: resources.duplicateAcceptance, replyRetries: resources.replyRetryAssertions, sameExactSessionRecovery: resources.b.recoveredSession === resources.a.remoteProbe.session, generationChanged: resources.b.recoveredGeneration !== resources.a.remoteProbe.generation, finalReplyCompletion: resources.exchange.replyCompletionMarker, disconnectedAndReconnected: resources.exchange.disconnectedAndReconnected, replacementRejected: resources.b.replacementRejected !== undefined }, replyCompletion: replyCompletion.slice(-300) })}`,
  );
  if (process.env.PEER_SMOKE_KEEP === "1")
    console.log(`Retained exact resource manifest: ${manifestPath}`);
} finally {
  if (process.argv[2] !== "--cleanup" && process.env.PEER_SMOKE_KEEP !== "1")
    cleanup();
}
