const { createHash } = require("crypto");
const { performance } = require("perf_hooks");

const PHASES = new Set(["call-llm", "run-tool", "apply-results", "init", "resume", "finalize"]);
const CHILD_SPANS = new Set([
  "token.exchange", "package.discovery", "command.execution", "cloud.call",
  "broker", "model.inference", "agent.bootstrap", "agent.plan", "agent.results-load"
]);
const FIELDS = new Set(["type", "traceId", "phase", "span", "durationMs", "status", "cacheHit", "cold"]);
let firstExecution = true;

function createExecutionTiming(event, emit = line => console.error(line)) {
  const requestedTrace = event.traceId || Object.entries(event.headers || {})
    .find(([name]) => name.toLowerCase() === "x-aux4-trace-id")?.[1];
  const traceId = typeof requestedTrace === "string" && /^[a-f0-9]{32}$/.test(requestedTrace) ? requestedTrace
    : createHash("sha256").update(String(event.executionId || "")).digest("hex").slice(0, 32);
  const last = Array.isArray(event.command) ? event.command.at(-1) : undefined;
  const phase = PHASES.has(last) ? last : "unknown";
  const cold = firstExecution;
  firstExecution = false;
  const write = span => {
    // Observability must never turn a successful command into a failed phase.
    try { emit(JSON.stringify(span)); } catch { /* best effort */ }
  };
  const record = (span, started, status, cacheHit = false) => write({
    type: "aux4.timing", traceId, phase, span,
    durationMs: Math.max(0, performance.now() - started), status, cacheHit, cold
  });
  return {
    traceId, phase,
    start: () => performance.now(),
    record,
    async measure(span, action, cacheHit = false) {
      const started = performance.now();
      let status = "error";
      try {
        const result = await action();
        status = "ok";
        return result;
      } finally { record(span, started, status, cacheHit); }
    },
    relay(stderr) {
      for (const line of String(stderr || "").split(/\r?\n/)) {
        if (line.length > 2048 || !line.startsWith("{")) continue;
        try {
          const span = JSON.parse(line);
          if (span.type !== "aux4.timing" || span.traceId !== traceId || span.phase !== phase ||
              !CHILD_SPANS.has(span.span) || !["ok", "error"].includes(span.status) ||
              !Number.isFinite(span.durationMs) || span.durationMs < 0 ||
              (span.cacheHit !== undefined && typeof span.cacheHit !== "boolean") ||
              (span.cold !== undefined && typeof span.cold !== "boolean") ||
              Object.keys(span).some(key => !FIELDS.has(key))) continue;
          write(span);
        } catch { /* Ordinary stderr is never telemetry. */ }
      }
    }
  };
}

function relayRequestTimings(headers = {}, stderr, emit = line => console.error(line)) {
  const requestedTrace = Object.entries(headers)
    .find(([name]) => name.toLowerCase() === "x-aux4-trace-id")?.[1];
  if (typeof requestedTrace !== "string" || !/^[a-f0-9]{32}$/.test(requestedTrace)) return;

  for (const line of String(stderr || "").split(/\r?\n/)) {
    if (line.length > 2048 || !line.startsWith("{")) continue;
    try {
      const span = JSON.parse(line);
      if (span.type !== "aux4.timing" || span.traceId !== requestedTrace || span.phase !== "broker" ||
          !CHILD_SPANS.has(span.span) || !["ok", "error"].includes(span.status) ||
          !Number.isFinite(span.durationMs) || span.durationMs < 0 ||
          (span.cacheHit !== undefined && typeof span.cacheHit !== "boolean") ||
          (span.cold !== undefined && typeof span.cold !== "boolean") ||
          Object.keys(span).some(key => !FIELDS.has(key))) continue;
      emit(JSON.stringify(span));
    } catch { /* Ordinary command stderr is never relayed. */ }
  }
}

module.exports = { createExecutionTiming, relayRequestTimings };
