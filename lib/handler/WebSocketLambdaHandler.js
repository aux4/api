const crypto = require("crypto");
const AuthHandler = require("./AuthHandler");
const { lowercaseHeaders, parseCookies, CapturingReply, toProxyResponse } = require("./EventAdapter");
const { isIpAllowed } = require("../middleware/IpAllowlistMiddleware");
const { CommandPoolFullError, CommandPoolTimeoutError } = require("../CommandPool");
const { relayRequestTimings } = require("../ExecutionTiming");

function isWebSocketEvent(event) {
  const context = event && event.requestContext;
  if (!context || !context.connectionId) return false;
  return Boolean(context.routeKey || context.eventType);
}

function gatewayPrincipal(authorizer) {
  if (!authorizer || typeof authorizer !== "object") return null;
  if (authorizer.principalId || authorizer.sub) return authorizer;
  if (authorizer.lambda?.principalId || authorizer.lambda?.sub) return authorizer.lambda;
  if (authorizer.jwt?.claims && typeof authorizer.jwt.claims === "object") return authorizer.jwt.claims;
  return null;
}

function commandRoute(route) {
  if (typeof route === "string") return { command: route };
  if (route && typeof route === "object") return route;
  return {};
}

function messageRouteKey(event) {
  const context = event.requestContext || {};
  if (context.eventType === "CONNECT") return "$connect";
  if (context.eventType === "DISCONNECT") return "$disconnect";
  if (context.routeKey && context.routeKey !== "$default") return context.routeKey;

  let body = event.body;
  if (body != null && event.isBase64Encoded) {
    body = Buffer.from(body, "base64").toString("utf8");
  }
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  return body && typeof body.action === "string" && body.action ? body.action : "$default";
}

function selectWebSocketConfig(ws, event) {
  const entries = Object.entries(ws || {});
  if (entries.length === 0) return null;

  const explicitPath =
    event.stageVariables?.AUX4_WS_PATH ||
    event.stageVariables?.wsPath ||
    event.requestContext?.wsPath ||
    event.wsPath;
  if (explicitPath && ws[explicitPath]) return { path: explicitPath, config: ws[explicitPath] };
  if (entries.length === 1) return { path: entries[0][0], config: entries[0][1] };
  return null;
}

function proxyResponse(statusCode = 200, body = "", headers = {}) {
  return {
    statusCode,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false
  };
}

function responseFromOutput(output) {
  const value = String(output || "").trim();
  if (!value) return proxyResponse();
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && parsed.statusCode) {
      return {
        statusCode: Number(parsed.statusCode) || 200,
        headers: parsed.headers || {},
        body: typeof parsed.body === "string" ? parsed.body : JSON.stringify(parsed.body ?? ""),
        isBase64Encoded: Boolean(parsed.isBase64Encoded)
      };
    }
    return proxyResponse(200, parsed);
  } catch {
    return proxyResponse(200, value);
  }
}

function messageFromResponse(response) {
  if (response.isBase64Encoded) return Buffer.from(response.body || "", "base64");
  return response.body || "";
}

function managementEndpoint(event, configuredEndpoint) {
  if (configuredEndpoint) return configuredEndpoint.replace(/\/$/, "");
  const context = event.requestContext || {};
  if (!context.domainName) throw new Error("WebSocket event is missing requestContext.domainName");
  const defaultGatewayDomain = context.domainName.includes(".execute-api.");
  const stage = defaultGatewayDomain && context.stage ? `/${context.stage}` : "";
  return `https://${context.domainName}${stage}`;
}

class GatewayConnectionSender {
  constructor(clientFactory) {
    this.clientFactory = clientFactory;
    this.clients = new Map();
  }

  client(endpoint) {
    if (!this.clients.has(endpoint)) {
      if (this.clientFactory) {
        this.clients.set(endpoint, this.clientFactory(endpoint));
      } else {
        const { ApiGatewayManagementApiClient } = require("@aws-sdk/client-apigatewaymanagementapi");
        this.clients.set(endpoint, new ApiGatewayManagementApiClient({ endpoint }));
      }
    }
    return this.clients.get(endpoint);
  }

  async send(event, data, configuredEndpoint) {
    const endpoint = managementEndpoint(event, configuredEndpoint);
    const client = this.client(endpoint);
    if (this.clientFactory) {
      return client.send({ connectionId: event.requestContext.connectionId, data });
    }
    const { PostToConnectionCommand } = require("@aws-sdk/client-apigatewaymanagementapi");
    return client.send(new PostToConnectionCommand({
      ConnectionId: event.requestContext.connectionId,
      Data: data
    }));
  }
}

class WebSocketLambdaHandler {
  constructor(config, commandPool, options = {}) {
    this.config = config;
    this.commandPool = commandPool;
    this.defaultTimeout = config.server?.timeout || 30000;
    this.authHandler = options.authHandler || new AuthHandler(config, commandPool, this.defaultTimeout);
    this.sender = options.sender || new GatewayConnectionSender(options.clientFactory);
  }

  buildAuthRequest(event) {
    const headers = lowercaseHeaders(event.headers);
    return {
      headers,
      cookies: parseCookies(headers.cookie),
      ip: event.requestContext?.identity?.sourceIp || headers["x-forwarded-for"] || "127.0.0.1",
      authorizer: event.requestContext?.authorizer || null,
      url: "/" + (Object.keys(event.queryStringParameters || {}).length
        ? `?${new URLSearchParams(event.queryStringParameters).toString()}`
        : "")
    };
  }

