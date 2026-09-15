import type { NuvioClient } from '../client.js';
import type { ApplyResult, HomeCatalogSettings, Platform, SettingsBlob } from '../types.js';
import { setPath, unsetPath, getPath } from '../paths.js';

function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff: string[] = [];
  for (const key of keys) {
    const b = JSON.stringify(before[key]);
    const a = JSON.stringify(after[key]);
    if (b !== a) diff.push(`~ ${key}: ${truncate(b)} -> ${truncate(a)}`);
  }
  return diff.sort();
}

function truncate(value: string | undefined, max = 160): string {
  if (value === undefined) return 'undefined';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export async function getSettings(
  client: NuvioClient,
  profileId: number,
  platform: Platform
): Promise<SettingsBlob | null> {
  const rows = await client.rpc<SettingsBlob[]>('sync_pull_profile_settings_blob', {
    p_profile_id: profileId,
    p_platform: platform,
  });
  return rows[0] ?? null;
}

async function writeSettings(
  client: NuvioClient,
  profileId: number,
  platform: Platform,
  json: Record<string, unknown>,
  updatedAt: string | null,
  originId: string
): Promise<void> {
  try {
    await client.rpc('sync_push_profile_settings_blob_guarded', {
      p_profile_id: profileId,
      p_platform: platform,
      p_settings_json: json,
      p_expected_updated_at: updatedAt,
    });
  } catch (error) {
    if (isMissingFunction(error)) {
      await client.rpc('sync_push_profile_settings_blob', {
        p_profile_id: profileId,
        p_platform: platform,
        p_settings_json: json,
        p_origin_client_id: originId,
      });
    } else {
      throw error;
    }
  }
}

export async function updateSettings(
  client: NuvioClient,
  profileId: number,
  platform: Platform,
  patch: Record<string, unknown>,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Record<string, unknown>>> {
  const current = await getSettings(client, profileId, platform);
  const before = current?.settings_json ?? {};
  const after = { ...before, ...patch };
  const diff = changedKeys(before, after);
  if (apply && diff.length > 0) {
    await writeSettings(client, profileId, platform, after, current?.updated_at ?? null, originId);
  }
  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

export async function setSetting(
  client: NuvioClient,
  profileId: number,
  platform: Platform,
  path: string,
  value: unknown,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Record<string, unknown>>> {
  const current = await getSettings(client, profileId, platform);
  const before = current?.settings_json ?? {};
  const after = setPath(before, path, value);
  const diff =
    JSON.stringify(getPath(before, path)) === JSON.stringify(value)
      ? []
      : [
          `~ ${path}: ${truncate(JSON.stringify(getPath(before, path)))} -> ${truncate(JSON.stringify(value))}`,
        ];
  if (apply && diff.length > 0) {
    await writeSettings(client, profileId, platform, after, current?.updated_at ?? null, originId);
  }
  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

export async function unsetSetting(
  client: NuvioClient,
  profileId: number,
  platform: Platform,
  path: string,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Record<string, unknown>>> {
  const current = await getSettings(client, profileId, platform);
  const before = current?.settings_json ?? {};
  if (getPath(before, path) === undefined) {
    return { applied: false, changed: false, before, after: before, diff: [] };
  }
  const after = unsetPath(before, path);
  const diff = [`- ${path}: ${truncate(JSON.stringify(getPath(before, path)))}`];
  if (apply) {
    await writeSettings(client, profileId, platform, after, current?.updated_at ?? null, originId);
  }
  return { applied: apply, changed: true, before, after, diff };
}

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
  const after = structuredClone(source?.settings_json ?? {});
  const diff = changedKeys(before, after);
  if (apply && diff.length > 0) {
    await writeSettings(client, to.profile_id, to.platform, after, target?.updated_at ?? null, originId);
  }
  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

export async function getHomeCatalogSettings(
  client: NuvioClient,
  profileId: number,
  platform: Platform
): Promise<HomeCatalogSettings | null> {
  const rows = await client.rpc<HomeCatalogSettings[]>('sync_pull_home_catalog_settings', {
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
  patch: Record<string, unknown>,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Record<string, unknown>>> {
  const current = await getHomeCatalogSettings(client, profileId, platform);
  const before = current?.settings_json ?? {};
  const after = { ...before, ...patch };
  const diff = changedKeys(before, after);
  if (apply && diff.length > 0) {
    await writeHomeCatalog(client, profileId, platform, after, originId);
  }
  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

export async function setHomeCatalogPath(
  client: NuvioClient,
  profileId: number,
  platform: Platform,
  path: string,
  value: unknown,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Record<string, unknown>>> {
  const current = await getHomeCatalogSettings(client, profileId, platform);
  const before = current?.settings_json ?? {};
  const after = setPath(before, path, value);
  const diff =
    JSON.stringify(getPath(before, path)) === JSON.stringify(value)
      ? []
      : [
          `~ ${path}: ${truncate(JSON.stringify(getPath(before, path)))} -> ${truncate(JSON.stringify(value))}`,
        ];
  if (apply && diff.length > 0) {
    await writeHomeCatalog(client, profileId, platform, after, originId);
  }
  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

function isMissingFunction(error: unknown): boolean {
  const e = error as { code?: string; status?: number };
  return e?.code === 'PGRST202' || e?.status === 404;
}
