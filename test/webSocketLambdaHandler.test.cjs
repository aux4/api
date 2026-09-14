const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WebSocketLambdaHandler,
  isWebSocketEvent,
  managementEndpoint,
  messageRouteKey,
  selectWebSocketConfig
} = require("../lib/handler/WebSocketLambdaHandler");

function event(routeKey, eventType = "MESSAGE", extra = {}) {
  return {
    requestContext: {
      routeKey,
      eventType,
      connectionId: "connection-1",
      requestId: "request-1",
      domainName: "abc123.execute-api.us-east-1.amazonaws.com",
      stage: "dev",
      identity: { sourceIp: "192.0.2.10" },
      ...(extra.requestContext || {})
    },
    headers: extra.headers || {},
    queryStringParameters: extra.queryStringParameters || null,
    body: extra.body ?? null,
    isBase64Encoded: Boolean(extra.isBase64Encoded),
    ...(extra.stageVariables ? { stageVariables: extra.stageVariables } : {})
  };
}

function fixture(config = {}, commandResult = { exitCode: 0, stdout: "", stderr: "" }) {
  const calls = [];
  const sends = [];
  const commandPool = {
    execute: async (...args) => {
      calls.push(args);
      return typeof commandResult === "function" ? commandResult(...args) : commandResult;
    }
  };
  const sender = {
    send: async (...args) => sends.push(args)
  };
  const authHandler = {
    enabled: false,
    authenticate: async () => ({ principal: null })
  };
  const handler = new WebSocketLambdaHandler({
    ws: { "/chat": { routes: { $default: "aux4 echo" } } },
    ...config
  }, commandPool, { sender, authHandler });
  return { handler, calls, sends, authHandler };
}

test("recognizes API Gateway WebSocket events without confusing REST v2 events", () => {
  assert.equal(isWebSocketEvent(event("$connect", "CONNECT")), true);
  assert.equal(isWebSocketEvent({ requestContext: { routeKey: "$default" } }), false);
  assert.equal(isWebSocketEvent({ version: "2.0", requestContext: { http: { method: "GET" } } }), false);
});

test("uses API Gateway routeKey and falls back to body.action for $default", () => {
  assert.equal(messageRouteKey(event("sendMessage", "MESSAGE", { body: '{"action":"ignored"}' })), "sendMessage");
  assert.equal(messageRouteKey(event("$default", "MESSAGE", { body: '{"action":"ask"}' })), "ask");
  assert.equal(messageRouteKey(event("$default", "MESSAGE", { body: "plain text" })), "$default");
});

test("selects the only ws config or an explicit stage-variable path", () => {
  assert.equal(selectWebSocketConfig({ "/chat": {} }, event("$connect")).path, "/chat");
  assert.equal(selectWebSocketConfig(
    { "/chat": {}, "/events": {} },
    event("$connect", "CONNECT", { stageVariables: { AUX4_WS_PATH: "/events" } })
  ).path, "/events");
  assert.equal(selectWebSocketConfig({ "/chat": {}, "/events": {} }, event("$connect")), null);
});

test("builds management endpoints for execute-api and custom domains", () => {
  assert.equal(
    managementEndpoint(event("sendMessage")),
    "https://abc123.execute-api.us-east-1.amazonaws.com/dev"
  );
  assert.equal(
    managementEndpoint(event("sendMessage", "MESSAGE", {
      requestContext: { domainName: "socket.example.com", stage: "dev" }
    })),
    "https://socket.example.com"
  );
});

test("dispatches $connect with the gateway authorizer context", async () => {
  const { handler, calls, sends, authHandler } = fixture({
    ws: { "/chat": { routes: { $connect: "aux4 connected" } } }
  }, { exitCode: 0, stdout: '{"statusCode":200}', stderr: "" });
  let appAuthCalled = false;
  authHandler.enabled = true;
  authHandler.authenticate = async () => {
    appAuthCalled = true;
    return { error: "should not run" };
  };

  const response = await handler.dispatch(event("$connect", "CONNECT", {
    requestContext: { authorizer: { principalId: "user-123", scope: "demo" } },
    headers: { Authorization: "Bearer gateway-token" }
  }));

  assert.equal(response.statusCode, 200);
  assert.equal(appAuthCalled, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0][1]).requestContext.authorizer, {
    principalId: "user-123",
    scope: "demo"
  });
  assert.deepEqual(calls[0][3], { AUX4_ACCESS_TOKEN: "gateway-token" });
  assert.equal(sends.length, 0);
});

