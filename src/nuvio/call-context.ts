import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-MCP-call cache. A single tool invocation may read the same resource more
 * than once (once for the mandatory pre-change snapshot, once inside the ops).
 * Wrapping the whole invocation in `withCallCache` lets those reads share one
 * backend request instead of hitting the API twice.
 *
 * AsyncLocalStorage keeps the cache scoped to the call even when the HTTP
 * transport handles many calls concurrently.
 */
interface CallStore {
  cache: Map<string, Promise<unknown>>;
}

const storage = new AsyncLocalStorage<CallStore>();

export function withCallCache<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ cache: new Map() }, fn);
}

/** Memoize a read for the duration of the current call. Falls back to a plain call with no scope. */
export function callCache<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const store = storage.getStore();
  if (!store) return loader();
  const existing = store.cache.get(key);
  if (existing) return existing as Promise<T>;
  const pending = loader().catch((error: unknown) => {
    store.cache.delete(key);
    throw error;
  });
  store.cache.set(key, pending);
  return pending;
}
