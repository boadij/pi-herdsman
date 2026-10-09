import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { connectCodexContextSharing } from "@howaboua/pi-codex-conversion/context-sharing";

const BOOTSTRAP_EVENT = "pi-herdsman:managed-agent-bootstrap";
const PARTICIPANT_ID = "pi-codex/context-sharing";

type Preparation = {
  payload: string;
  commit?: () => void | Promise<void>;
};

type PrepareEvent = {
  protocol: 1;
  phase: "prepare";
  context: ExtensionContext;
  agent: string;
  register(
    id: string,
    prepare: () => Preparation | undefined | Promise<Preparation | undefined>,
  ): void;
};

type InitializeEvent = {
  protocol: 1;
  phase: "initialize";
  context: ExtensionContext;
  agent: string;
  participant: {
    id: string;
    payload: string;
  };
  accept(initialize: () => void | Promise<void>): void;
};

type BootstrapEvent = PrepareEvent | InitializeEvent;

export default function register(pi: ExtensionAPI): void {
  const connection = connectCodexContextSharing(pi);

  const offBootstrap = pi.events.on(BOOTSTRAP_EVENT, (value) => {
    const event = value as BootstrapEvent;
    if (event?.protocol !== 1) return;

    if (event.phase === "prepare") {
      event.register(PARTICIPANT_ID, async () => {
        const service = connection.service;
        if (!service?.canCreateChild(event.context)) return undefined;

        const identity = service.describe(event.context);
        if (identity?.storage !== "remote") return undefined;

        const { binding, adopt } = await service.createChild(event.context, {
          name: event.agent,
        });

        return {
          payload: JSON.stringify(binding),
          commit: adopt,
        };
      });
      return;
    }

    if (event.participant?.id !== PARTICIPANT_ID) return;

    event.accept(async () => {
      const service = connection.service;
      if (!service)
        throw new Error("Pi Codex Conversion context sharing is unavailable");

      await service.bind(event.context, JSON.parse(event.participant.payload));
    });
  });

  pi.on("session_shutdown", () => {
    offBootstrap();
    connection.dispose();
  });
}
