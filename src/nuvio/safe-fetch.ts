import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { NuvioError } from './errors.js';

/**
 * Fetches a JSON document from a user-supplied URL without allowing server-side
 * request forgery: only http(s), no loopback/private/link-local/multicast targets,
 * DNS re-resolution checked on every hop, redirects followed manually with the same
 * checks, a hard timeout and a response-size cap.
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_REDIRECTS = 3;

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // fc00::/7 ULA
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  if (lower.startsWith('ff')) return true; // multicast
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

/** True when `ip` is not a globally routable unicast address. */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true;
}

async function assertPublicHost(hostname: string): Promise<void> {
  const literal = hostname.replace(/^\[|\]$/g, '');
  if (isIP(literal)) {
    if (isPrivateAddress(literal)) {
      throw new NuvioError(`Refusing to fetch a private/loopback address: ${hostname}`);
    }
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    throw new NuvioError(`Could not resolve host: ${hostname}`);
  }
  if (addresses.length === 0) throw new NuvioError(`Could not resolve host: ${hostname}`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new NuvioError(`Refusing to fetch a host that resolves to a private address: ${hostname}`);
    }
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new NuvioError('Response body is too large');
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new NuvioError('Response body is too large');
  return buffer.toString('utf8');
}

export async function fetchJsonFromPublicUrl(
  rawUrl: string,
  options: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number } = {}
): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      throw new NuvioError(`Invalid URL: ${current}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new NuvioError('Only http(s) URLs are supported');
    }
    await assertPublicHost(url.hostname);

    const res = await fetch(url, {
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((error) => {
      throw new NuvioError(`Fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new NuvioError(`Redirect without a Location header [http ${res.status}]`);
      current = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw new NuvioError(`Fetch failed [http ${res.status}]`);

    const text = await readCapped(res, maxBytes);
    try {
      return JSON.parse(text);
    } catch {
      throw new NuvioError('Response was not valid JSON');
    }
  }
  throw new NuvioError('Too many redirects');
}
