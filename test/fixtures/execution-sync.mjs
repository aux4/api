export async function pullFromEnv(env) {
  globalThis.__aux4ExecutionSyncCalls.push({ operation: "pull", traceId: env.AUX4_TRACE_ID });
}

export async function pushFromEnv(env) {
  globalThis.__aux4ExecutionSyncCalls.push({ operation: "push", traceId: env.AUX4_TRACE_ID });
}
