export type PeerAcceptanceCutPoint =
  "pending-marker-durable" | "inbox-publication-durable";

let testHook: ((cutPoint: PeerAcceptanceCutPoint) => void) | undefined;
let pendingMarkerTempWriteHook: (() => void) | undefined;
let pendingMarkerWriteLimitHook: ((requested: number) => number) | undefined;
let pendingMarkerPublishHook:
  ((marker: string, content: string) => void) | undefined;
let acceptedMarkerTempWriteHook:
  ((temporary: string, marker: string) => void) | undefined;

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

export function afterPendingMarkerTempWriteForTests(): void {
  pendingMarkerTempWriteHook?.();
}

export function setPendingMarkerTempWriteHookForTests(hook: () => void): void {
  pendingMarkerTempWriteHook = hook;
}

export function pendingMarkerWriteLimitForTests(requested: number): number {
  return pendingMarkerWriteLimitHook?.(requested) ?? requested;
}

export function setPendingMarkerWriteLimitForTests(
  hook: (requested: number) => number,
): void {
  pendingMarkerWriteLimitHook = hook;
}

export function beforePendingMarkerPublishForTests(
  marker: string,
  content: string,
): void {
  pendingMarkerPublishHook?.(marker, content);
}

export function setPendingMarkerPublishHookForTests(
  hook: (marker: string, content: string) => void,
): void {
  pendingMarkerPublishHook = hook;
}

export function afterAcceptedMarkerTempWriteForTests(
  temporary: string,
  marker: string,
): void {
  acceptedMarkerTempWriteHook?.(temporary, marker);
}

export function setAcceptedMarkerTempWriteHookForTests(
  hook: (temporary: string, marker: string) => void,
): void {
  acceptedMarkerTempWriteHook = hook;
}
