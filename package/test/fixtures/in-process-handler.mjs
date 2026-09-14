export function createHandler({ options }) {
  return {
    async handle(context) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          statusCode: 201,
          headers: { "x-handler": options.marker },
          body: JSON.stringify({
            method: context.method,
            id: context.params.id,
            query: context.query.mode,
            principal: context.principal,
            traceId: context.trace.id
          })
        }),
        stderr: ""
      };
    }
  };
}
