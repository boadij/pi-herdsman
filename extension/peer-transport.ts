import {
  mkdirSync,
  chmodSync,
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { herdsmanDataRoot } from "./storage.ts";

export type SavedPeerMachine = Readonly<{
  id: string;
  label: string;
  target: string;
  reachable: boolean;
}>;
export type RemotePeerSnapshot = Readonly<{
  dataRoot: string;
  peers: Array<{
    role?: string;
    piSessionId: string;
    claim: { id: string };
    name?: string;
    cwd?: string;
    repo?: string;
    branch?: string;
    workspaceLabel?: string;
    build?: unknown;
  }>;
}>;

export function peerRecoveryRequest(
  request: Readonly<{
    id: string;
    capability: string;
    originSession: string;
    originGeneration: string;
    previousOriginGeneration: string;
    recipientSession: string;
    recipientGeneration: string;
  }>,
  expectedDataRoot: string,
): string {
  return JSON.stringify({ ...request, expectedDataRoot });
}

const COMMAND_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 1024 * 1024;
const OUTBOUND_LIMIT = 64 * 1024;

export type RemotePeerOutbound = Readonly<{
  id: string;
  machine: SavedPeerMachine;
  dataRoot: string;
  session: string;
  claimId: string;
  envelope: string;
}>;

function outboundDirectory(): string {
  const path = join(
    herdsmanDataRoot(),
    "runtime",
    "peers-v2",
    "remote-outbound",
  );
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

export function persistRemotePeerOutbound(outbound: RemotePeerOutbound): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      outbound.id,
    ) ||
    Buffer.byteLength(JSON.stringify(outbound), "utf8") > OUTBOUND_LIMIT
  )
    throw new Error("invalid remote peer outbound record");
  const path = join(outboundDirectory(), `${outbound.id}.json`);
  writeFileSync(path, `${JSON.stringify(outbound)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
    flush: true,
  });
}

export function listRemotePeerOutbounds(): RemotePeerOutbound[] {
  const directory = outboundDirectory();
  return readdirSync(directory)
    .filter((name) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u.test(
        name,
      ),
    )
    .flatMap((name) => {
      const path = join(directory, name);
      try {
        const stat = lstatSync(path);
        if (
          !stat.isFile() ||
          stat.isSymbolicLink() ||
          stat.size > OUTBOUND_LIMIT
        )
          return [];
        const value: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (
          !value ||
          typeof value !== "object" ||
          (value as RemotePeerOutbound).id !== name.slice(0, -5) ||
          typeof (value as RemotePeerOutbound).envelope !== "string"
        )
          return [];
        return [value as RemotePeerOutbound];
      } catch {
        return [];
      }
    });
}

export function removeRemotePeerOutbound(id: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)
  )
    return;
  try {
    unlinkSync(join(outboundDirectory(), `${id}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function run(
  command: string,
  args: readonly string[],
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let size = 0;
    const timeout = setTimeout(() => child.kill("SIGKILL"), COMMAND_TIMEOUT_MS);
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      size += chunk.length;
      if (size > OUTPUT_LIMIT) {
        child.kill("SIGKILL");
        return;
      }
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited ${code}`));
    });
    child.stdin.end(input);
  });
}

export async function listSavedPeerMachines(): Promise<SavedPeerMachine[]> {
  const [listText, statusText] = await Promise.all([
    run("herdr", ["machine", "list", "--json"]),
    run("herdr", ["machine", "status", "--json"]),
  ]);
  const list: unknown = JSON.parse(listText);
  const statuses: unknown = JSON.parse(statusText);
  if (!Array.isArray(list) || !Array.isArray(statuses))
    throw new Error("Herdr returned invalid machine data");
  const statusById = new Map<string, string>(
    statuses
      .filter(
        (item): item is { id: string; status: string } =>
          !!item &&
          typeof item === "object" &&
          typeof (item as { id?: unknown }).id === "string" &&
          (item as { status?: unknown }).status === "reachable",
      )
      .map((item) => [item.id, item.status]),
  );
  return list.flatMap((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      (item as { enabled?: unknown }).enabled !== true ||
      typeof (item as { id?: unknown }).id !== "string" ||
      typeof (item as { label?: unknown }).label !== "string" ||
      typeof (item as { target?: unknown }).target !== "string"
    )
      return [];
    return [
      {
        id: (item as { id: string }).id,
        label: (item as { label: string }).label,
        target: (item as { target: string }).target,
        reachable: statusById.get((item as { id: string }).id) === "reachable",
      },
    ];
  });
}

export function parsePeerSshTarget(target: string): {
  host: string;
  port?: string;
} {
  if (target.startsWith("ssh://")) {
    const url = new URL(target);
    if (
      url.protocol !== "ssh:" ||
      !url.hostname ||
      (url.pathname !== "" && url.pathname !== "/") ||
      url.search ||
      url.hash
    )
      throw new Error("Unsupported saved SSH target");
    const username = url.username ? `${decodeURIComponent(url.username)}@` : "";
    if (/[\s\0]/u.test(username))
      throw new Error("Unsupported saved SSH target");
    return {
      host: `${username}${url.hostname}`,
      ...(url.port ? { port: url.port } : {}),
    };
  }
  if (!target || /[\s\0]/u.test(target) || target.startsWith("-"))
    throw new Error("Unsupported saved SSH target");
  return { host: target };
}

export async function runPeerEndpoint(
  machine: SavedPeerMachine,
  action: "probe" | "accept" | "poll" | "ack" | "finalize" | "recover",
  input?: string,
): Promise<string> {
  const target = parsePeerSshTarget(machine.target);
  return run(
    "ssh",
    [
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "ConnectTimeout=10",
      ...(target.port ? ["-p", target.port] : []),
      target.host,
      `pi-herdsman-peer ${action}`,
    ],
    input,
  );
}

export async function probePeerEndpoint(
  machine: SavedPeerMachine,
): Promise<RemotePeerSnapshot> {
  const output = await runPeerEndpoint(machine, "probe");
  const probe: unknown = JSON.parse(output);
  if (
    !probe ||
    typeof probe !== "object" ||
    typeof (probe as { dataRoot?: unknown }).dataRoot !== "string" ||
    !Array.isArray((probe as { peers?: unknown }).peers)
  )
    throw new Error("Peer endpoint returned invalid probe data");
  return probe as RemotePeerSnapshot;
}
