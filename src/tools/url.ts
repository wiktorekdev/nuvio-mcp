import { z } from 'zod';

/**
 * Nuvio/Stremio accept addon/plugin URLs without an explicit scheme (implicitly
 * https) and `list_addons`/`list_plugins` return them verbatim. `z.url()` rejects
 * those strings, which made it impossible to pass a stored scheme-less URL back
 * to reorder/toggle/remove/update (a read/write round-trip deadlock).
 *
 * This accepts both a real http(s) URL and a scheme-less host/path. It deliberately
 * does not normalise the value: the stored string must be matched exactly.
 */
const SCHEME_LESS_URL = /^[^\s/]+\.[^\s/]+(?::\d+)?(?:\/\S*)?$/;

export const schemeTolerantUrl = z
  .string()
  .trim()
  .min(1)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return SCHEME_LESS_URL.test(value);
    }
  }, 'Expected an http(s) URL, or a host/path without a scheme');
