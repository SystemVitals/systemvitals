import * as net from "node:net";
import * as dns from "node:dns";

/**
 * Returns true if the given IP address (v4 or v6) is in a private/reserved range
 * that should be blocked for SSRF protection:
 * - IPv4 unspecified/this-network: 0.0.0.0/8
 * - IPv4 loopback: 127.0.0.0/8
 * - IPv4 private: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * - IPv4 link-local/metadata: 169.254.0.0/16
 * - IPv6 loopback: ::1
 * - IPv6 unspecified: ::
 * - IPv6 ULA: fc00::/7 (fc** and fd**)
 * - IPv6 link-local: fe80::/10
 */
export function isBlockedHost(ip: string): boolean {
  const version = net.isIP(ip);

  if (version === 4) {
    const octets = ip.split(".").map(Number);
    if (octets.length !== 4) return false;
    const [a, b, c, d] = octets;

    // 0.0.0.0/8 — unspecified / this-network (covers 0.0.0.0, 0.1.2.3, etc.)
    if (a === 0) return true;

    // 127.0.0.0/8 — loopback
    if (a === 127) return true;

    // 10.0.0.0/8 — private
    if (a === 10) return true;

    // 172.16.0.0/12 — private (172.16 – 172.31)
    if (a === 172 && b >= 16 && b <= 31) return true;

    // 192.168.0.0/16 — private
    if (a === 192 && b === 168) return true;

    // 169.254.0.0/16 — link-local / cloud metadata (AWS IMDSv1/v2)
    if (a === 169 && b === 254) return true;

    return false;
  }

  if (version === 6) {
    const lower = ip.toLowerCase();

    // IPv4-mapped ::ffff:<ip>
    if (/^::ffff:/i.test(ip)) {
      const embedded = ip.slice(7); // everything after "::ffff:"
      // Could be dotted-quad (e.g. "169.254.169.254") or hex (e.g. "a9fe:a9fe")
      if (net.isIP(embedded) === 4) {
        // dotted-quad form — recurse directly
        return isBlockedHost(embedded);
      }
      // hex form — two colon-separated hextets
      const parts = embedded.split(":");
      if (parts.length === 2) {
        const hi = parseInt(parts[0], 16);
        const lo = parseInt(parts[1], 16);
        const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isBlockedHost(dotted);
      }
    }

    // NAT64 64:ff9b::<ip>
    if (/^64:ff9b::/i.test(ip)) {
      const suffix = ip.slice(9); // everything after "64:ff9b::"
      if (net.isIP(suffix) === 4) {
        return isBlockedHost(suffix);
      }
      const parts = suffix.split(":");
      if (parts.length === 2) {
        const hi = parseInt(parts[0], 16);
        const lo = parseInt(parts[1], 16);
        const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isBlockedHost(dotted);
      }
    }

    // ::1 — loopback
    if (lower === "::1") return true;

    // :: — unspecified
    if (lower === "::") return true;

    // Expand partial representation to check prefixes.
    // fc00::/7 — ULA (fc** and fd** in the first octet pair)
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;

    // fe80::/10 — link-local (fe80 through fe**  where bits 10-11 are 10)
    // fe80::/10 covers fe80 – feBF (first 10 bits: 1111 1110 10)
    // Simplification: fe8x, fe9x, feax, febx
    if (/^fe[89ab]/i.test(lower)) return true;

    return false;
  }

  // Not a recognized IP — do not block (let DNS resolution handle it)
  return false;
}

/**
 * Assert that the given URL target is allowed (not SSRF-blocked).
 * - If allowPrivate is true, always resolves (opt-out, e.g. for tests).
 * - If the host is an IP literal, checks it directly.
 * - Otherwise resolves all DNS addresses and blocks if ANY is private.
 * Throws Error('blocked target: <host>') if blocked.
 */
export async function assertTargetAllowed(url: string, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return;

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    // Malformed URL — treat as blocked
    throw new Error(`blocked target: malformed URL: ${url}`);
  }

  const host = parsedUrl.hostname;

  // Strip IPv6 brackets if present (URL.hostname includes them: "[::1]")
  const rawHost = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;

  // If it's an IP literal, check directly
  if (net.isIP(rawHost) !== 0) {
    if (isBlockedHost(rawHost)) {
      throw new Error(`blocked target: ${rawHost}`);
    }
    return;
  }

  // Hostname — resolve all addresses and block if any is private
  const addresses = await dns.promises.lookup(rawHost, { all: true });
  for (const { address } of addresses) {
    if (isBlockedHost(address)) {
      throw new Error(`blocked target: ${rawHost} resolves to a private/reserved address (${address})`);
    }
  }
}
