import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
import type { ApplyResult } from '../types.js';
import {
  type HistoryKeyLike,
  type LibraryKeyLike,
  type ProgressKeyLike,
  historyKeyOf,
  libraryKeyOf,
  progressKeyOf,
  storedProgressKey,
} from '../keys.js';
import { readAllLibrary, readAllWatchHistory, readAllWatchProgress } from './readers.js';
import {
  planHistoryAdd,
  planHistoryDelete,
  planLibraryAdd,
  planLibraryRemove,
  planProgressDelete,
  planProgressSet,
} from './transitions.js';

export interface LibraryItem extends LibraryKeyLike {
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

export interface WatchProgressEntry extends ProgressKeyLike {
  content_type: string;
  video_id?: string | null;
  position: number;
  duration: number;
  last_watched?: number | null;
}

export interface WatchHistoryItem extends HistoryKeyLike {
  content_type: string;
  title?: string | null;
  watched_at?: number | null;
}

export type ProgressKey = ProgressKeyLike;
export type HistoryKey = HistoryKeyLike;

export { progressKeyOf, historyKeyOf };
export const historyKeyFrom = historyKeyOf;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
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
  apply: boolean,
  now = nowSeconds()
): Promise<ApplyResult<unknown[]>> {
  if (items.length === 0) throw new NuvioError('At least one item is required');
  const before = (await readAllLibrary(client, profileId)) as Array<Record<string, unknown>>;
  const { after, diff } = planLibraryAdd(before, items, now);
  if (apply && diff.length > 0) {
    const pushes = after.filter((row) => {
      const key = libraryKeyOf(row as unknown as LibraryItem);
      const prev = before.find((b) => libraryKeyOf(b as unknown as LibraryItem) === key);
      return !prev || JSON.stringify(prev) !== JSON.stringify(row);
    });
    await client.rpc('sync_push_library_items', {
      p_profile_id: profileId,
      p_items: pushes,
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
  const { after, diff } = planLibraryRemove(before, keys);
  // Always send the delete for the provided keys — the backend is the source of
  // truth, not the read page.
  if (apply) {
    await client.rpc('sync_delete_library_items', {
      p_profile_id: profileId,
      p_keys: keys,
      p_origin_client_id: originId,
    });
  }
  return { applied: apply, changed: keys.length > 0, before, after, diff };
}

export async function setWatchProgress(
  client: NuvioClient,
  profileId: number,
  entries: WatchProgressEntry[],
  originId: string,
  apply: boolean,
  now = nowSeconds()
): Promise<ApplyResult<unknown[]>> {
  if (entries.length === 0) throw new NuvioError('At least one entry is required');
  const before = (await readAllWatchProgress(client, profileId, { requireComplete: true })) as Array<
    Record<string, unknown>
  >;
  const { after, diff } = planProgressSet(before, entries, now);
  if (apply && diff.length > 0) {
    const pushes = after.filter((row) => {
      const prev = before.find((b) => storedProgressKey(b) === storedProgressKey(row));
      return !prev || JSON.stringify(prev) !== JSON.stringify(row);
    });
    await client.rpc('sync_push_watch_progress', {
      p_profile_id: profileId,
      p_entries: pushes,
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
  apply: boolean,
  now = nowSeconds()
): Promise<ApplyResult<unknown[]>> {
  if (items.length === 0) throw new NuvioError('At least one item is required');
  const before = (await readAllWatchHistory(client, profileId)) as Array<Record<string, unknown>>;
  const { after, diff } = planHistoryAdd(before, items, now);
  if (apply && diff.length > 0) {
    const pushes = after.filter((row) => {
      const prev = before.find(
        (b) => historyKeyOf(b as unknown as HistoryKey) === historyKeyOf(row as unknown as HistoryKey)
      );
      return !prev || JSON.stringify(prev) !== JSON.stringify(row);
    });
    await client.rpc('sync_push_watched_items', {
      p_profile_id: profileId,
      p_items: pushes,
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
  const before = (await readAllWatchProgress(client, profileId, { requireComplete: true })) as Array<
    Record<string, unknown>
  >;
  const { after, diff } = planProgressDelete(before, keys);
  const wanted = new Set(keys.map((k) => progressKeyOf(k)));
  const internalKeys = new Set<string>();
  for (const key of keys) internalKeys.add(progressKeyOf(key));
  for (const row of before) {
    if (wanted.has(progressKeyOf(row as unknown as ProgressKey))) internalKeys.add(storedProgressKey(row));
  }
  if (apply) {
    await client.rpc('sync_delete_watch_progress', {
      p_profile_id: profileId,
      p_keys: [...internalKeys],
      p_origin_client_id: originId,
    });
  }
  return { applied: apply, changed: keys.length > 0, before, after, diff };
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
  const { after, diff } = planHistoryDelete(before, keys);
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
  return { applied: apply, changed: keys.length > 0, before, after, diff };
}
