// Shared helper for building the shell-safe argument strings appended to a
// route's configured command. Client-supplied values (query, headers,
// principal, path params, ...) are NEVER interpolated into shell syntax —
// each is JSON-stringified and passed as the value of a single, fixed
// `--flag` the route command declares as a variable (see RestHandler, which
// uses the same pattern). The client supplies no argv or shell text of its
// own; it only supplies values that land inside a quoted JSON blob.
function escapeShellArg(str) {
  return str.replace(/[\r\n]/g, " ").replace(/'/g, "'\\''");
}

// Builds `--flag '<json>'` for a value, skipping empty/absent values.
function jsonFlag(flag, value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && Object.keys(value).length === 0) return null;
  const json = typeof value === "string" ? value : JSON.stringify(value);
  return `--${flag} '${escapeShellArg(json)}'`;
}

module.exports = { escapeShellArg, jsonFlag };
