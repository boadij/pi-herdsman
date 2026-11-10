import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { COORDINATION_INBOX_SCAN_LIMIT } from "./supervision.ts";

export type DeliveryPhase = "startup" | "turn" | "settle";
export type DeliveryBudget = { count: number; bytes: number };

const MAX_BYTES = 256 * 1024;
export function recipientFanInBudget(): DeliveryBudget {
  return { count: 0, bytes: 0 };
}

export function includeFanInMessage(
  budget: DeliveryBudget,
  content: string,
  maximumBytes = MAX_BYTES,
): boolean {
  const bytes = Buffer.byteLength(content, "utf8");
  if (
    budget.count >= COORDINATION_INBOX_SCAN_LIMIT ||
    (budget.count > 0 && budget.bytes + bytes > maximumBytes)
  )
    return false;
  budget.count++;
  budget.bytes += bytes;
  return true;
}

export function releaseFanInMessage(
  budget: DeliveryBudget,
  content: string,
): void {
  budget.count = Math.max(0, budget.count - 1);
  budget.bytes = Math.max(0, budget.bytes - Buffer.byteLength(content, "utf8"));
}

export function registerRecipientFanIn(
  pi: ExtensionAPI,
  drain: (
    ctx: ExtensionContext,
    phase: DeliveryPhase,
    budget: DeliveryBudget,
  ) => Promise<number>,
): void {
  pi.on("before_agent_start", async (event, ctx) => {
    await drain(ctx, "startup", recipientFanInBudget());
  });
  pi.on("turn_end", async (event, ctx) => {
    if (event?.outcome !== "completed") return;
    const count = await drain(ctx, "turn", recipientFanInBudget());
    if (count > 0) return { continue: true };
  });
  pi.on("agent_before_settle", async (event, ctx) => {
    if (event?.outcome !== "completed") return;
    const count = await drain(ctx, "settle", recipientFanInBudget());
    if (count > 0) return { continue: true };
  });
}
