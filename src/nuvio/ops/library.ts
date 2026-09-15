import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
import type { ApplyResult } from '../types.js';
import { readAllLibrary, readAllWatchHistory, readAllWatchProgress } from './readers.js';

export interface LibraryItem {
  content_id: string;
  content_type: string;
  name?: string | null;
  poster?: string | null;
  poster_shape?: string | null;
  background?: string | null;
  description?: string | null;
  release_info?: string | null;
  imdb_rating?: number | null;
  genres?: string[] | null;
  addon_base_url?: string | null;
  added_at?: number | null;
}

export interface WatchProgressEntry {
  content_id: string;
  content_type: string;
  video_id?: string | null;
  season?: number | null;
  episode?: number | null;
  position: number;
  duration: number;
  last_watched?: number | null;
}

export interface WatchHistoryItem {
  content_id: string;
  content_type: string;
  title?: string | null;
  season?: number | null;
  episode?: number | null;
  watched_at?: number | null;
}

export interface ProgressKey {
  content_id: string;
  season?: number | null;
  episode?: number | null;
}

export interface HistoryKey {
  content_id: string;
  season?: number | null;
  episode?: number | null;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The public progress key: content id plus episode coordinates where relevant. */
export function progressKeyOf(entry: ProgressKey): string {
  return entry.season != null
    ? `${entry.content_id}_s${entry.season}e${entry.episode ?? 0}`
    : entry.content_id;
}

export function historyKeyOf(item: HistoryKey): string {
  return `${item.content_id}|${item.season ?? -1}|${item.episode ?? -1}`;
}

/** Public alias used by tests/consumers. */
export const historyKeyFrom = historyKeyOf;

function storedProgressKey(item: Record<string, unknown>): string {
  if (typeof item.progress_key === 'string' && item.progress_key) return item.progress_key;
  return progressKeyOf(item as unknown as ProgressKey);
}

function requireKeys(item: { content_id?: string; content_type?: string }, what: string): void {
  if (!item.content_id || !item.content_type) {
    throw new NuvioError(`${what}: content_id and content_type are required`);
  }
}

// ---------------------------------------------------------------------------
// Reads (public list tools keep their own pagination shape)
// ---------------------------------------------------------------------------

export async function getLibrary(
  client: NuvioClient,
  profileId: number,
  limit = 100,
  offset = 0
): Promise<unknown[]> {
  return client.readRpc('sync_pull_library', { p_profile_id: profileId, p_limit: limit, p_offset: offset });
}

export async function getWatchProgress(
  client: NuvioClient,
  profileId: number,
  limit = 100
): Promise<unknown[]> {
  return client.readRpc('sync_pull_watch_progress', { p_profile_id: profileId, p_limit: limit });
}

export async function getWatchHistory(
  client: NuvioClient,
  profileId: number,
  page = 1,
  pageSize = 100
): Promise<unknown[]> {
  return client.readRpc('sync_pull_watched_items', {
    p_profile_id: profileId,
    p_page: page,
    p_page_size: pageSize,
  });
}

// ---------------------------------------------------------------------------
// Mutations (complete readers; deletes are not gated on a first page)
// ---------------------------------------------------------------------------

export async function addToLibrary(
  client: NuvioClient,
  profileId: number,
  items: LibraryItem[],
  originId: string,
  apply: boolean
): Promise<ApplyResult<unknown[]>> {
  if (items.length === 0) throw new NuvioError('At least one item is required');
  for (const item of items) requireKeys(item, 'add_to_library');
  const before = (await readAllLibrary(client, profileId)) as Array<Record<string, unknown>>;
  const byKey = new Map(before.map((i) => [`${i.content_type}:${i.content_id}`, i]));
  const after = structuredClone(before);
  const diff: string[] = [];
  const toPush: LibraryItem[] = [];
  for (const item of items) {
    const key = `${item.content_type}:${item.content_id}`;
    const previous = byKey.get(key);
    const merged = { ...previous, ...item, added_at: item.added_at ?? previous?.added_at ?? nowSeconds() };
    if (previous && same(previous, merged)) continue;
    diff.push(previous ? `~ update library item ${key}` : `+ library ${key}`);
    const index = after.findIndex((i) => `${i.content_type}:${i.content_id}` === key);
    if (index >= 0) after[index] = merged as Record<string, unknown>;
    else after.push(merged as Record<string, unknown>);
    toPush.push(merged as LibraryItem);
  }
  if (apply && toPush.length > 0) {
    await client.rpc('sync_push_library_items', {
      p_profile_id: profileId,
      p_items: toPush,
      p_origin_client_id: originId,
    });
  }
  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

export async function removeFromLibrary(
  client: NuvioClient,
  profileId: number,
  keys: Array<{ content_id: string; content_type: string }>,
  originId: string,
  apply: boolean
): Promise<ApplyResult<unknown[]>> {
  if (keys.length === 0) throw new NuvioError('At least one key is required');
  const before = (await readAllLibrary(client, profileId)) as Array<Record<string, unknown>>;
  const wanted = new Set(keys.map((k) => `${k.content_type}:${k.content_id}`));
  // Always send the delete for the provided keys — the backend is the source of
  // truth, not the read page. This makes items beyond any page boundary deletable.
  if (apply) {
    await client.rpc('sync_delete_library_items', {
      p_profile_id: profileId,
      p_keys: keys,
      p_origin_client_id: originId,
    });
  }
  return {
    applied: apply,
    changed: keys.length > 0,
    before,
    after: before.filter((i) => !wanted.has(`${i.content_type}:${i.content_id}`)),
    diff: keys.map((k) => `- library ${k.content_type}:${k.content_id}`),
  };
}

export async function setWatchProgress(
  client: NuvioClient,
  profileId: number,
  entries: WatchProgressEntry[],
  originId: string,
  apply: boolean
): Promise<ApplyResult<unknown[]>> {
  if (entries.length === 0) throw new NuvioError('At least one entry is required');
  for (const entry of entries) requireKeys(entry, 'set_watch_progress');
  const before = (await readAllWatchProgress(client, profileId)) as Array<Record<string, unknown>>;
  const byKey = new Map(before.map((p) => [storedProgressKey(p), p]));
  const after = structuredClone(before);
  const diff: string[] = [];
  const toPush: WatchProgressEntry[] = [];
  for (const entry of entries) {
    const key = progressKeyOf(entry);
    const previous = byKey.get(key);
    const merged = { ...previous, ...entry, last_watched: entry.last_watched ?? nowSeconds() };
    const scope = entry.season != null ? ` S${entry.season}E${entry.episode}` : '';
    if (previous && same(previous, merged)) continue;
    diff.push(
      `~ progress ${entry.content_type}:${entry.content_id}${scope} @ ${entry.position}/${entry.duration}`
    );
    const index = after.findIndex((p) => storedProgressKey(p) === key);
    if (index >= 0) after[index] = merged as Record<string, unknown>;
    else after.push(merged as Record<string, unknown>);
    toPush.push(merged as WatchProgressEntry);
  }
  if (apply && toPush.length > 0) {
    await client.rpc('sync_push_watch_progress', {
      p_profile_id: profileId,
      p_entries: toPush,
      p_origin_client_id: originId,
    });
  }
  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

export async function addToWatchHistory(
  client: NuvioClient,
  profileId: number,
  items: WatchHistoryItem[],
  originId: string,
  apply: boolean
): Promise<ApplyResult<unknown[]>> {
  if (items.length === 0) throw new NuvioError('At least one item is required');
  for (const item of items) requireKeys(item, 'add_to_watch_history');
  const before = (await readAllWatchHistory(client, profileId)) as Array<Record<string, unknown>>;
  const existing = new Map(before.map((i) => [historyKeyOf(i as unknown as HistoryKey), i]));
  const after = structuredClone(before);
  const diff: string[] = [];
  const toPush: WatchHistoryItem[] = [];
  for (const item of items) {
    const key = historyKeyOf(item);
    const previous = existing.get(key);
    const merged = {
      ...previous,
      ...item,
      watched_at: item.watched_at ?? previous?.watched_at ?? nowSeconds(),
    };
    if (previous && same(previous, merged)) continue;
    const scope = item.season != null ? ` S${item.season}E${item.episode}` : '';
    diff.push(
      previous
        ? `~ watched ${item.content_type}:${item.content_id}${scope}`
        : `+ watched ${item.content_type}:${item.content_id}${scope}`
    );
    const index = after.findIndex((i) => historyKeyOf(i as unknown as HistoryKey) === key);
    if (index >= 0) after[index] = merged as Record<string, unknown>;
    else after.push(merged as Record<string, unknown>);
    toPush.push(merged as WatchHistoryItem);
  }
  if (apply && toPush.length > 0) {
    await client.rpc('sync_push_watched_items', {
      p_profile_id: profileId,
      p_items: toPush,
      p_origin_client_id: originId,
    });
  }
  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

export async function deleteWatchProgress(
  client: NuvioClient,
  profileId: number,
  keys: ProgressKey[],
  originId: string,
  apply: boolean
): Promise<ApplyResult<unknown[]>> {
  if (keys.length === 0) throw new NuvioError('At least one key is required');
  const before = (await readAllWatchProgress(client, profileId)) as Array<Record<string, unknown>>;
  const wanted = new Set(keys.map((k) => progressKeyOf(k)));
  // Derive the internal key from the structured key so a record outside the read
  // batch is still deletable; include any stored key we did observe.
  const internalKeys = new Set<string>();
  for (const key of keys) internalKeys.add(progressKeyOf(key));
  for (const row of before) {
    const stored = storedProgressKey(row);
    if (wanted.has(progressKeyOf(row as unknown as ProgressKey))) internalKeys.add(stored);
  }
  if (apply) {
    await client.rpc('sync_delete_watch_progress', {
      p_profile_id: profileId,
      p_keys: [...internalKeys],
      p_origin_client_id: originId,
    });
  }
  return {
    applied: apply,
    changed: keys.length > 0,
    before,
    after: before.filter((p) => !wanted.has(progressKeyOf(p as unknown as ProgressKey))),
    diff: keys.map(
      (k) => `- watch progress ${k.content_id}${k.season != null ? ` S${k.season}E${k.episode}` : ''}`
    ),
  };
}

export async function deleteWatchHistory(
  client: NuvioClient,
  profileId: number,
  keys: HistoryKey[],
  originId: string,
  apply: boolean
): Promise<ApplyResult<unknown[]>> {
  if (keys.length === 0) throw new NuvioError('At least one key is required');
  const before = (await readAllWatchHistory(client, profileId)) as Array<Record<string, unknown>>;
  const wanted = new Set(keys.map((k) => historyKeyOf(k)));
  if (apply) {
    await client.rpc('sync_delete_watched_items', {
      p_profile_id: profileId,
      p_keys: keys.map((k) => ({
        content_id: k.content_id,
        season: k.season ?? null,
        episode: k.episode ?? null,
      })),
      p_origin_client_id: originId,
    });
  }
  return {
    applied: apply,
    changed: keys.length > 0,
    before,
    after: before.filter((i) => !wanted.has(historyKeyOf(i as unknown as HistoryKey))),
    diff: keys.map(
      (k) => `- watch history ${k.content_id}${k.season != null ? ` S${k.season}E${k.episode}` : ''}`
    ),
  };
}
