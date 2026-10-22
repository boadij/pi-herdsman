import { setPeerAcceptanceFaultHookForTests } from "./peer-bridge-fault-seam.ts";
import { setPendingMarkerWriteLimitForTests } from "./peer-bridge-fault-seam.ts";

setPendingMarkerWriteLimitForTests((requested) => Math.min(requested, 7));
setPeerAcceptanceFaultHookForTests((cutPoint) => {
  if (cutPoint === "pending-marker-durable")
    process.kill(process.pid, "SIGKILL");
});
