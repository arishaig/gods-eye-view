import { BlockList, isIP } from 'node:net';

/**
 * Trusted reverse proxies (`GEV_TRUSTED_PROXIES`). Off by default.
 *
 * By default the server refuses every request carrying forwarding headers on
 * its cost-bearing endpoints and keys its rate limits on the socket peer: it is
 * a localhost tool, and a forwarding header there means the request did not
 * come from this machine. A deployment that deliberately puts its own reverse
 * proxy in front (TLS termination, single sign-on) names that proxy here, as a
 * comma-separated list of IP addresses and CIDR ranges:
 *
 *   GEV_TRUSTED_PROXIES=10.244.0.0/16
 *
 * Only a request whose socket peer is in this list has its forwarding headers
 * believed: `X-Forwarded-Proto`/`X-Forwarded-Host` for the same-origin check
 * and `X-Forwarded-For` for the rate-limit key. A peer outside the list is
 * treated exactly as before, so a client cannot opt itself in by sending the
 * headers. The credential panel and `/mcp` never trust a proxy.
 *
 * Every peer in the list can choose the client address and origin the server
 * sees, so list only proxies you run, and put authentication in front: anyone
 * the proxy admits can spend the configured provider quotas.
 */

/** Strip an IPv4-mapped IPv6 prefix so `::ffff:10.0.0.1` matches `10.0.0.0/8`. */
function normalizeAddress(address) {
  const raw = String(address ?? '').trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
  return mapped ? mapped[1] : raw;
}

/**
 * Parse a comma-separated list of IPs and CIDR ranges. Entries that are not a
 * valid address or range are skipped (reported through `onInvalid`), which can
 * only narrow trust, never widen it. Returns null for an empty list.
 *
 * @param {string|undefined|null} value
 * @param {{onInvalid?: (entry: string) => void}} [options]
 * @returns {BlockList|null}
 */
export function parseTrustedProxies(value, { onInvalid = () => {} } = {}) {
  const list = new BlockList();
  let count = 0;
  for (const entry of String(value ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const [address, prefixText, extra] = trimmed.split('/');
    const family = isIP(address);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    const maxPrefix = family === 6 ? 128 : 32;
    const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
    if (
      !family ||
      extra !== undefined ||
      !Number.isInteger(prefix) ||
      prefix < 0 ||
      prefix > maxPrefix ||
      (prefixText !== undefined && !/^\d+$/.test(prefixText))
    ) {
      onInvalid(trimmed);
      continue;
    }
    list.addSubnet(address, prefix, type);
    count += 1;
  }
  return count > 0 ? list : null;
}

/**
 * Whether `address` (a socket peer) is in `list`.
 * @param {string|undefined} address
 * @param {BlockList|null} list
 */
export function isTrustedProxy(address, list) {
  if (!list) return false;
  const normalized = normalizeAddress(address);
  const family = isIP(normalized);
  if (!family) return false;
  return list.check(normalized, family === 6 ? 'ipv6' : 'ipv4');
}

let cached;

/**
 * The configured list, read from `GEV_TRUSTED_PROXIES` on first use (after the
 * config factory has loaded .env into process.env) and kept for the life of
 * the process.
 * @returns {BlockList|null}
 */
export function configuredTrustedProxies() {
  if (cached === undefined) {
    cached = parseTrustedProxies(process.env.GEV_TRUSTED_PROXIES, {
      onInvalid: (entry) =>
        console.warn(
          `[TrustedProxy] Ignoring GEV_TRUSTED_PROXIES entry "${entry}": not an IP address or CIDR range`,
        ),
    });
  }
  return cached;
}

/** First comma-separated value of a header, trimmed and lower-cased. */
function firstHeaderValue(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const first = String(raw ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return first || undefined;
}

/**
 * How a request reached the server. For a peer outside the trusted list this
 * is the socket's own view and `trusted` is false. For a trusted proxy it is
 * the protocol and host the client used, from `X-Forwarded-Proto` and
 * `X-Forwarded-Host` (falling back to the socket protocol and `Host`).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {BlockList|null} [list]
 * @returns {{trusted: boolean, protocol: string, hostHeader: string|undefined}}
 */
export function requestView(req, list = configuredTrustedProxies()) {
  const socketProtocol = req.socket?.encrypted ? 'https:' : 'http:';
  const headers = req.headers || {};
  if (!isTrustedProxy(req.socket?.remoteAddress, list)) {
    return {
      trusted: false,
      protocol: socketProtocol,
      hostHeader: headers.host,
    };
  }
  const proto = firstHeaderValue(headers['x-forwarded-proto']);
  return {
    trusted: true,
    protocol:
      proto === 'http' || proto === 'https' ? `${proto}:` : socketProtocol,
    hostHeader: firstHeaderValue(headers['x-forwarded-host']) ?? headers.host,
  };
}

/**
 * The client address a trusted proxy reports: the rightmost `X-Forwarded-For`
 * hop that is not itself a trusted proxy. Hops to the left of it were written
 * by the client and are ignored. Falls back to the socket peer when the peer
 * is not trusted or the header names no untrusted hop.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {BlockList|null} [list]
 * @returns {string}
 */
export function clientAddress(req, list = configuredTrustedProxies()) {
  const peer = String(req.socket?.remoteAddress || 'local');
  if (!isTrustedProxy(peer, list)) return peer;
  const raw = req.headers?.['x-forwarded-for'];
  const hops = (Array.isArray(raw) ? raw.join(',') : String(raw ?? ''))
    .split(',')
    .map((hop) => normalizeAddress(hop))
    .filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i -= 1) {
    if (!isIP(hops[i])) return peer;
    if (!isTrustedProxy(hops[i], list)) return hops[i];
  }
  return peer;
}
