import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  TranscriptMessages,
} from "@earendil-works/pi-ai";

export function managerHandoffSupervisorToolAvailable(
  messages: TranscriptMessages,
): boolean;

export function decide(
  model: string,
  context: { messages: readonly unknown[] },
): AssistantMessage;

export function waitForSmokeObservation(
  directory: string,
  filename: string,
  signal: AbortSignal | undefined,
): Promise<void>;

export function waitForContinuationObservation(
  directory: string,
  signal?: AbortSignal,
): Promise<void>;

export default function install(
  pi: Pick<ExtensionAPI, "on" | "registerProvider">,
): void;
