function buildRestEvent(request, pathParameters) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  const queryStringParameters = {};
  const multiValueQueryStringParameters = {};

  for (const [key, value] of url.searchParams.entries()) {
    queryStringParameters[key] = value;
    if (!multiValueQueryStringParameters[key]) {
      multiValueQueryStringParameters[key] = [];
    }
    multiValueQueryStringParameters[key].push(value);
  }

  const hasQuery = Object.keys(queryStringParameters).length > 0;

  return {
    httpMethod: request.method,
    path: url.pathname.replace(/^\/api/, "") || "/",
    headers: Object.assign({}, request.headers),
    queryStringParameters: hasQuery ? queryStringParameters : null,
    multiValueQueryStringParameters: hasQuery ? multiValueQueryStringParameters : null,
    pathParameters: Object.keys(pathParameters || {}).length > 0 ? pathParameters : null,
    body: request.body ? (typeof request.body === "string" ? request.body : JSON.stringify(request.body)) : null,
    isBase64Encoded: false,
    requestContext: {
      httpMethod: request.method,
      path: url.pathname,
      requestId: request.uuid,
      identity: {
        sourceIp: request.ip
      }
    }
  };
}

function buildWsConnectEvent(connectionId, headers, queryStringParameters) {
  return {
    requestContext: {
      routeKey: "$connect",
      connectionId,
      eventType: "CONNECT",
      requestId: connectionId
    },
    headers: Object.assign({}, headers),
    queryStringParameters: queryStringParameters && Object.keys(queryStringParameters).length > 0 ? queryStringParameters : null,
    isBase64Encoded: false
  };
}

function buildWsDisconnectEvent(connectionId) {
  return {
    requestContext: {
      routeKey: "$disconnect",
      connectionId,
      eventType: "DISCONNECT",
      requestId: connectionId
    },
    isBase64Encoded: false
  };
}

function buildWsMessageEvent(connectionId, routeKey, body) {
  return {
    requestContext: {
      routeKey,
      connectionId,
      eventType: "MESSAGE",
      requestId: connectionId
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    isBase64Encoded: false
  };
}

module.exports = { buildRestEvent, buildWsConnectEvent, buildWsDisconnectEvent, buildWsMessageEvent };
