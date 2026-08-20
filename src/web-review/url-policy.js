import dns from "node:dns/promises";
import net from "node:net";

function isPrivateIpv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function isPrivateIpv6(address) {
  const value = address.toLowerCase().split("%")[0];
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("::ffff:")) return true;
  if (value.startsWith("fc") || value.startsWith("fd")) return true;
  if (value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb")) return true;
  if (value.startsWith("ff")) return true;
  if (value.startsWith("2001:db8:")) return true;
  return false;
}

export function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return false;
}

export async function assertSafeHttpUrl(rawUrl, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Web Review target must be a valid absolute URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Web Review only supports http:// and https:// targets.");
  }
  if (url.username || url.password) {
    throw new Error("Web Review URLs must not contain embedded credentials.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname) throw new Error("Web Review target is missing a hostname.");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    if (!allowPrivate) throw new Error("Private or local network targets are not allowed.");
  }

  if (!allowPrivate) {
    if (net.isIP(hostname)) {
      if (isPrivateAddress(hostname)) throw new Error("Private or local network targets are not allowed.");
    } else {
      let records;
      try {
        records = await dns.lookup(hostname, { all: true, verbatim: true });
      } catch (error) {
        throw new Error(`Could not resolve Web Review hostname ${hostname}: ${error.message}`);
      }
      if (!records.length) throw new Error(`Could not resolve Web Review hostname ${hostname}.`);
      if (records.some((record) => isPrivateAddress(record.address))) {
        throw new Error("Private or local network targets are not allowed.");
      }
    }
  }

  url.hash = "";
  return url.href;
}
