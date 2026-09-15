import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';

/**
 * Shared, complete readers used by both the mutation/snapshot paths and the
 * public list tools. A reader that cannot prove it fetched the whole resource
 * throws instead of silently returning a truncated state (which would make undo
 * unsound).
 */
export const READ_PAGE = 1000;
export const MAX_SAFE_PAGES = 25; // 25_000 rows
export const PROGRESS_FETCH_LIMIT = 20000;

export async function readAllLibrary(client: NuvioClient, profileId: number): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 0; page < MAX_SAFE_PAGES; page += 1) {
    const offset = page * READ_PAGE;
    const rows = await client.readRpc<unknown[]>('sync_pull_library', {
      p_profile_id: profileId,
      p_limit: READ_PAGE,
      p_offset: offset,
    });
    all.push(...rows);
    if (rows.length < READ_PAGE) return all;
  }
  throw new NuvioError(
    'Cannot create a complete reversible snapshot: library exceeds the safety limit of ' +
      `${MAX_SAFE_PAGES * READ_PAGE} rows.`
  );
}

export async function readAllWatchHistory(client: NuvioClient, profileId: number): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= MAX_SAFE_PAGES; page += 1) {
    const rows = await client.readRpc<unknown[]>('sync_pull_watched_items', {
      p_profile_id: profileId,
      p_page: page,
      p_page_size: READ_PAGE,
    });
    all.push(...rows);
    if (rows.length < READ_PAGE) return all;
  }
  throw new NuvioError(
    'Cannot create a complete reversible snapshot: watch history exceeds the safety limit of ' +
      `${MAX_SAFE_PAGES * READ_PAGE} rows.`
  );
}

/**
 * The backend exposes no pagination contract for watch progress. We request a
 * large batch; if it comes back full we cannot prove it is complete, so a
 * reversible mutation must refuse rather than snapshot a partial state.
 */
export async function readAllWatchProgress(
  client: NuvioClient,
  profileId: number,
  options: { requireComplete?: boolean } = {}
): Promise<unknown[]> {
  const rows = await client.readRpc<unknown[]>('sync_pull_watch_progress', {
    p_profile_id: profileId,
    p_limit: PROGRESS_FETCH_LIMIT,
  });
  if (options.requireComplete && rows.length >= PROGRESS_FETCH_LIMIT) {
    throw new NuvioError(
      'Cannot create a complete reversible snapshot: watch progress may be truncated at the fetch limit of ' +
        `${PROGRESS_FETCH_LIMIT}.`
    );
  }
  return rows;
}
