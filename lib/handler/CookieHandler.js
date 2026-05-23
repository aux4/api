class CookieHandler {
  static setCookie(reply, config, commandOutput, production) {
    if (!config) return;

    try {
      const data = JSON.parse(commandOutput);
      const name = config.name || "token";
      const value = data[config.field || "token"];

      if (value) {
        reply.setCookie(name, value, {
          httpOnly: true,
          sameSite: "strict",
          secure: !!production,
          path: "/",
          ...(config.options || {})
        });
      }
    } catch {}
  }

  static clearCookie(reply, cookieName) {
    if (!cookieName) return;
    reply.clearCookie(cookieName, { path: "/" });
  }

  static extractCookieValue(commandOutput, config) {
    if (!config) return null;

    try {
      const data = JSON.parse(commandOutput);
      return data[config.field || "token"] || null;
    } catch {
      return null;
    }
  }
}

module.exports = CookieHandler;
