function normalizeIp(ip) {
  if (ip && ip.startsWith("::ffff:")) {
    return ip.substring(7);
  }
  return ip;
}

function parseCidr(cidr) {
  const [ip, prefixStr] = cidr.split("/");
  if (!prefixStr) return null;

  const prefix = parseInt(prefixStr, 10);
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return null;

  const ipNum = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;

  return { network: (ipNum & mask) >>> 0, mask };
}

function isIpAllowed(ip, allowedList) {
  if (!allowedList || allowedList.length === 0) return true;

  const normalizedIp = normalizeIp(ip);

  for (const entry of allowedList) {
    if (entry.includes("/")) {
      const cidr = parseCidr(entry);
      if (!cidr) continue;

      const parts = normalizedIp.split(".").map(Number);
      if (parts.length !== 4) continue;

      const ipNum = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
      if ((ipNum & cidr.mask) >>> 0 === cidr.network) return true;
    } else {
      if (normalizedIp === entry) return true;
    }
  }

  return false;
}

function ipAllowlist(securityConfig) {
  const allowedIPs = securityConfig?.allowedIPs;
  if (!allowedIPs || allowedIPs.length === 0) return null;

  return async (request, reply) => {
    // Skip /api/* routes — enforced in RestHandler with per-route support
    if (request.url.startsWith("/api/")) return;

    const ip = normalizeIp(request.ip);
    if (!isIpAllowed(ip, allowedIPs)) {
      return reply.status(403).send({
        message: "Forbidden",
        error: "IP not allowed",
        statusCode: 403
      });
    }
  };
}

module.exports = { ipAllowlist, isIpAllowed };
