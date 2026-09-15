/**
 * Single source of truth for resource keys. Direct ops, plan planners and
 * snapshots must all agree, otherwise undo/redo would target different records.
 */

export interface ProgressKeyLike {
  content_id: string;
  season?: number | null;
  episode?: number | null;
}

export interface HistoryKeyLike {
  content_id: string;
  season?: number | null;
  episode?: number | null;
}

export interface LibraryKeyLike {
  content_id: string;
  content_type: string;
}

/** e.g. `tt1` for a movie, `tt1_s2e5` for an episode (episode defaults to 0). */
export function progressKeyOf(entry: ProgressKeyLike): string {
  return entry.season != null
    ? `${entry.content_id}_s${entry.season}e${entry.episode ?? 0}`
    : entry.content_id;
}

/** e.g. `tt1|2|5`; missing season/episode are encoded as -1. */
export function historyKeyOf(item: HistoryKeyLike): string {
  return `${item.content_id}|${item.season ?? -1}|${item.episode ?? -1}`;
}

export function libraryKeyOf(item: LibraryKeyLike): string {
  return `${item.content_type}:${item.content_id}`;
}

/** The stored progress key when the backend provides one, else the derived key. */
export function storedProgressKey(item: Record<string, unknown>): string {
  if (typeof item.progress_key === 'string' && item.progress_key) return item.progress_key;
  return progressKeyOf(item as unknown as ProgressKeyLike);
}
