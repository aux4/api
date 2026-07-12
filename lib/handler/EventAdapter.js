const crypto = require("crypto");

// Adapts an API Gateway REST v1 proxy event into a synthetic Fastify-like request,
// captures what RestHandler.handle writes via a reply shim, and serializes the result
// back into an API Gateway proxy response: { statusCode, headers, body, isBase64Encoded }.
//
// This keeps the Fastify-bound RestHandler.handle path completely untouched — the shim
// records status/headers/body/cookies in memory instead of writing to a socket.

function lowercaseHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try {
        cookies[key] = decodeURIComponent(value);
      } catch {
        cookies[key] = value;
      }
    }
  }
  return cookies;
}

function buildQueryString(event) {
  const qs = new URLSearchParams();
  if (event.multiValueQueryStringParameters) {
    for (const [key, values] of Object.entries(event.multiValueQueryStringParameters)) {
      (values || []).forEach(value => qs.append(key, value));
    }
  } else if (event.queryStringParameters) {
    for (const [key, value] of Object.entries(event.queryStringParameters)) {
      qs.append(key, value);
    }
  }
  const str = qs.toString();
  return str ? "?" + str : "";
}

// Build a synthetic Fastify-like request. RestHandler.handle reads:
// request.url / method / headers / body / ip / cookies / uuid (and, for multipart/stream
// only, request.parts()/tmpDir/raw — those paths are guarded out before handle() runs).
function buildSyntheticRequest(event) {
  const headers = lowercaseHeaders(event.headers);
  const method = (event.httpMethod || "GET").toUpperCase();
  const path = event.path || "/";
  const url = "/api" + path + buildQueryString(event);

  let body = event.body;
  if (body != null && event.isBase64Encoded) {
    body = Buffer.from(body, "base64").toString("utf-8");
  }

  return {
    method,
    url,
    headers,
    body: body == null ? undefined : body,
    ip: event.requestContext?.identity?.sourceIp || headers["x-forwarded-for"] || "127.0.0.1",
    cookies: parseCookies(headers.cookie),
    uuid: event.requestContext?.requestId || crypto.randomUUID(),
    tmpDir: undefined,
    raw: null
  };
}

function serializeCookie(name, value, options = {}) {
  let str = `${name}=${encodeURIComponent(value)}`;
  if (options.maxAge != null) str += `; Max-Age=${Math.floor(options.maxAge)}`;
  if (options.domain) str += `; Domain=${options.domain}`;
  str += `; Path=${options.path || "/"}`;
  if (options.expires) {
    const expires = options.expires instanceof Date ? options.expires.toUTCString() : options.expires;
    str += `; Expires=${expires}`;
  }
  if (options.httpOnly) str += "; HttpOnly";
  if (options.secure) str += "; Secure";
  if (options.sameSite) {
    const raw = typeof options.sameSite === "string" ? options.sameSite : "Strict";
    str += `; SameSite=${raw.charAt(0).toUpperCase() + raw.slice(1)}`;
  }
  return str;
}

// Capturing reply shim mirroring the subset of the Fastify reply API that
// RestHandler (and its helpers CookieHandler/sendResponse/sendDataUri) invoke.
class CapturingReply {
  constructor() {
    this.statusCode = 200;
    this.headers = {};
    this.setCookies = [];
    this.payload = undefined;
    this.sent = false;
    this.raw = null;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  code(code) {
    this.statusCode = code;
    return this;
  }

  header(key, value) {
    const lower = key.toLowerCase();
    if (lower === "set-cookie") {
      this.setCookies.push(value);
    } else {
      this.headers[lower] = value;
    }
    return this;
  }

  getHeader(key) {
    return this.headers[key.toLowerCase()];
  }

  type(contentType) {
    this.headers["content-type"] = contentType;
    return this;
  }

  setCookie(name, value, options) {
    this.setCookies.push(serializeCookie(name, value, options || {}));
    return this;
  }

  clearCookie(name, options = {}) {
    this.setCookies.push(serializeCookie(name, "", { ...options, expires: new Date(0), maxAge: 0 }));
    return this;
  }

  send(payload) {
    this.payload = payload;
    this.sent = true;
    return this;
  }
}

// Serialize the captured reply into an API Gateway REST v1 proxy response.
function toProxyResponse(reply) {
  const headers = { ...reply.headers };
  const payload = reply.payload;
  let body = "";
  let isBase64Encoded = false;

  if (Buffer.isBuffer(payload)) {
    body = payload.toString("base64");
    isBase64Encoded = true;
    if (!headers["content-type"]) headers["content-type"] = "application/octet-stream";
  } else if (payload == null) {
    body = "";
  } else if (typeof payload === "string") {
    body = payload;
    if (!headers["content-type"]) headers["content-type"] = "text/plain; charset=utf-8";
  } else if (typeof payload === "object") {
    body = JSON.stringify(payload);
    if (!headers["content-type"]) headers["content-type"] = "application/json; charset=utf-8";
  } else {
    body = String(payload);
    if (!headers["content-type"]) headers["content-type"] = "text/plain; charset=utf-8";
  }

  const response = {
    statusCode: reply.statusCode || 200,
    headers,
    body,
    isBase64Encoded
  };

  if (reply.setCookies.length === 1) {
    response.headers["set-cookie"] = reply.setCookies[0];
  } else if (reply.setCookies.length > 1) {
    response.multiValueHeaders = { "set-cookie": reply.setCookies };
  }

  return response;
}

module.exports = { buildSyntheticRequest, CapturingReply, toProxyResponse };
