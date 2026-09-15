import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
import type { ApplyResult } from '../types.js';

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

export interface WatchedItem {
  content_id: string;
  content_type: string;
  title?: string | null;
  season?: number | null;
  episode?: number | null;
  watched_at?: number | null;
}

export async function getLibrary(
  client: NuvioClient,
  profileId: number,
  limit = 100,
  offset = 0
): Promise<unknown[]> {
  return client.rpc('sync_pull_library', { p_profile_id: profileId, p_limit: limit, p_offset: offset });
}

export async function getWatchProgress(
  client: NuvioClient,
  profileId: number,
  limit = 100
): Promise<unknown[]> {
  return client.rpc('sync_pull_watch_progress', { p_profile_id: profileId, p_limit: limit });
}

export async function getWatchHistory(
  client: NuvioClient,
  profileId: number,
  page = 1,
  pageSize = 100
): Promise<unknown[]> {
  return client.rpc('sync_pull_watched_items', {
    p_profile_id: profileId,
    p_page: page,
    p_page_size: pageSize,
  });
}

export async function addToLibrary(
  client: NuvioClient,
  profileId: number,
  item: LibraryItem,
  originId: string,
  apply: boolean
): Promise<ApplyResult<unknown[]>> {
  if (!item.content_id || !item.content_type) {
    throw new NuvioError('content_id and content_type are required');
  }
  const before = await getLibrary(client, profileId, 1000, 0);
  const exists = (before as Array<Record<string, unknown>>).some(
    (i) => i.content_id === item.content_id && i.content_type === item.content_type
  );
  if (apply) {
    await client.rpc('sync_push_library_items', {
      p_profile_id: profileId,
      p_items: [{ ...item, added_at: item.added_at ?? Math.floor(Date.now() / 1000) }],
      p_origin_client_id: originId,
    });
  }
  return {
    applied: apply,
    changed: true,
    before,
    after: before,
    diff: [
      exists
        ? `~ update library item ${item.content_type}:${item.content_id}`
        : `+ library ${item.content_type}:${item.content_id}`,
    ],
  };
}

export async function removeFromLibrary(
  client: NuvioClient,
  profileId: number,
  keys: Array<{ content_id: string; content_type: string }>,
  originId: string,
  apply: boolean
): Promise<ApplyResult<unknown[]>> {
  if (keys.length === 0) throw new NuvioError('At least one key is required');
  const before = await getLibrary(client, profileId, 1000, 0);
  if (apply) {
    await client.rpc('sync_delete_library_items', {
      p_profile_id: profileId,
      p_keys: keys,
      p_origin_client_id: originId,
    });
  }
  return {
    applied: apply,
    changed: true,
    before,
    after: before,
    diff: keys.map((k) => `- library ${k.content_type}:${k.content_id}`),
  };
}

export async function setWatchProgress(
  client: NuvioClient,
  profileId: number,
  entry: WatchProgressEntry,
  originId: string,
  apply: boolean
): Promise<ApplyResult<unknown[]>> {
  if (!entry.content_id || !entry.content_type) {
    throw new NuvioError('content_id and content_type are required');
  }
  const before = await getWatchProgress(client, profileId, 1000);
  if (apply) {
    await client.rpc('sync_push_watch_progress', {
      p_profile_id: profileId,
      p_entries: [{ ...entry, last_watched: entry.last_watched ?? Math.floor(Date.now() / 1000) }],
      p_origin_client_id: originId,
    });
  }
  const scope = entry.season != null ? ` S${entry.season}E${entry.episode}` : '';
  return {
    applied: apply,
    changed: true,
    before,
    after: before,
    diff: [
      `~ progress ${entry.content_type}:${entry.content_id}${scope} @ ${entry.position}/${entry.duration}`,
    ],
  };
}

export async function markWatched(
  client: NuvioClient,
  profileId: number,
  item: WatchedItem,
  originId: string,
  apply: boolean
): Promise<ApplyResult<unknown[]>> {
  if (!item.content_id || !item.content_type) {
    throw new NuvioError('content_id and content_type are required');
  }
  const before = await getWatchHistory(client, profileId, 1, 1000);
  if (apply) {
    await client.rpc('sync_push_watched_items', {
      p_profile_id: profileId,
      p_items: [{ ...item, watched_at: item.watched_at ?? Math.floor(Date.now() / 1000) }],
      p_origin_client_id: originId,
    });
  }
  const scope = item.season != null ? ` S${item.season}E${item.episode}` : '';
  return {
    applied: apply,
    changed: true,
    before,
    after: before,
    diff: [`~ watched ${item.content_type}:${item.content_id}${scope}`],
  };
}

export async function deleteWatchProgress(
  client: NuvioClient,
  profileId: number,
  keys: unknown[],
  originId: string,
  apply: boolean
): Promise<ApplyResult<unknown[]>> {
  const before = await getWatchProgress(client, profileId, 1000);
  if (apply) {
    await client.rpc('sync_delete_watch_progress', {
      p_profile_id: profileId,
      p_keys: keys,
      p_origin_client_id: originId,
    });
  }
  return {
    applied: apply,
    changed: keys.length > 0,
    before,
    after: before,
    diff: keys.map((k) => `- watch progress ${JSON.stringify(k)}`),
  };
}

export async function deleteWatchHistory(
  client: NuvioClient,
  profileId: number,
  keys: unknown[],
  originId: string,
  apply: boolean
): Promise<ApplyResult<unknown[]>> {
  const before = await getWatchHistory(client, profileId, 1, 1000);
  if (apply) {
    await client.rpc('sync_delete_watched_items', {
      p_profile_id: profileId,
      p_keys: keys,
      p_origin_client_id: originId,
    });
  }
  return {
    applied: apply,
    changed: keys.length > 0,
    before,
    after: before,
    diff: keys.map((k) => `- watch history ${JSON.stringify(k)}`),
  };
}
