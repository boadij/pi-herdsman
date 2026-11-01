const TRACE_ENUMS = {
  event: new Set(["inbound_persisted", "send_invoked"]),
  outcome: new Set([
    "persisted",
    "followUp",
    "busy",
    "assistant_complete",
    "before_agent_start",
    "decision_started",
    "model_invocation",
    "tool_call",
    "waiting_for_binding",
  ]),
  branch: new Set(["capture_session", "inbound_lead_request", "other"]),
  tool: new Set(["read", "message_peer"]),
  status: new Set(["accepted", "queued", "rejected"]),
  reasonCode: new Set([
    "sender_unavailable",
    "sender_role_changed",
    "route_role_mismatch",
    "route_ambiguous",
    "no_authorized_target",
  ]),
};
const TRACE_BOOLEAN_FIELDS = [
  "modelExpected",
  "inboundRequestPresent",
  "importedBindingVisible",
  "triggerTurn",
  "idle",
];

export function safeCommandFailure(label, details, sensitiveValues = []) {
  let safe = String(details ?? "");
  for (const value of sensitiveValues)
    if (typeof value === "string" && value)
      safe = safe.replaceAll(value, "[image-ref]");
  safe = safe
    .replace(
      /\b(?:[A-Za-z0-9.-]+(?::\d+)?\/)+[A-Za-z0-9._/-]+(?::[A-Za-z0-9_.-]+)?(?:@sha256:[a-f0-9]{64})?/giu,
      "[image-ref]",
    )
    .replace(/(?:Bearer\s+)[^\s"']+/giu, "Bearer [redacted]")
    .replace(
      /((?:token|password|secret|credential|private[_ -]?key)\s*[:=]\s*)[^\s,"']+/giu,
      "$1[redacted]",
    );
  const bounded = Buffer.from(safe).subarray(0, 512).toString("utf8");
  return `${label} failed${bounded ? `: ${bounded}` : ""}`;
}

export function assertDistinctImages(ids, explicitPair) {
  if (explicitPair && ids.a === ids.b)
    throw new Error("federation sides must use genuinely distinct image IDs");
}

export function projectRuntimeTrace(trace, maxEntries = 16, maxBytes = 4096) {
  const projected = { a: [], b: [] };
  for (const side of ["a", "b"]) {
    const entries = Array.isArray(trace?.[side]) ? trace[side] : [];
    projected[side] = entries.slice(-maxEntries).flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return [];
      const safe = {};
      for (const [field, allowed] of Object.entries(TRACE_ENUMS)) {
        const value = entry[field];
        if (typeof value === "string" && allowed.has(value))
          safe[field] = value;
      }
      for (const field of TRACE_BOOLEAN_FIELDS)
        if (typeof entry[field] === "boolean") safe[field] = entry[field];
      return Object.keys(safe).length ? [safe] : [];
    });
  }
  while (
    Buffer.byteLength(JSON.stringify(projected), "utf8") > maxBytes &&
    (projected.a.length || projected.b.length)
  ) {
    if (projected.a.length >= projected.b.length) projected.a.shift();
    else projected.b.shift();
  }
  return projected;
}
