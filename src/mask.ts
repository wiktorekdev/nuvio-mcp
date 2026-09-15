const SECRET_KEY = /(password|passwd|secret|token|api[_-]?key|credential|authorization)/i;
const NOT_SECRET = new Set(['origin_client_id']);

function shouldMask(key: string): boolean {
  return !NOT_SECRET.has(key) && SECRET_KEY.test(key);
}

/** Mask a single secret, keeping a short suffix so operators can still tell values apart. */
export function maskSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '****';
  if (value.length <= 4) return '****';
  return `****${value.slice(-4)}`;
}

/** Recursively mask values under sensitive keys. Used before any output or log. */
export function maskDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = shouldMask(key) ? maskSecret(val) : maskDeep(val);
    }
    return out;
  }
  return value;
}
