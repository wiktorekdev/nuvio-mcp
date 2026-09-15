const SECRET_KEY = /(password|passwd|secret|token|api[_-]?key|credential|authorization)/i;
/** Exact keys that are secret but not matched by SECRET_KEY (e.g. PIN). */
const SECRET_KEYS = new Set(['pin', 'current_pin', 'new_pin', 'old_pin', 'pincode', 'passcode']);
const NOT_SECRET = new Set(['origin_client_id']);

function shouldMask(key: string): boolean {
  const lower = key.toLowerCase();
  if (NOT_SECRET.has(lower)) return false;
  if (SECRET_KEYS.has(lower)) return true;
  return SECRET_KEY.test(lower);
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
