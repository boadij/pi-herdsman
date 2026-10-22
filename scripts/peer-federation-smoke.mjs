#!/usr/bin/env node
// Disposable, explicitly owned Docker fixture for the real peer-federation smoke.
// Run with `node scripts/peer-federation-smoke.mjs`; set PEER_SMOKE_KEEP=1 to
// retain resources for diagnosis (the printed manifest is the cleanup authority).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

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

function cleanup() {
  for (const id of resources.containers)
    command("docker", ["rm", "-f", id], { allowFailure: true });
  for (const id of resources.volumes)
    command("docker", ["volume", "rm", id], { allowFailure: true });
  if (resources.network)
    command("docker", ["network", "rm", resources.network], {
      allowFailure: true,
    });
  if (resources.imageTag)
    command("docker", ["image", "rm", resources.imageTag], {
      allowFailure: true,
    });
  const remains = (args) =>
    spawnSync("docker", args, { stdio: "ignore" }).status === 0;
  const leftovers = [
    ...resources.containers.filter((id) =>
      remains(["container", "inspect", id]),
    ),
    ...resources.volumes.filter((id) => remains(["volume", "inspect", id])),
    ...(resources.network && remains(["network", "inspect", resources.network])
      ? [resources.network]
      : []),
    ...(resources.imageTag && remains(["image", "inspect", resources.imageTag])
      ? [resources.imageTag]
      : []),
  ];
  rmSync(root, { recursive: true, force: true });
  if (leftovers.length)
    throw new Error(
      `fixture cleanup left exact resources: ${leftovers.join(", ")}`,
    );
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
    if (
      !resources.runId?.startsWith("peer474-") ||
      !resources.root ||
      !Array.isArray(resources.containers) ||
      !Array.isArray(resources.volumes)
    )
      throw new Error("refusing malformed/non-fixture resource manifest");
    cleanup();
    console.log(`Removed and verified exact resources for ${resources.runId}`);
    process.exit(0);
  }
  const imageTag = `${runId}:fixture`;
  resources.imageTag = imageTag;
  save();
  command("docker", ["build", "--tag", imageTag, "."]);
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
        `  *'pi-herdsman-peer accept'*) umask 077; cat > ${base}/last-accept.json; test -f ${base}/first-accept.json || cp ${base}/last-accept.json ${base}/first-accept.json; if test -f ${base}/tracked-outbound-id && grep -Fq "$(cat ${base}/tracked-outbound-id)" ${base}/last-accept.json; then echo "$(cat ${base}/tracked-outbound-id)" >> ${base}/accept-attempts; fi; test ! -f ${base}/block-accept || exit 255; if test -f ${base}/drop-accept-ack; then rm ${base}/drop-accept-ack; /usr/bin/ssh "$@" < ${base}/last-accept.json >/dev/null 2> ${base}/last-accept.stderr; exit $?; fi; exec /usr/bin/ssh "$@" < ${base}/last-accept.json 2> ${base}/last-accept.stderr ;;`,
        `  *'pi-herdsman-peer status'*) umask 077; cat > ${base}/last-status-request.json; /usr/bin/ssh "$@" < ${base}/last-status-request.json > ${base}/last-status-response.json 2> ${base}/last-status.stderr; rc=$?; cat ${base}/last-status-response.json; exit $rc ;;`,
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

  // Create test-owned ordinary files. Result references are created below by
  // each live Manager's actual local project-delegation/result-import path.
  const specText = `# Federation smoke ${runId}\n\nRead this exact specification and report the supplied canonical artifact digest.\n`;
  const escapedText = `${"é".repeat(39_000)}${'"\\\n\u0001'.repeat(3_500)}`;
  const specHostPath = join(root, "spec.md");
  const escapedHostPath = join(root, "escaped.txt");
  writeFileSync(specHostPath, specText, { mode: 0o600 });
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
    if (probe.dataRoot !== expectedRoot || !remoteManager)
      throw new Error(
        `${side}->${other}: SSH endpoint did not observe the live Manager at expected root ${expectedRoot}; got ${result}`,
      );
    resources[side].remoteProbe = {
      dataRoot: probe.dataRoot,
      session: remoteManager.piSessionId,
      generation: remoteManager.claim?.id,
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
  if (process.env.PEER_SMOKE_PHASE === "delivery") {
    herdr("a", [
      "agent",
      "prompt",
      resources.a.paneId,
      "PEER_E2E_A_SINGLE_SEND",
      "--wait",
      "--timeout",
      "60000",
    ]);
    const aEntries = exec("a", ["cat", aSession.sessionPath])
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    const acceptance = aEntries
      .map((entry) => entry.message?.details ?? entry.details)
      .find(
        (details) =>
          details?.accepted === true && typeof details.id === "string",
      );
    if (!acceptance)
      throw new Error(
        "A's Pi session has no successful remote peer acceptance receipt",
      );
    resources.acceptanceMessageId = acceptance.id;
    stage("peer-message-accepted", {
      id: acceptance.id,
      from: acceptance.fromSessionId,
      to: acceptance.remoteSessionId,
      bSession: resources.a.remoteProbe.session,
      bGeneration: resources.a.remoteProbe.generation,
    });
    herdr("b", [
      "pane",
      "wait-output",
      resources.b.paneId,
      "--match",
      "PEER_E2E_B_SINGLE_RECEIVED",
      "--timeout",
      "60000",
    ]);
    let inbox = "";
    for (let attempt = 0; attempt < 80; attempt++) {
      inbox = exec(
        "b",
        [
          "sh",
          "-c",
          `find ${resources.b.runtime.piAgentDir}/pi-herdsman/runtime/peers-v2/inbox -type f -name '*.json' -print`,
        ],
        ["--user", "herdsman"],
      );
      if (!inbox.trim()) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    if (inbox.trim())
      throw new Error(
        `B observed the single peer message but its inbox record remains: ${inbox}`,
      );
    const bEntries = exec("b", ["cat", resources.b.managerSessionFile])
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
    const delivered = bEntries.find(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === "pi-herdsman-peer_message" &&
        entry.details?.id === acceptance.id,
    );
    if (
      !delivered ||
      delivered.details?.toSessionId !== resources.a.remoteProbe.session
    )
      throw new Error(
        `B's exact Manager session did not persist accepted record ${acceptance.id}`,
      );
    stage("single-peer-message-delivered", {
      id: acceptance.id,
      bSession: resources.a.remoteProbe.session,
      bGeneration: resources.a.remoteProbe.generation,
      inbox,
    });
    if (process.env.PEER_SMOKE_KEEP === "1")
      console.log(`Retained exact resource manifest: ${manifestPath}`);
    else cleanup();
    process.exit(0);
  }
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
    resources[side].sourcePaneId = pane;
    herdr(side, [
      "pane",
      "run",
      pane,
      "pi",
      "--model",
      "smoke-faux/federated-peer-source",
      "--extension",
      `${resources[side].runtime.piAgentDir}/extensions/smoke-faux.mjs`,
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
    { originSession: randomUUID() },
    { originGeneration: randomUUID() },
  ]) {
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
        input: JSON.stringify({ ...pollRequest, ...tamper }),
        encoding: "utf8",
      },
    );
    if (
      rejected.status === 0 ||
      !`${rejected.stderr}${rejected.stdout}`.includes(
        "peer correspondence authorization failed",
      )
    )
      throw new Error(
        `stale/replaced origin identity was not rejected: ${rejected.stderr}${rejected.stdout}`,
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
    `${receivedDir}/${resources.evidence.specSha256}-spec.md`,
    resultArtifact,
    `${receivedDir}/${resources.evidence.escapedSha256}-escaped.txt`,
  ]);
  const receivedDigests = digestOutput
    .split("\n")
    .map((line) => line.split(/\s+/u)[0]);
  if (
    receivedDigests[0] !== resources.evidence.specSha256 ||
    receivedDigests[1] !== resources.evidence.artifactSha256 ||
    receivedDigests[2] !== resources.evidence.escapedSha256
  )
    throw new Error(`forwarded evidence digest mismatch: ${digestOutput}`);
  const evidenceSnapshots = exec("b", [
    "sh",
    "-c",
    `find ${resources.b.runtime.piAgentDir}/pi-herdsman/evidence -type f -exec sha256sum '{}' +`,
  ]);
  const snapshotDigests = evidenceSnapshots
    .split("\n")
    .map((line) => line.split(/\s+/u)[0]);
  if (
    !snapshotDigests.includes(resources.evidence.specSha256) ||
    !snapshotDigests.includes(resources.evidence.artifactSha256) ||
    !snapshotDigests.includes(resources.evidence.escapedSha256)
  )
    throw new Error(
      `B's local assignment snapshots did not preserve both forwarded digests: ${evidenceSnapshots}`,
    );
  resources.evidence.receivedSpecSha256 = receivedDigests[0];
  resources.evidence.receivedResultSha256 = receivedDigests[1];
  resources.evidence.receivedEscapedSha256 = receivedDigests[2];
  resources.evidence.assignmentSnapshotDigests = snapshotDigests;
  resources.evidence.bLocalEvidenceReads = 2;
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
      "exact destination Manager is not live",
    )
  )
    throw new Error(
      `replacement Pi Manager stole the reply correspondence: ${rejectReplacement.stderr}${rejectReplacement.stdout}`,
    );
  resources.b.replacementRejected = replacementManager.piSessionId;
  save();

  console.log(
    `Fixture acceptance evidence: ${JSON.stringify({ runId, image: resources.image, network: resources.network, containers: resources.containers, volumes: resources.volumes, messageId: resources.acceptanceMessageId, replyId: resources.replyId, managers: { recipientBeforeRestart: resources.a.remoteProbe, recipientRecoveredSession: resources.b.recoveredSession, recipientRecoveredGeneration: resources.b.recoveredGeneration, originBeforeRestart: resources.b.remoteProbe, originRecoveredSession: resources.a.recoveredOriginSession, originRecoveredGeneration: resources.a.recoveredOriginGeneration }, evidence: resources.evidence, assertions: { duplicateAcceptance: resources.duplicateAcceptance, replyRetries: resources.replyRetryAssertions, sameExactSessionRecovery: resources.b.recoveredSession === resources.a.remoteProbe.session, generationChanged: resources.b.recoveredGeneration !== resources.a.remoteProbe.generation, finalReplyCompletion: resources.exchange.replyCompletionMarker, disconnectedAndReconnected: resources.exchange.interruptedAndReconnected, replacementRejected: resources.b.replacementRejected !== undefined }, replyCompletion: replyCompletion.slice(-300) })}`,
  );
  if (process.env.PEER_SMOKE_KEEP === "1")
    console.log(`Retained exact resource manifest: ${manifestPath}`);
} finally {
  if (process.env.PEER_SMOKE_KEEP !== "1") cleanup();
}