  validLegacyApiKey(request, event) {
    const security = this.config.security || {};
    if (!security.apiKey) return true;
    const headerName = (security.header || "X-API-Key").toLowerCase();
    const provided = request.headers[headerName] || event.queryStringParameters?.apiKey || "";
    const expected = String(security.apiKey);
    const a = Buffer.from(String(provided));
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async authenticateConnect(event, routeConfig) {
    const request = this.buildAuthRequest(event);
    const reply = new CapturingReply();
    const security = this.config.security || {};

    if (security.allowedIPs && !isIpAllowed(request.ip, security.allowedIPs)) {
      return { error: proxyResponse(403, { message: "Forbidden", error: "IP not allowed", statusCode: 403 }) };
    }
    if (!this.validLegacyApiKey(request, event)) {
      return { error: proxyResponse(401, { message: "Unauthorized", error: "Invalid or missing API key", statusCode: 401 }) };
    }

    let principal = gatewayPrincipal(event.requestContext?.authorizer);
    let executionEnv;
    const authorization = request.headers.authorization || "";
    if (principal && authorization.startsWith("Bearer ")) {
      executionEnv = { AUX4_ACCESS_TOKEN: authorization.substring(7) };
    }
    if (!principal && this.authHandler.enabled && !routeConfig.public) {
      const result = await this.authHandler.authenticate(request, reply);
      if (result.error) {
        const status = result.status || 401;
        return {
          error: proxyResponse(status, {
            message: status === 403 ? "Forbidden" : "Unauthorized",
            error: result.error,
            statusCode: status
          })
        };
      }
      principal = result.principal;
      executionEnv = result.executionEnv;
    }

    return { principal, executionEnv, reply };
  }

  eventWithPrincipal(event, principal) {
    if (!principal || event.requestContext?.authorizer) return event;
    return {
      ...event,
      requestContext: { ...event.requestContext, authorizer: principal }
    };
  }

  async dispatch(event) {
    const selected = selectWebSocketConfig(this.config.ws, event);
    if (!selected) {
      return proxyResponse(404, {
        message: "WebSocket route configuration not found",
        error: "Not Found",
        statusCode: 404
      });
    }

    const routeKey = messageRouteKey(event);
    const routes = selected.config.routes || {};
    const route = commandRoute(routes[routeKey] || (routeKey !== "$connect" && routeKey !== "$disconnect" ? routes.$default : null));
    let executionEnv;
    let authReply;
    let commandEvent = event;

    if (routeKey === "$connect") {
      const auth = await this.authenticateConnect(event, selected.config);
      if (auth.error) return auth.error;
      executionEnv = auth.executionEnv;
      authReply = auth.reply;
      commandEvent = this.eventWithPrincipal(event, auth.principal);
    } else {
      const authorization = lowercaseHeaders(event.headers).authorization || "";
      if (authorization.startsWith("Bearer ")) {
        executionEnv = { AUX4_ACCESS_TOKEN: authorization.substring(7) };
      }
    }

    if (!route.command) {
      return authReply ? toProxyResponse(authReply) : proxyResponse();
    }

    try {
      const timeout = route.timeout || selected.config.timeout || this.defaultTimeout;
      const result = await this.commandPool.execute(
        route.command,
        JSON.stringify(commandEvent),
        timeout,
        executionEnv
      );
      relayRequestTimings(lowercaseHeaders(event.headers), result.stderr);
      if (result.exitCode !== 0) {
        return proxyResponse(500, {
          message: "Internal Server Error",
          error: "Command failed",
          statusCode: 500
        });
      }

      const response = responseFromOutput(result.stdout);
      if (routeKey === "$connect" || routeKey === "$disconnect") {
        if (authReply) {
          const authResponse = toProxyResponse(authReply);
          response.headers = { ...authResponse.headers, ...response.headers };
          if (authResponse.multiValueHeaders) response.multiValueHeaders = authResponse.multiValueHeaders;
        }
        return response;
      }

      const responseMode = route.responseMode || selected.config.responseMode || "management";
      if (responseMode === "route") return response;
      if (responseMode === "none" || !String(response.body || "").length) return proxyResponse();

      await this.sender.send(event, messageFromResponse(response), selected.config.managementEndpoint);
      return proxyResponse();
    } catch (error) {
      if (error instanceof CommandPoolFullError || error instanceof CommandPoolTimeoutError) {
        return proxyResponse(503, { message: "Service Unavailable", error: error.message, statusCode: 503 });
      }
      const gone = error?.name === "GoneException" || error?.$metadata?.httpStatusCode === 410;
      return proxyResponse(gone ? 410 : 500, {
        message: gone ? "Gone" : "Internal Server Error",
        error: gone ? "Connection no longer exists" : "Unexpected error",
        statusCode: gone ? 410 : 500
      });
    }
  }
}

module.exports = {
  GatewayConnectionSender,
  WebSocketLambdaHandler,
  gatewayPrincipal,
  isWebSocketEvent,
  managementEndpoint,
  messageRouteKey,
  responseFromOutput,
  selectWebSocketConfig
};
