import { setPeerAcceptanceFaultHookForTests } from "./peer-bridge-fault-seam.ts";

const target = process.env.PEER_TEST_KILL_AFTER;
if (
  target !== "pending-marker-durable" &&
  target !== "inbox-publication-durable"
)
  throw new Error("missing peer bridge crash-test cut point");

setPeerAcceptanceFaultHookForTests((cutPoint) => {
  if (cutPoint === target) process.kill(process.pid, "SIGKILL");
});
