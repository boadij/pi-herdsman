import { setAcceptedMarkerTempWriteHookForTests } from "./peer-bridge-fault-seam.ts";

setAcceptedMarkerTempWriteHookForTests(() => {
  throw new Error("injected accepted marker publication failure");
});
