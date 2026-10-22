import { writeFileSync } from "node:fs";
import { setPendingMarkerPublishHookForTests } from "./peer-bridge-fault-seam.ts";

setPendingMarkerPublishHookForTests((marker, content) => {
  const accepted = JSON.parse(content);
  accepted.status = "accepted";
  delete accepted.transfer;
  writeFileSync(marker, `${JSON.stringify(accepted)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
});
