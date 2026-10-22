export type PeerAcceptanceCutPoint =
  "pending-marker-durable" | "inbox-publication-durable";

let testHook: ((cutPoint: PeerAcceptanceCutPoint) => void) | undefined;

export function afterDurablePeerAcceptanceStep(
  cutPoint: PeerAcceptanceCutPoint,
): void {
  testHook?.(cutPoint);
}

/** Internal dependency seam used only by child-process crash regression tests. */
export function setPeerAcceptanceFaultHookForTests(
  hook: (cutPoint: PeerAcceptanceCutPoint) => void,
): void {
  testHook = hook;
}
