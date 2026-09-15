import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
import type { Addon, ApplyResult } from '../types.js';

export interface AddonPush {
  url: string;
  name: string | null;
  enabled: boolean;
  sort_order: number;
}

export interface AddonInput {
  url: string;
  name?: string | null;
  enabled?: boolean;
  sort_order?: number;
}

export async function listAddons(client: NuvioClient, profileId: number): Promise<Addon[]> {
  return client.select<Addon[]>(
    'addons',
    `select=id,user_id,profile_id,url,name,enabled,sort_order,created_at,updated_at` +
      `&profile_id=eq.${profileId}&order=sort_order.asc,created_at.asc`
  );
}

export function toPushShape(addons: Addon[]): AddonPush[] {
  return addons.map((a) => ({
    url: a.url,
    name: a.name,
    enabled: a.enabled,
    sort_order: a.sort_order,
  }));
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NuvioError(`Invalid addon URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NuvioError(`Addon URL must be http(s): ${url}`);
  }
}

function diffAddons(before: AddonPush[], after: AddonPush[]): string[] {
  const diff: string[] = [];
  const beforeByUrl = new Map(before.map((a) => [a.url, a]));
  const afterByUrl = new Map(after.map((a) => [a.url, a]));

  for (const [url, a] of afterByUrl) {
    const prev = beforeByUrl.get(url);
    if (!prev) diff.push(`+ add ${url} (enabled=${a.enabled}, order=${a.sort_order})`);
    else {
      if (prev.enabled !== a.enabled) diff.push(`~ ${url} enabled ${prev.enabled} -> ${a.enabled}`);
      if (prev.name !== a.name) diff.push(`~ ${url} name ${prev.name ?? 'null'} -> ${a.name ?? 'null'}`);
      if (prev.sort_order !== a.sort_order) diff.push(`~ ${url} order ${prev.sort_order} -> ${a.sort_order}`);
    }
  }
  for (const url of beforeByUrl.keys()) {
    if (!afterByUrl.has(url)) diff.push(`- remove ${url}`);
  }
  return diff.sort();
}

function nextSort(before: AddonPush[]): number {
  return before.reduce((max, a) => Math.max(max, a.sort_order + 1), 0);
}

async function commit(
  client: NuvioClient,
  profileId: number,
  originId: string,
  before: AddonPush[],
  after: AddonPush[],
  apply: boolean
): Promise<ApplyResult<AddonPush[]>> {
  const diff = diffAddons(before, after);
  const changed = diff.length > 0;
  if (apply && changed) {
    await client.rpc('sync_push_addons', {
      p_profile_id: profileId,
      p_addons: after,
      p_origin_client_id: originId,
    });
  }
  return { applied: apply && changed, changed, before, after, diff };
}

export async function addAddon(
  client: NuvioClient,
  profileId: number,
  input: AddonInput,
  originId: string,
  apply: boolean
): Promise<ApplyResult<AddonPush[]>> {
  assertHttpUrl(input.url);
  const before = toPushShape(await listAddons(client, profileId));
  if (before.some((a) => a.url === input.url)) {
    throw new NuvioError(`This addon is already installed on profile ${profileId}: ${input.url}`);
  }
  const after = [
    ...before,
    {
      url: input.url,
      name: input.name ?? null,
      enabled: input.enabled ?? true,
      sort_order: input.sort_order ?? nextSort(before),
    },
  ];
  // Invariant: exactly one new item, nothing else removed or altered.
  if (after.length !== before.length + 1) throw new NuvioError('Internal invariant failed (addon add)');
  return commit(client, profileId, originId, before, after, apply);
}

export async function updateAddon(
  client: NuvioClient,
  profileId: number,
  match: { url?: string; id?: string },
  changes: Partial<Omit<AddonInput, 'url'>>,
  originId: string,
  apply: boolean
): Promise<ApplyResult<AddonPush[]>> {
  const rows = await listAddons(client, profileId);
  const target = rows.find((a) => (match.url ? a.url === match.url : a.id === match.id));
  if (!target) throw new NuvioError(`Addon not found on profile ${profileId}`);
  const before = toPushShape(rows);
  const after = before.map((a) =>
    a.url === target.url
      ? {
          url: a.url,
          name: changes.name !== undefined ? changes.name : a.name,
          enabled: changes.enabled !== undefined ? changes.enabled : a.enabled,
          sort_order: changes.sort_order !== undefined ? changes.sort_order : a.sort_order,
        }
      : a
  );
  return commit(client, profileId, originId, before, after, apply);
}

export async function removeAddon(
  client: NuvioClient,
  profileId: number,
  match: { url?: string; id?: string },
  originId: string,
  apply: boolean
): Promise<ApplyResult<AddonPush[]>> {
  const rows = await listAddons(client, profileId);
  const target = rows.find((a) => (match.url ? a.url === match.url : a.id === match.id));
  if (!target) throw new NuvioError(`Addon not found on profile ${profileId}`);
  const before = toPushShape(rows);
  const after = before.filter((a) => a.url !== target.url);
  if (after.length !== before.length - 1) throw new NuvioError('Internal invariant failed (addon remove)');
  return commit(client, profileId, originId, before, after, apply);
}

export async function reorderAddons(
  client: NuvioClient,
  profileId: number,
  orderedUrls: string[],
  originId: string,
  apply: boolean
): Promise<ApplyResult<AddonPush[]>> {
  const rows = await listAddons(client, profileId);
  const before = toPushShape(rows);
  const beforeUrls = before.map((a) => a.url).sort();
  const wanted = [...orderedUrls].sort();
  if (beforeUrls.length !== wanted.length || beforeUrls.some((u, i) => u !== wanted[i])) {
    throw new NuvioError(
      'Reorder must list every installed addon exactly once (use list_addons to get the current set).'
    );
  }
  const after = orderedUrls.map((url, index) => {
    const base = before.find((a) => a.url === url)!;
    return { ...base, sort_order: index };
  });
  if (after.length !== before.length) throw new NuvioError('Internal invariant failed (addon reorder)');
  return commit(client, profileId, originId, before, after, apply);
}
