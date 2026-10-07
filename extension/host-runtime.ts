import * as PiCodingAgent from "@earendil-works/pi-coding-agent";

type HostApi = typeof PiCodingAgent & { discoverContextFiles?: unknown };

// OMP exposes discoverContextFiles; Pi 1.0.4 exposes loadProjectContextFiles.
export const isOmpRuntime =
  typeof (PiCodingAgent as HostApi).discoverContextFiles === "function";
