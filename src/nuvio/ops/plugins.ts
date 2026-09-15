import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
import type { ApplyResult, Plugin } from '../types.js';

export interface PluginPush {
  url: string;
  name: string | null;
  enabled: boolean;
  sort_order: number;
  repo_type: string | null;
}

export interface PluginInput {
  url: string;
  name?: string | null;
  enabled?: boolean;
  sort_order?: number;
  repo_type?: string | null;
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new NuvioError(`Invalid plugin URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NuvioError(`Plugin URL must be http(s): ${url}`);
  }
}

export async function listPlugins(client: NuvioClient, profileId: number): Promise<Plugin[]> {
  return client.select<Plugin[]>(
    'plugins',
    `select=id,user_id,profile_id,url,name,enabled,sort_order,repo_type,created_at,updated_at` +
      `&profile_id=eq.${profileId}&order=sort_order.asc`
  );
}

function toPushShape(plugins: Plugin[]): PluginPush[] {
  return plugins.map((p) => ({
    url: p.url,
    name: p.name,
    enabled: p.enabled,
    sort_order: p.sort_order,
    repo_type: p.repo_type,
  }));
}

function diffPlugins(before: PluginPush[], after: PluginPush[]): string[] {
  const b = new Map(before.map((p) => [p.url, p]));
  const a = new Map(after.map((p) => [p.url, p]));
  const diff: string[] = [];
  for (const [url, p] of a) {
    const prev = b.get(url);
    if (!prev) diff.push(`+ plugin ${url} (enabled=${p.enabled})`);
    else {
      if (prev.enabled !== p.enabled) diff.push(`~ plugin ${url} enabled ${prev.enabled} -> ${p.enabled}`);
      if (prev.name !== p.name)
        diff.push(`~ plugin ${url} name ${prev.name ?? 'null'} -> ${p.name ?? 'null'}`);
      if (prev.sort_order !== p.sort_order)
        diff.push(`~ plugin ${url} order ${prev.sort_order} -> ${p.sort_order}`);
    }
  }
  for (const url of b.keys()) if (!a.has(url)) diff.push(`- plugin ${url}`);
  return diff.sort();
}

async function commit(
  client: NuvioClient,
  profileId: number,
  originId: string,
  before: PluginPush[],
  after: PluginPush[],
  apply: boolean
): Promise<ApplyResult<PluginPush[]>> {
  const diff = diffPlugins(before, after);
  if (apply && diff.length > 0) {
    await client.rpc('sync_push_plugins', {
      p_profile_id: profileId,
      p_plugins: after,
      p_origin_client_id: originId,
    });
  }
  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

export async function addPlugin(
  client: NuvioClient,
  profileId: number,
  input: PluginInput,
  originId: string,
  apply: boolean
): Promise<ApplyResult<PluginPush[]>> {
  assertHttpUrl(input.url);
  const before = toPushShape(await listPlugins(client, profileId));
  if (before.some((p) => p.url === input.url)) throw new NuvioError(`Plugin already installed: ${input.url}`);
  const after = [
    ...before,
    {
      url: input.url,
      name: input.name ?? null,
      enabled: input.enabled ?? true,
      sort_order: input.sort_order ?? before.reduce((m, p) => Math.max(m, p.sort_order + 1), 0),
      repo_type: input.repo_type ?? null,
    },
  ];
  if (after.length !== before.length + 1) throw new NuvioError('Internal invariant failed (plugin add)');
  return commit(client, profileId, originId, before, after, apply);
}

export async function removePlugin(
  client: NuvioClient,
  profileId: number,
  match: { url?: string; id?: string },
  originId: string,
  apply: boolean
): Promise<ApplyResult<PluginPush[]>> {
  const rows = await listPlugins(client, profileId);
  const target = rows.find((p) => (match.url ? p.url === match.url : p.id === match.id));
  if (!target) throw new NuvioError('Plugin not found on profile');
  const before = toPushShape(rows);
  const after = before.filter((p) => p.url !== target.url);
  if (after.length !== before.length - 1) throw new NuvioError('Internal invariant failed (plugin remove)');
  return commit(client, profileId, originId, before, after, apply);
}

/** Change a plugin's name, enabled flag, repo type or sort order. Identify it by url or table id. */
export async function updatePlugin(
  client: NuvioClient,
  profileId: number,
  match: { url?: string; id?: string },
  changes: Partial<Omit<PluginInput, 'url'>>,
  originId: string,
  apply: boolean
): Promise<ApplyResult<PluginPush[]>> {
  const rows = await listPlugins(client, profileId);
  const target = rows.find((p) => (match.url ? p.url === match.url : p.id === match.id));
  if (!target) throw new NuvioError(`Plugin not found on profile ${profileId}`);
  const before = toPushShape(rows);
  const after = before.map((p) =>
    p.url === target.url
      ? {
          url: p.url,
          name: changes.name !== undefined ? changes.name : p.name,
          enabled: changes.enabled !== undefined ? changes.enabled : p.enabled,
          sort_order: changes.sort_order !== undefined ? changes.sort_order : p.sort_order,
          repo_type: changes.repo_type !== undefined ? changes.repo_type : p.repo_type,
        }
      : p
  );
  return commit(client, profileId, originId, before, after, apply);
}

export async function togglePlugin(
  client: NuvioClient,
  profileId: number,
  url: string,
  enabled: boolean,
  originId: string,
  apply: boolean
): Promise<ApplyResult<PluginPush[]>> {
  const before = toPushShape(await listPlugins(client, profileId));
  if (!before.some((p) => p.url === url)) throw new NuvioError(`Plugin not found: ${url}`);
  const after = before.map((p) => (p.url === url ? { ...p, enabled } : p));
  return commit(client, profileId, originId, before, after, apply);
}

export async function reorderPlugins(
  client: NuvioClient,
  profileId: number,
  orderedUrls: string[],
  originId: string,
  apply: boolean
): Promise<ApplyResult<PluginPush[]>> {
  const before = toPushShape(await listPlugins(client, profileId));
  const current = before.map((p) => p.url).sort();
  const wanted = [...orderedUrls].sort();
  if (current.length !== wanted.length || current.some((u, i) => u !== wanted[i])) {
    throw new NuvioError('Reorder must list every installed plugin URL exactly once.');
  }
  const after = orderedUrls.map((url, index) => ({
    ...before.find((p) => p.url === url)!,
    sort_order: index,
  }));
  return commit(client, profileId, originId, before, after, apply);
}
