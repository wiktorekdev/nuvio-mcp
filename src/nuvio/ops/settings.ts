import type { NuvioClient } from '../client.js';
import type { ApplyResult, HomeCatalogSettings, Platform, SettingsBlob } from '../types.js';
import { setPath, unsetPath, getPath } from '../paths.js';

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function assertSafeKey(key: string): void {
  if (UNSAFE_KEYS.has(key)) throw new Error(`Unsafe path segment: ${key}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Deep-merge a patch into a base value.
 * - object + object -> recursive merge
 * - array -> replace the whole array
 * - scalar / type mismatch -> replace the subtree
 * - null is a normal value (it replaces)
 * Deletion only happens through `unset`, never by merging.
 */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(patch)) {
    const out: Record<string, unknown> = clone(base);
    for (const [key, value] of Object.entries(patch)) {
      assertSafeKey(key);
      out[key] = Object.prototype.hasOwnProperty.call(base, key) ? deepMerge(base[key], value) : clone(value);
    }
    return out;
  }
  return clone(patch);
}

export interface SettingsPatch {
  patch?: Record<string, unknown>;
  set?: Array<{ path: string; value: unknown }>;
  unset?: string[];
}

function truncate(value: string | undefined, max = 160): string {
  if (value === undefined) return 'undefined';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function leaf(value: unknown): string {
  return value === undefined ? 'undefined' : truncate(JSON.stringify(value));
}

/** Precise leaf-level diff between two settings trees (arrays are treated as leaves). */
export function diffTree(before: unknown, after: unknown, path = '', out: string[] = []): string[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return out;
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      diffTree(before[key], after[key], path ? `${path}.${key}` : key, out);
    }
    return out;
  }
  out.push(`~ ${path || '(root)'}: ${leaf(before)} -> ${leaf(after)}`);
  return out;
}

export interface SettingsEdit {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  diff: string[];
}

/** Apply patch -> set -> unset (in that order) to a settings tree. Pure. */
export function applySettingsEdit(base: Record<string, unknown>, edit: SettingsPatch): SettingsEdit {
  let after: Record<string, unknown> = clone(base ?? {});
  if (edit.patch) after = deepMerge(after, edit.patch) as Record<string, unknown>;
  for (const { path, value } of edit.set ?? []) after = setPath(after, path, value);
  for (const path of edit.unset ?? []) after = unsetPath(after, path);
  return { before: base ?? {}, after, diff: diffTree(base ?? {}, after) };
}

export function assertEditProvided(edit: SettingsPatch): void {
  if (!edit.patch && !edit.set?.length && !edit.unset?.length) {
    throw new Error('Provide at least one of: patch, set, unset.');
  }
}

export async function getSettings(
  client: NuvioClient,
  profileId: number,
  platform: Platform
): Promise<SettingsBlob | null> {
  const rows = await client.readRpc<SettingsBlob[]>('sync_pull_profile_settings_blob', {
    p_profile_id: profileId,
    p_platform: platform,
  });
  return rows[0] ?? null;
}

/** True when an error is an optimistic-concurrency rejection (guarded write). */
export function isConcurrencyConflict(error: unknown): boolean {
  const e = error as { code?: string; status?: number; message?: string };
  if (e?.code === '40001' || e?.status === 409) return true;
  return typeof e?.message === 'string' && /changed on another device|concurrency|conflict/i.test(e.message);
}

export interface SettingsWriteResult {
  /** Revision (updated_at) the backend returned, when it reports one. */
  revision: string | null;
  /** False when the backend has no guarded RPC and the unguarded fallback was used. */
  guarded: boolean;
}

export async function writeSettings(
  client: NuvioClient,
  profileId: number,
  platform: Platform,
  json: Record<string, unknown>,
  updatedAt: string | null,
  originId: string
): Promise<SettingsWriteResult> {
  try {
    const result = await client.rpc<unknown>('sync_push_profile_settings_blob_guarded', {
      p_profile_id: profileId,
      p_platform: platform,
      p_settings_json: json,
      p_expected_updated_at: updatedAt,
    });
    return { revision: typeof result === 'string' && result ? result : null, guarded: true };
  } catch (error) {
    if (isMissingFunction(error)) {
      await client.rpc('sync_push_profile_settings_blob', {
        p_profile_id: profileId,
        p_platform: platform,
        p_settings_json: json,
        p_origin_client_id: originId,
      });
      return { revision: null, guarded: false };
    }
    throw error;
  }
}

export async function updateSettings(
  client: NuvioClient,
  profileId: number,
  platform: Platform,
  edit: SettingsPatch,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Record<string, unknown>>> {
  assertEditProvided(edit);
  const current = await getSettings(client, profileId, platform);
  const { before, after, diff } = applySettingsEdit(current?.settings_json ?? {}, edit);
  if (apply && diff.length > 0) {
    await writeSettings(client, profileId, platform, after, current?.updated_at ?? null, originId);
  }
  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

export async function getHomeCatalogSettings(
  client: NuvioClient,
  profileId: number,
  platform: Platform
): Promise<HomeCatalogSettings | null> {
  const rows = await client.readRpc<HomeCatalogSettings[]>('sync_pull_home_catalog_settings', {
    p_profile_id: profileId,
    p_platform: platform,
  });
  return rows[0] ?? null;
}

async function writeHomeCatalog(
  client: NuvioClient,
  profileId: number,
  platform: Platform,
  json: Record<string, unknown>,
  originId: string
): Promise<void> {
  await client.rpc('sync_push_home_catalog_settings', {
    p_profile_id: profileId,
    p_platform: platform,
    p_settings_json: json,
    p_origin_client_id: originId,
  });
}

export async function updateHomeCatalogSettings(
  client: NuvioClient,
  profileId: number,
  platform: Platform,
  edit: SettingsPatch,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Record<string, unknown>>> {
  assertEditProvided(edit);
  const current = await getHomeCatalogSettings(client, profileId, platform);
  const { before, after, diff } = applySettingsEdit(current?.settings_json ?? {}, edit);
  if (apply && diff.length > 0) {
    await writeHomeCatalog(client, profileId, platform, after, originId);
  }
  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

/** Replace the target's settings blob with a copy of the source's (deprecated copy_settings path). */
export async function copySettings(
  client: NuvioClient,
  from: { profile_id: number; platform: Platform },
  to: { profile_id: number; platform: Platform },
  originId: string,
  apply: boolean
): Promise<ApplyResult<Record<string, unknown>>> {
  const source = await getSettings(client, from.profile_id, from.platform);
  const target = await getSettings(client, to.profile_id, to.platform);
  const before = target?.settings_json ?? {};
  const after = clone(source?.settings_json ?? {});
  const diff = diffTree(before, after);
  if (apply && diff.length > 0) {
    await writeSettings(client, to.profile_id, to.platform, after, target?.updated_at ?? null, originId);
  }
  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

// Re-exported for the deprecated single-key aliases.
export { getPath };

function isMissingFunction(error: unknown): boolean {
  const e = error as { code?: string; status?: number };
  return e?.code === 'PGRST202' || e?.status === 404;
}
