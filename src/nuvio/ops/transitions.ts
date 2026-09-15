import { historyKeyOf, libraryKeyOf, progressKeyOf, storedProgressKey } from '../keys.js';
import type {
  HistoryKey,
  LibraryItem,
  ProgressKey,
  WatchHistoryItem,
  WatchProgressEntry,
} from './library.js';

/**
 * Pure state transitions shared by the direct ops and the plan planners. Both
 * paths MUST produce the same `after` state and diff for the same inputs.
 * Timestamps are injected so several operations in one plan are deterministic.
 */

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

export interface Transition {
  after: Array<Record<string, unknown>>;
  diff: string[];
}

export function planLibraryAdd(
  before: Array<Record<string, unknown>>,
  items: LibraryItem[],
  now: number
): Transition {
  const after = structuredClone(before);
  const diff: string[] = [];
  for (const item of items) {
    const key = libraryKeyOf(item);
    const index = after.findIndex((i) => libraryKeyOf(i as unknown as LibraryItem) === key);
    const previous = index >= 0 ? after[index] : undefined;
    const merged = { ...previous, ...item, added_at: item.added_at ?? previous?.added_at ?? now };
    if (previous && same(previous, merged)) continue;
    diff.push(previous ? `~ update library item ${key}` : `+ library ${key}`);
    if (index >= 0) after[index] = merged as Record<string, unknown>;
    else after.push(merged as Record<string, unknown>);
  }
  return { after, diff };
}

export function planLibraryRemove(
  before: Array<Record<string, unknown>>,
  keys: Array<{ content_id: string; content_type: string }>
): Transition {
  const wanted = new Set(keys.map((k) => libraryKeyOf(k)));
  return {
    after: before.filter((i) => !wanted.has(libraryKeyOf(i as unknown as LibraryItem))),
    diff: keys.map((k) => `- library ${libraryKeyOf(k)}`),
  };
}

export function planProgressSet(
  before: Array<Record<string, unknown>>,
  entries: WatchProgressEntry[],
  now: number
): Transition {
  const after = structuredClone(before);
  const diff: string[] = [];
  for (const entry of entries) {
    const key = progressKeyOf(entry);
    const index = after.findIndex((p) => storedProgressKey(p) === key);
    const previous = index >= 0 ? after[index] : undefined;
    const merged = { ...previous, ...entry, last_watched: entry.last_watched ?? now };
    const scope = entry.season != null ? ` S${entry.season}E${entry.episode}` : '';
    if (previous && same(previous, merged)) continue;
    diff.push(
      `~ progress ${entry.content_type}:${entry.content_id}${scope} @ ${entry.position}/${entry.duration}`
    );
    if (index >= 0) after[index] = merged as Record<string, unknown>;
    else after.push(merged as Record<string, unknown>);
  }
  return { after, diff };
}

export function planProgressDelete(before: Array<Record<string, unknown>>, keys: ProgressKey[]): Transition {
  const wanted = new Set(keys.map((k) => progressKeyOf(k)));
  return {
    after: before.filter((p) => !wanted.has(progressKeyOf(p as unknown as ProgressKey))),
    diff: keys.map(
      (k) => `- watch progress ${k.content_id}${k.season != null ? ` S${k.season}E${k.episode}` : ''}`
    ),
  };
}

export function planHistoryAdd(
  before: Array<Record<string, unknown>>,
  items: WatchHistoryItem[],
  now: number
): Transition {
  const after = structuredClone(before);
  const diff: string[] = [];
  for (const item of items) {
    const key = historyKeyOf(item);
    const index = after.findIndex((i) => historyKeyOf(i as unknown as WatchHistoryItem) === key);
    const previous = index >= 0 ? after[index] : undefined;
    const merged = { ...previous, ...item, watched_at: item.watched_at ?? previous?.watched_at ?? now };
    if (previous && same(previous, merged)) continue;
    const scope = item.season != null ? ` S${item.season}E${item.episode}` : '';
    diff.push(
      previous
        ? `~ watched ${item.content_type}:${item.content_id}${scope}`
        : `+ watched ${item.content_type}:${item.content_id}${scope}`
    );
    if (index >= 0) after[index] = merged as Record<string, unknown>;
    else after.push(merged as Record<string, unknown>);
  }
  return { after, diff };
}

export function planHistoryDelete(before: Array<Record<string, unknown>>, keys: HistoryKey[]): Transition {
  const wanted = new Set(keys.map((k) => historyKeyOf(k)));
  return {
    after: before.filter((i) => !wanted.has(historyKeyOf(i as unknown as HistoryKey))),
    diff: keys.map(
      (k) => `- watch history ${k.content_id}${k.season != null ? ` S${k.season}E${k.episode}` : ''}`
    ),
  };
}