test("authenticates $connect with app auth and passes its principal and token context", async () => {
  const { handler, calls, authHandler } = fixture({
    security: { auth: { type: "oauth" } },
    ws: { "/chat": { routes: { $connect: "aux4 connected" } } }
  });
  authHandler.enabled = true;
  authHandler.authenticate = async () => ({
    principal: { sub: "user-456" },
    executionEnv: { AUX4_ACCESS_TOKEN: "access-token" }
  });

  const response = await handler.dispatch(event("$connect", "CONNECT"));

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(calls[0][1]).requestContext.authorizer, { sub: "user-456" });
  assert.deepEqual(calls[0][3], { AUX4_ACCESS_TOKEN: "access-token" });
});

test("rejects an unauthenticated $connect before command dispatch", async () => {
  const { handler, calls, authHandler } = fixture({
    security: { auth: { type: "oauth" } },
    ws: { "/chat": { routes: { $connect: "aux4 connected" } } }
  });
  authHandler.enabled = true;
  authHandler.authenticate = async () => ({ error: "Authentication required" });

  const response = await handler.dispatch(event("$connect", "CONNECT"));

  assert.equal(response.statusCode, 401);
  assert.equal(calls.length, 0);
});

test("routes a custom message and posts command output through the management API", async () => {
  const { handler, calls, sends } = fixture({
    ws: { "/chat": { routes: { sendMessage: "aux4 send", $default: "aux4 fallback" } } }
  }, { exitCode: 0, stdout: '{"message":"hello"}', stderr: "" });
  const incoming = event("sendMessage", "MESSAGE", { body: '{"action":"sendMessage"}' });

  const response = await handler.dispatch(incoming);

  assert.equal(response.statusCode, 200);
  assert.equal(calls[0][0], "aux4 send");
  assert.equal(sends.length, 1);
  assert.equal(sends[0][0], incoming);
  assert.equal(sends[0][1], '{"message":"hello"}');
});

test("route response mode returns the command body without a management API call", async () => {
  const { handler, sends } = fixture({
    ws: {
      "/chat": {
        responseMode: "route",
        routes: { $default: "aux4 echo" }
      }
    }
  }, { exitCode: 0, stdout: '{"statusCode":200,"body":"hello"}', stderr: "" });

  const response = await handler.dispatch(event("$default", "MESSAGE", { body: "hello" }));

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "hello");
  assert.equal(sends.length, 0);
});

test("dispatches $disconnect without attempting to write to a closed connection", async () => {
  const { handler, calls, sends } = fixture({
    ws: { "/chat": { routes: { $disconnect: "aux4 disconnected" } } }
  }, { exitCode: 0, stdout: "cleanup complete", stderr: "" });

  const response = await handler.dispatch(event("$disconnect", "DISCONNECT"));

  assert.equal(response.statusCode, 200);
  assert.equal(response.body, "cleanup complete");
  assert.equal(calls[0][0], "aux4 disconnected");
  assert.equal(sends.length, 0);
});

test("returns 404 when multiple ws configs have no Lambda selector", async () => {
  const { handler, calls } = fixture({
    ws: {
      "/chat": { routes: { $default: "aux4 chat" } },
      "/events": { routes: { $default: "aux4 events" } }
    }
  });

  const response = await handler.dispatch(event("$default"));

  assert.equal(response.statusCode, 404);
  assert.equal(calls.length, 0);
});

test("maps a stale Management API connection to 410", async () => {
  const { handler } = fixture({}, { exitCode: 0, stdout: "hello", stderr: "" });
  handler.sender.send = async () => {
    const error = new Error("gone");
    error.name = "GoneException";
    throw error;
  };

  const response = await handler.dispatch(event("$default"));

  assert.equal(response.statusCode, 410);
});
