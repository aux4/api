const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const BODY_METHODS = ["POST", "PUT", "PATCH"];

function loadConfig(configFile) {
  const content = fs.readFileSync(configFile, "utf-8");
  const parsed = yaml.load(content) || {};
  return parsed.config ? parsed.config : parsed;
}

// Replicates ComponentLoader: merge each component's config.api under its mount path.
function loadComponentRoutes(config, baseDir) {
  const components = config.components || {};
  const routes = {};

  for (const [mountPath, componentConfig] of Object.entries(components)) {
    const pkg = componentConfig && componentConfig.package;
    if (!pkg) continue;

    const [scope, name] = pkg.split("/");
    const componentConfigFile = path.join(baseDir, "components", scope, name, "config.yaml");
    if (!fs.existsSync(componentConfigFile)) continue;

    let parsed;
    try {
      parsed = yaml.load(fs.readFileSync(componentConfigFile, "utf-8")) || {};
    } catch {
      continue;
    }

    const componentRoutes = (parsed.config ? parsed.config.api : parsed.api) || {};
    for (const [route, routeConfig] of Object.entries(componentRoutes)) {
      const spaceIndex = route.indexOf(" ");
      if (spaceIndex === -1) continue;
      const method = route.substring(0, spaceIndex);
      const routePath = route.substring(spaceIndex + 1);
      const prefixedPath = routePath === "/" ? mountPath : mountPath + routePath;
      routes[`${method} ${prefixedPath}`] = routeConfig;
    }
  }

  return routes;
}

// Index every command in the app .aux4 as "<profile>::<command>" -> command definition.
function loadAux4Commands(baseDir) {
  const aux4File = path.join(baseDir, ".aux4");
  if (!fs.existsSync(aux4File)) return {};

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(aux4File, "utf-8"));
  } catch {
    return {};
  }

  const map = {};
  for (const profile of pkg.profiles || []) {
    for (const command of profile.commands || []) {
      map[`${profile.name}::${command.name}`] = command;
    }
  }
  return map;
}

// "aux4 api module contacts list" -> profile "api:module:contacts", command "list".
function resolveExecute(commandStr, commandMap) {
  const tokens = commandStr.trim().split(/\s+/);
  if (tokens[0] === "aux4") tokens.shift();
  if (tokens.length === 0) return null;

  const commandName = tokens[tokens.length - 1];
  const profileName = tokens.slice(0, -1).join(":") || "main";
  const command = commandMap[`${profileName}::${commandName}`];
  return command ? command.execute || [] : null;
}

// Best-effort static analysis of an execute[] for query/body field references.
function scrapeParams(execute) {
  const text = (execute || []).join("\n");
  const query = new Set();
  const body = new Set();

  for (const match of text.matchAll(/\bquery\.([A-Za-z_]\w*)/g)) {
    query.add(match[1]);
  }

  // Body aliases: `set:data=json:${body}` marks `data` as an alias for the body.
  const aliases = new Set(["body"]);
  for (const match of text.matchAll(/set:([A-Za-z_]\w*)\s*=\s*json:\$?\{?body\}?/g)) {
    aliases.add(match[1]);
  }

  for (const alias of aliases) {
    const re = new RegExp("\\b" + alias + "\\.([A-Za-z_]\\w*)", "g");
    for (const match of text.matchAll(re)) {
      body.add(match[1]);
    }
  }

  return { query: [...query], body: [...body] };
}

function operationId(command, method, pathStr) {
  const base = command || `${method} ${pathStr}`;
  return base
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function applyOverlay(operation, annotation) {
  for (const key of ["summary", "description", "operationId", "deprecated"]) {
    if (annotation[key] !== undefined) operation[key] = annotation[key];
  }
  if (annotation.tags !== undefined) operation.tags = annotation.tags;

  if (annotation.parameters !== undefined) {
    const byKey = new Map();
    for (const p of operation.parameters || []) byKey.set(`${p.in}:${p.name}`, p);
    for (const p of annotation.parameters) byKey.set(`${p.in}:${p.name}`, p);
    operation.parameters = [...byKey.values()];
  }

  if (annotation.requestBody !== undefined) operation.requestBody = annotation.requestBody;
  if (annotation.responses !== undefined) {
    operation.responses = { ...operation.responses, ...annotation.responses };
  }
}

function buildOperation(method, pathStr, routeConfig, commandMap) {
  const command = routeConfig.command;
  const pathParams = [...pathStr.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
  const firstSegment = pathStr.split("/").filter(Boolean)[0] || "root";
  const cleanTag = firstSegment.replace(/[{}]/g, "");

  const operation = {
    tags: [cleanTag],
    operationId: operationId(command, method, pathStr),
    summary: command || `${method} ${pathStr}`
  };

  const parameters = pathParams.map(name => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string" }
  }));

  let scraped = { query: [], body: [] };
  if (command) {
    const execute = resolveExecute(command, commandMap);
    if (execute) scraped = scrapeParams(execute);
  }

  const hasBody = BODY_METHODS.includes(method);

  if (!hasBody) {
    for (const name of scraped.query) {
      if (pathParams.includes(name)) continue;
      parameters.push({ name, in: "query", required: false, schema: { type: "string" } });
    }
  }

  if (parameters.length > 0) operation.parameters = parameters;

  if (hasBody && scraped.body.length > 0) {
    const properties = {};
    for (const field of scraped.body) properties[field] = { type: "string" };
    operation.requestBody = {
      content: {
        "application/json": {
          schema: { type: "object", properties }
        }
      }
    };
  }

  operation.responses = { "200": { description: "Successful response" } };

  if (routeConfig.openapi) {
    applyOverlay(operation, routeConfig.openapi);
  }

  return operation;
}

function generate(configFile, format) {
  const resolved = path.resolve(configFile);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${configFile}`);
  }
  const baseDir = path.dirname(resolved);
  const config = loadConfig(resolved);
  const commandMap = loadAux4Commands(baseDir);

  const allRoutes = { ...(config.api || {}), ...loadComponentRoutes(config, baseDir) };

  const paths = {};
  const tagSet = new Set();

  for (const [route, routeConfig] of Object.entries(allRoutes)) {
    const spaceIndex = route.indexOf(" ");
    if (spaceIndex === -1) continue;

    const method = route.substring(0, spaceIndex).toUpperCase();
    const pathStr = route.substring(spaceIndex + 1);

    const operation = buildOperation(method, pathStr, routeConfig || {}, commandMap);
    (operation.tags || []).forEach(t => tagSet.add(t));

    if (!paths[pathStr]) paths[pathStr] = {};
    paths[pathStr][method.toLowerCase()] = operation;
  }

  const info = config.info || {};
  const doc = {
    openapi: "3.0.3",
    info: {
      title: info.title || "aux4 API",
      version: info.version || "1.0.0"
    },
    paths
  };
  if (info.description) doc.info.description = info.description;
  if (tagSet.size > 0) {
    doc.tags = [...tagSet].sort().map(name => ({ name }));
  }

  if (format === "yaml") {
    return yaml.dump(doc, { noRefs: true });
  }
  return JSON.stringify(doc, null, 2);
}

module.exports = { generate };
