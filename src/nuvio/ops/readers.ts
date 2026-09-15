import type { NuvioClient } from '../client.js';

/**
 * Shared, complete readers used by both the mutation/snapshot paths and the
 * public list tools. Pagination lives here only once; the per-call cache means a
 * snapshot read and an ops read within the same call share these requests.
 */
export const READ_PAGE = 1000;
export const READ_MAX_ROWS = 20000;

export async function readAllLibrary(client: NuvioClient, profileId: number): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let offset = 0; offset < READ_MAX_ROWS; offset += READ_PAGE) {
    const page = await client.readRpc<unknown[]>('sync_pull_library', {
      p_profile_id: profileId,
      p_limit: READ_PAGE,
      p_offset: offset,
    });
    all.push(...page);
    if (page.length < READ_PAGE) break;
  }
  return all;
}

export async function readAllWatchProgress(client: NuvioClient, profileId: number): Promise<unknown[]> {
  return client.readRpc('sync_pull_watch_progress', { p_profile_id: profileId, p_limit: READ_MAX_ROWS });
}

export async function readAllWatchHistory(client: NuvioClient, profileId: number): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; (page - 1) * READ_PAGE < READ_MAX_ROWS; page += 1) {
    const rows = await client.readRpc<unknown[]>('sync_pull_watched_items', {
      p_profile_id: profileId,
      p_page: page,
      p_page_size: READ_PAGE,
    });
    all.push(...rows);
    if (rows.length < READ_PAGE) break;
  }
  return all;
}
