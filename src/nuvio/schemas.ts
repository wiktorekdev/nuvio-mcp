import { z } from 'zod';
import { NuvioError } from './errors.js';

/**
 * Nuvio/Stremio accept addon/plugin URLs without an explicit scheme (implicitly
 * https) and list_addons/list_plugins return them verbatim. Accept both forms and
 * never normalise: the stored string must be matched exactly.
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

/**
 * Canonical argument schemas shared by the direct tools and `nuvio_apply_plan`.
 * A plan validates every operation against exactly the same Zod schema the
 * direct tool uses, so it can never accept arguments a direct call would reject.
 */
export const profile = z.number().int().min(1).max(6).default(1);
export const platform = z.string().default('tv');

export const settingsEditShape = {
  patch: z.record(z.string(), z.unknown()).optional().describe('Deep-merged into the settings tree.'),
  set: z
    .array(z.object({ path: z.string().min(1), value: z.unknown() }))
    .optional()
    .describe('Set nested values by dot path, applied after patch.'),
  unset: z.array(z.string().min(1)).optional().describe('Delete nested keys by dot path, applied last.'),
};

const settingsBase = { profile_id: profile, platform };
export const updateSettingsShape = { ...settingsBase, ...settingsEditShape };
export const getSettingsShape = { ...settingsBase };

export const addonAddShape = {
  profile_id: profile,
  url: z.url().describe('Addon manifest URL'),
  name: z.string().optional(),
  enabled: z.boolean().optional().default(true),
  sort_order: z.number().int().optional(),
};

export const addonUpdateShape = {
  profile_id: profile,
  url: schemeTolerantUrl.optional(),
  id: z.uuid().optional(),
  name: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  sort_order: z.number().int().optional(),
};

export const addonReorderShape = {
  profile_id: profile,
  ordered_urls: z.array(schemeTolerantUrl).min(1),
};

export const addonRemoveShape = {
  profile_id: profile,
  url: schemeTolerantUrl.optional(),
  id: z.uuid().optional(),
};

export const pluginAddShape = {
  profile_id: profile,
  url: z.url(),
  name: z.string().optional(),
  repo_type: z.string().optional(),
  enabled: z.boolean().optional().default(true),
};

export const pluginUpdateShape = {
  profile_id: profile,
  url: schemeTolerantUrl.optional(),
  id: z.uuid().optional(),
  name: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  repo_type: z.string().nullable().optional(),
  sort_order: z.number().int().optional(),
};

export const pluginReorderShape = { profile_id: profile, ordered_urls: z.array(schemeTolerantUrl).min(1) };
export const pluginRemoveShape = {
  profile_id: profile,
  url: schemeTolerantUrl.optional(),
  id: z.uuid().optional(),
};

export const providerSetShape = {
  profile_id: profile,
  provider: z.string().describe('One of the supported provider ids'),
  api_key: z.string().min(1).describe('API key / client id value'),
};
export const providerDeleteShape = { profile_id: profile, provider: z.string() };

export const libraryItemSchema = z.object({
  content_id: z.string().min(1),
  content_type: z.string().min(1),
  name: z.string().nullable().optional(),
  poster: z.string().nullable().optional(),
  poster_shape: z.string().nullable().optional(),
  background: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  release_info: z.string().nullable().optional(),
  imdb_rating: z.number().nullable().optional(),
  genres: z.array(z.string()).nullable().optional(),
  addon_base_url: z.string().nullable().optional(),
  added_at: z.number().int().nullable().optional(),
});
export const libraryAddShape = { profile_id: profile, items: z.array(libraryItemSchema).min(1) };
export const libraryRemoveShape = {
  profile_id: profile,
  keys: z.array(z.object({ content_id: z.string().min(1), content_type: z.string().min(1) })).min(1),
};

export const progressKeySchema = z.object({
  content_id: z.string().min(1),
  season: z.number().int().nullable().optional(),
  episode: z.number().int().nullable().optional(),
});
export const progressEntrySchema = z.object({
  content_id: z.string().min(1),
  content_type: z.string().min(1),
  video_id: z.string().nullable().optional(),
  season: z.number().int().nullable().optional(),
  episode: z.number().int().nullable().optional(),
  position: z.number(),
  duration: z.number(),
  last_watched: z.number().int().nullable().optional(),
});
export const progressSetShape = { profile_id: profile, entries: z.array(progressEntrySchema).min(1) };
export const progressDeleteShape = { profile_id: profile, keys: z.array(progressKeySchema).min(1) };

export const historyItemSchema = z.object({
  content_id: z.string().min(1),
  content_type: z.string().min(1),
  title: z.string().nullable().optional(),
  season: z.number().int().nullable().optional(),
  episode: z.number().int().nullable().optional(),
  watched_at: z.number().int().nullable().optional(),
});
export const historyAddShape = { profile_id: profile, items: z.array(historyItemSchema).min(1) };
export const historyDeleteShape = { profile_id: profile, keys: z.array(progressKeySchema).min(1) };

/** Validation shared by direct addon/plugin tools and plans: exactly one of url/id when identifying. */
export function assertTarget(tool: string, args: { url?: string; id?: string }, requireOne = true): void {
  if (requireOne && !args.url && !args.id) {
    throw new NuvioError(`${tool}: provide either url or id to identify the item.`);
  }
}
