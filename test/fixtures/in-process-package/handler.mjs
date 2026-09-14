export function createHandler({ options, identity }) {
  globalThis.__aux4InProcessFixture = globalThis.__aux4InProcessFixture || {
    factories: 0,
    calls: 0,
    disposals: 0,
    active: 0,
    maxActive: 0
  };
  globalThis.__aux4InProcessFixture.factories++;

  return {
    async handle(context) {
      const state = globalThis.__aux4InProcessFixture;
      state.calls++;
      state.active++;
      state.maxActive = Math.max(state.maxActive, state.active);
      try {
        if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
        if (options.invalidAuth) {
          return { exitCode: 0, stdout: "not-json", stderr: "" };
        }
        if (options.auth) {
          const authorization = context.headers.authorization || "";
          return authorization === "Bearer valid-token"
            ? { exitCode: 0, stdout: JSON.stringify({ sub: "user-1", scope: "demo" }), stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "invalid token" };
        }
        return {
          exitCode: options.exitCode || 0,
          stdout: JSON.stringify({
            package: identity.package,
            marker: options.marker,
            request: context.request,
            principal: context.principal,
            auth: context.auth,
            traceId: context.trace.id,
            frozen: Object.isFrozen(context) && Object.isFrozen(context.request),
            aborted: context.signal.aborted
          }),
          stderr: options.stderr || ""
        };
      } finally {
        state.active--;
      }
    },
    clear() {
      globalThis.__aux4InProcessFixture.disposals++;
    }
  };
}
