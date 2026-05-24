const fs = require("fs");
const path = require("path");

const viewsDir = "./views";
let _handlebars = null;
let _hasViews = null;
let _production = false;

const templateCache = new Map();
const existsCache = new Map();
let _componentViewMappings = {};

function setProduction(enabled) {
  _production = enabled;
}

function setComponentViewMappings(mappings) {
  _componentViewMappings = mappings || {};
}

function getHandlebars() {
  if (!_handlebars) _handlebars = require("handlebars");
  return _handlebars;
}

function hasViews() {
  if (_hasViews === null) _hasViews = fs.existsSync(viewsDir);
  return _hasViews;
}

function prefersJson(request) {
  const accept = request.headers.accept || "";
  return accept.includes("application/json") && !accept.includes("text/html");
}

function getCompiledTemplate(fullPath) {
  const cached = templateCache.get(fullPath);

  // Production: return cached template without checking mtime
  if (_production && cached) {
    return cached.template;
  }

  let mtime;
  try {
    mtime = fs.statSync(fullPath).mtimeMs;
  } catch {
    templateCache.delete(fullPath);
    existsCache.set(fullPath, false);
    return null;
  }

  existsCache.set(fullPath, true);

  if (cached && cached.mtime === mtime) {
    return cached.template;
  }

  const handlebars = getHandlebars();
  const content = fs.readFileSync(fullPath, "utf-8");
  const template = handlebars.compile(content);
  templateCache.set(fullPath, { template, mtime });
  return template;
}

function fileExists(fullPath) {
  const cached = existsCache.get(fullPath);
  if (cached !== undefined) return cached;

  const exists = fs.existsSync(fullPath);
  existsCache.set(fullPath, exists);
  return exists;
}

function renderPartialFile(partialPath, data) {
  const fullPath = path.join(viewsDir, partialPath);
  const template = getCompiledTemplate(fullPath);
  if (!template) return null;
  return template(data);
}

function findPartialForCommand(command) {
  // Check component view mappings first
  if (_componentViewMappings[command]) {
    return { absolute: _componentViewMappings[command] };
  }

  // Check app views
  const parts = command.split(/\s+/).filter(p => p !== "aux4");
  const viewPath = path.join(viewsDir, ...parts.slice(0, -1), parts[parts.length - 1] + ".p.hbs");
  if (fileExists(viewPath)) {
    return { relative: path.relative(viewsDir, viewPath) };
  }
  return null;
}

function renderCommandPartial(command, data, apiPath, basePath, extra) {
  const partial = findPartialForCommand(command);
  if (!partial) return null;

  const context = { data, apiPath, basePath, ...(extra || {}) };

  if (partial.absolute) {
    const template = getCompiledTemplate(partial.absolute);
    if (!template) return null;
    return template(context);
  }

  return renderPartialFile(partial.relative, context);
}

function renderViewPartial(viewPath) {
  const partialPath = viewPath.replace(/^\//, "") + ".p.hbs";
  return renderPartialFile(partialPath, {});
}

function parseErrorData(payload, statusCode) {
  try {
    const parsed = JSON.parse(payload);
    return {
      message: parsed.message || parsed.error || "An error occurred",
      error: parsed.error || "Error",
      statusCode
    };
  } catch {
    return {
      message: payload || "An error occurred",
      error: "Error",
      statusCode
    };
  }
}

function renderErrorTemplate(payload, statusCode, errorRedirects) {
  // 1. Config redirect
  const statusRedirect = (errorRedirects || {})[String(statusCode)];
  if (statusRedirect) {
    const html = renderViewPartial(statusRedirect);
    if (html) return { html, status: 200 };
  }

  // 2. Status-specific template (e.g., views/401.p.hbs)
  const statusPartial = `${statusCode}.p.hbs`;
  const statusHtml = renderPartialFile(statusPartial, parseErrorData(payload, statusCode));
  if (statusHtml) return { html: statusHtml, status: statusCode };

  // 3. Generic error template
  const errorHtml = renderPartialFile("error.p.hbs", parseErrorData(payload, statusCode));
  if (errorHtml) return { html: errorHtml, status: statusCode };

  return null;
}

module.exports = {
  setProduction,
  setComponentViewMappings,
  hasViews,
  prefersJson,
  renderPartialFile,
  findPartialForCommand,
  renderCommandPartial,
  renderViewPartial,
  renderErrorTemplate,
  parseErrorData
};
