import { setPendingMarkerTempWriteHookForTests } from "./peer-bridge-fault-seam.ts";

setPendingMarkerTempWriteHookForTests(() => {
  throw new Error("injected pending marker temp write failure");
});
