import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { join } from 'node:path';
import type { NuvioConfig } from '../config.js';
import type { NuvioClient } from './client.js';
import { NuvioError } from './errors.js';

/** Thrown when a mandatory pre-mutation snapshot cannot be persisted. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/**
 * Identifies the slice of account state a mutation touched. `before` snapshots are
 * captured in exactly the shape `restore` needs to push back.
 */
export type ResourceRef =
  | { kind: 'profiles' }
  | { kind: 'addons'; profile_id: number }
  | { kind: 'plugins'; profile_id: number }
  | { kind: 'settings'; profile_id: number; platform: string }
  | { kind: 'home_catalog_settings'; profile_id: number; platform: string }
  | { kind: 'collections'; profile_id: number }
  | { kind: 'library'; profile_id: number }
  | { kind: 'watch_progress'; profile_id: number }
  | { kind: 'watch_history'; profile_id: number }
  | { kind: 'provider_credentials'; profile_id: number }
  | { kind: 'tracker_tokens'; profile_id: number }
  | { kind: 'tracker_settings'; profile_id: number }
  | { kind: 'profile_setup'; profile_id: number }
  | { kind: 'sessions' };

export interface Snapshot {
  id: string;
  ts: string;
  tool: string;
  backend: string;
  account?: string;
  resource: ResourceRef;
  reversible: boolean;
  sensitive: boolean;
  note?: string;
  /** Identities the mutation touched, used for precise, truncation-safe undo. */
  scope?: unknown;
  before: unknown;
}

function snapshotId(): string {
  const ms = String(Date.now()).padStart(16, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ms}-${rand}`;
}

function sensitiveKind(kind: ResourceRef['kind']): boolean {
  return kind === 'provider_credentials' || kind === 'tracker_tokens' || kind === 'profile_setup';
}

export function capture(
  cfg: NuvioConfig,
  client: NuvioClient,
  input: {
    tool: string;
    resource: ResourceRef;
    before: unknown;
    reversible?: boolean;
    note?: string;
    scope?: unknown;
  }
): Snapshot {
  const snapshot: Snapshot = {
    id: snapshotId(),
    ts: new Date().toISOString(),
    tool: input.tool,
    backend: cfg.backendUrl,
    account: client.currentEmail ?? client.currentUserId,
    resource: input.resource,
    reversible: input.reversible ?? true,
    sensitive: sensitiveKind(input.resource.kind),
    note: input.note,
    scope: input.scope,
    before: input.before,
  };
  persist(cfg, snapshot);
  return snapshot;
}

/** Atomically write a snapshot (temp file + fsync + rename, 0600). Throws on any failure. */
function persist(cfg: NuvioConfig, snapshot: Snapshot): void {
  const target = join(cfg.snapshotDir, `${snapshot.id}.json`);
  const tmp = `${target}.tmp`;
  try {
    mkdirSync(cfg.snapshotDir, { recursive: true, mode: 0o700 });
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    const fd = openSync(tmp, 'r+');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      /* temp file may not exist */
    }
    throw new SnapshotError(
      `Could not persist the pre-change snapshot (${error instanceof Error ? error.message : String(error)}). ` +
        'The change was not applied.'
    );
  }
}

export function removeSnapshot(cfg: NuvioConfig, id: string): void {
  try {
    unlinkSync(join(cfg.snapshotDir, `${id}.json`));
  } catch {
    /* already gone */
  }
}

export function listSnapshots(cfg: NuvioConfig, limit = 25): Snapshot[] {
  let files: string[];
  try {
    files = readdirSync(cfg.snapshotDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const snapshots: Snapshot[] = [];
  for (const file of files) {
    try {
      snapshots.push(JSON.parse(readFileSync(join(cfg.snapshotDir, file), 'utf8')) as Snapshot);
    } catch {
      /* skip corrupt snapshot */
    }
  }
  snapshots.sort((a, b) => (a.id < b.id ? 1 : -1));
  return snapshots.slice(0, limit);
}

export function getSnapshot(cfg: NuvioConfig, id: string): Snapshot | null {
  try {
    return JSON.parse(readFileSync(join(cfg.snapshotDir, `${id}.json`), 'utf8')) as Snapshot;
  } catch {
    return null;
  }
}

export function findLastChange(cfg: NuvioConfig): Snapshot | null {
  return listSnapshots(cfg, 500).find((s) => s.reversible && s.tool !== 'nuvio_undo') ?? null;
}

export function findLastUndo(cfg: NuvioConfig): Snapshot | null {
  return listSnapshots(cfg, 500).find((s) => s.tool === 'nuvio_undo' && s.reversible) ?? null;
}

const PAGE = 1000;
const MAX_ROWS = 20_000;

function strip<T extends Record<string, unknown>>(rows: T[], keys: string[]): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) if (row[key] !== undefined) out[key] = row[key];
    return out;
  });
}

const LIBRARY_FIELDS = [
  'content_id',
  'content_type',
  'name',
  'poster',
  'poster_shape',
  'background',
  'description',
  'release_info',
  'imdb_rating',
  'genres',
  'addon_base_url',
  'added_at',
];
const PROGRESS_FIELDS = [
  'content_id',
  'content_type',
  'video_id',
  'season',
  'episode',
  'position',
  'duration',
  'last_watched',
  'progress_key',
];
const HISTORY_FIELDS = ['content_id', 'content_type', 'title', 'season', 'episode', 'watched_at'];

/** Read the current state of a resource in the shape `restore` expects. */
export async function readResource(client: NuvioClient, ref: ResourceRef): Promise<unknown> {
  switch (ref.kind) {
    case 'profiles': {
      const rows = await client.rpc<Array<Record<string, unknown>>>('sync_pull_profiles', {});
      return strip(rows, [
        'profile_index',
        'name',
        'avatar_color_hex',
        'uses_primary_addons',
        'uses_primary_plugins',
        'avatar_id',
        'avatar_url',
      ]);
    }
    case 'addons':
      return client.select(
        'addons',
        `select=url,name,enabled,sort_order&profile_id=eq.${ref.profile_id}&order=sort_order.asc`
      );
    case 'plugins':
      return client.select(
        'plugins',
        `select=url,name,enabled,sort_order,repo_type&profile_id=eq.${ref.profile_id}&order=sort_order.asc`
      );
    case 'settings':
    case 'home_catalog_settings': {
      const fn =
        ref.kind === 'settings' ? 'sync_pull_profile_settings_blob' : 'sync_pull_home_catalog_settings';
      const rows = await client.rpc<Array<{ settings_json: unknown }>>(fn, {
        p_profile_id: ref.profile_id,
        p_platform: ref.platform,
      });
      return rows[0]?.settings_json ?? {};
    }
    case 'collections': {
      const rows = await client.rpc<Array<{ collections_json: unknown }>>('sync_pull_collections', {
        p_profile_id: ref.profile_id,
      });
      return rows[0]?.collections_json ?? [];
    }
    case 'library': {
      const all: unknown[] = [];
      for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
        const page = await client.rpc<unknown[]>('sync_pull_library', {
          p_profile_id: ref.profile_id,
          p_limit: PAGE,
          p_offset: offset,
        });
        all.push(...page);
        if (page.length < PAGE) break;
      }
      return all;
    }
    case 'watch_progress':
      return client.rpc('sync_pull_watch_progress', { p_profile_id: ref.profile_id, p_limit: MAX_ROWS });
    case 'watch_history': {
      const all: unknown[] = [];
      for (let page = 1; (page - 1) * PAGE < MAX_ROWS; page += 1) {
        const rows = await client.rpc<unknown[]>('sync_pull_watched_items', {
          p_profile_id: ref.profile_id,
          p_page: page,
          p_page_size: PAGE,
        });
        all.push(...rows);
        if (rows.length < PAGE) break;
      }
      return all;
    }
    case 'provider_credentials':
      return client.rpc('sync_pull_provider_credentials', { p_profile_id: ref.profile_id });
    case 'tracker_tokens':
      return client.rpc('get_tracker_tokens', { p_profile_id: ref.profile_id });
    case 'tracker_settings':
      return client.rpc('get_profile_tracker_settings', { p_profile_id: ref.profile_id });
    case 'profile_setup': {
      const settings: Record<string, unknown> = {};
      for (const platform of ['tv', 'mobile', 'desktop']) {
        const rows = await client.rpc<Array<{ settings_json: unknown }>>('sync_pull_profile_settings_blob', {
          p_profile_id: ref.profile_id,
          p_platform: platform,
        });
        settings[platform] = rows[0]?.settings_json ?? null;
      }
      const providerCredentials = await client.rpc('sync_pull_provider_credentials', {
        p_profile_id: ref.profile_id,
      });
      return { settings, provider_credentials: providerCredentials };
    }
    default:
      throw new NuvioError('This resource cannot be read for snapshotting.');
  }
}

export async function restore(client: NuvioClient, cfg: NuvioConfig, snapshot: Snapshot): Promise<string> {
  if (!snapshot.reversible) {
    throw new NuvioError(`Snapshot ${snapshot.id} (${snapshot.tool}) cannot be reverted automatically.`);
  }
  const origin = cfg.originClientId;
  const r = snapshot.resource;
  const before = snapshot.before;

  switch (r.kind) {
    case 'profiles': {
      const wanted = new Set((before as Array<{ profile_index: number }>).map((p) => p.profile_index));
      const current = await client.rpc<Array<{ profile_index: number }>>('sync_pull_profiles', {});
      for (const p of current) {
        if (!wanted.has(p.profile_index)) {
          await client.rpc('sync_delete_profile_data', {
            p_profile_id: p.profile_index,
            p_origin_client_id: origin,
          });
        }
      }
      await client.rpc('sync_push_profiles', {
        p_client_max_profiles: 6,
        p_origin_client_id: origin,
        p_profiles: before,
      });
      return 'Restored the profile list.';
    }
    case 'addons':
      await client.rpc('sync_push_addons', {
        p_profile_id: r.profile_id,
        p_addons: before,
        p_origin_client_id: origin,
      });
      return `Restored addons for profile ${r.profile_id}.`;
    case 'plugins':
      await client.rpc('sync_push_plugins', {
        p_profile_id: r.profile_id,
        p_plugins: before,
        p_origin_client_id: origin,
      });
      return `Restored plugins for profile ${r.profile_id}.`;
    case 'settings':
      await client.rpc('sync_push_profile_settings_blob', {
        p_profile_id: r.profile_id,
        p_platform: r.platform,
        p_settings_json: before,
        p_origin_client_id: origin,
      });
      return `Restored ${r.platform} settings for profile ${r.profile_id}.`;
    case 'home_catalog_settings':
      await client.rpc('sync_push_home_catalog_settings', {
        p_profile_id: r.profile_id,
        p_platform: r.platform,
        p_settings_json: before,
        p_origin_client_id: origin,
      });
      return `Restored ${r.platform} home catalog settings for profile ${r.profile_id}.`;
    case 'collections':
      await client.rpc('sync_push_collections', {
        p_profile_id: r.profile_id,
        p_collections_json: before,
        p_origin_client_id: origin,
      });
      return `Restored collections for profile ${r.profile_id}.`;
    case 'library': {
      const beforeRows = before as Array<Record<string, unknown>>;
      const scope = (snapshot.scope as Array<{ content_id: string; content_type: string }> | undefined) ?? [];
      const beforeKeys = new Set(beforeRows.map((i) => `${i.content_type}:${i.content_id}`));
      const remove = scope.filter((k) => !beforeKeys.has(`${k.content_type}:${k.content_id}`));
      if (remove.length > 0) {
        await client.rpc('sync_delete_library_items', {
          p_profile_id: r.profile_id,
          p_keys: remove,
          p_origin_client_id: origin,
        });
      }
      if (beforeRows.length > 0) {
        await client.rpc('sync_push_library_items', {
          p_profile_id: r.profile_id,
          p_items: strip(beforeRows, LIBRARY_FIELDS),
          p_origin_client_id: origin,
        });
      }
      return `Restored the library for profile ${r.profile_id}.`;
    }
    case 'watch_progress': {
      const beforeRows = before as Array<Record<string, unknown>>;
      const scope = (snapshot.scope as string[] | undefined) ?? [];
      const beforeKeys = new Set(beforeRows.map((p) => progressKeyOf(p)));
      const remove = scope.filter((key) => !beforeKeys.has(key));
      if (remove.length > 0) {
        await client.rpc('sync_delete_watch_progress', {
          p_profile_id: r.profile_id,
          p_keys: remove,
          p_origin_client_id: origin,
        });
      }
      if (beforeRows.length > 0) {
        await client.rpc('sync_push_watch_progress', {
          p_profile_id: r.profile_id,
          p_entries: strip(beforeRows, PROGRESS_FIELDS),
          p_origin_client_id: origin,
        });
      }
      return `Restored watch progress for profile ${r.profile_id}.`;
    }
    case 'watch_history': {
      const beforeRows = before as Array<Record<string, unknown>>;
      const scope = (snapshot.scope as Array<Record<string, unknown>> | undefined) ?? [];
      const beforeKeys = new Set(beforeRows.map((i) => historyKeyOf(i)));
      const remove = scope.filter((k) => !beforeKeys.has(historyKeyOf(k)));
      if (remove.length > 0) {
        await client.rpc('sync_delete_watched_items', {
          p_profile_id: r.profile_id,
          p_keys: remove.map((i) => ({
            content_id: i.content_id,
            season: i.season ?? null,
            episode: i.episode ?? null,
          })),
          p_origin_client_id: origin,
        });
      }
      if (beforeRows.length > 0) {
        await client.rpc('sync_push_watched_items', {
          p_profile_id: r.profile_id,
          p_items: strip(beforeRows, HISTORY_FIELDS),
          p_origin_client_id: origin,
        });
      }
      return `Restored watch history for profile ${r.profile_id}.`;
    }
    case 'provider_credentials': {
      const current = await client.rpc<Array<{ provider: string }>>('sync_pull_provider_credentials', {
        p_profile_id: r.profile_id,
      });
      const beforeRows = before as Array<{ provider: string; credential_json: unknown }>;
      const wanted = new Set(beforeRows.map((c) => c.provider));
      for (const cred of current) {
        if (!wanted.has(cred.provider)) {
          await client.rpc('sync_delete_provider_credentials', {
            p_profile_id: r.profile_id,
            p_provider: cred.provider,
            p_origin_client_id: origin,
          });
        }
      }
      if (beforeRows.length > 0) {
        await client.rpc('sync_push_provider_credentials', {
          p_profile_id: r.profile_id,
          p_credentials: beforeRows.map((c) => ({
            provider: c.provider,
            credential_json: c.credential_json,
          })),
          p_origin_client_id: origin,
        });
      }
      return `Restored provider credentials for profile ${r.profile_id}.`;
    }
    case 'tracker_tokens': {
      const current = await client.rpc<Array<{ tracker: string }>>('get_tracker_tokens', {
        p_profile_id: r.profile_id,
      });
      const beforeRows = before as Array<Record<string, unknown>>;
      const wanted = new Set(beforeRows.map((t) => String(t.tracker)));
      for (const token of current) {
        if (!wanted.has(String(token.tracker))) {
          await client.rpc('clear_tracker_tokens', { p_profile_id: r.profile_id, p_tracker: token.tracker });
        }
      }
      for (const token of beforeRows) {
        await client.rpc('upsert_tracker_tokens', {
          p_profile_id: r.profile_id,
          p_tracker: token.tracker,
          p_access_token: token.access_token,
          p_refresh_token: token.refresh_token ?? '',
          p_expires_in_seconds: secondsUntil(token.expires_at),
          p_tracker_user_id: token.tracker_user_id ?? '',
          p_username: token.tracker_username ?? token.username ?? '',
        });
      }
      return `Restored tracker links for profile ${r.profile_id}.`;
    }
    case 'tracker_settings': {
      const beforeRows = before as Array<Record<string, unknown>>;
      const wanted = new Set(beforeRows.map((row) => String(row.tracker)));
      const current = await client.rpc<Array<{ tracker: string }>>('get_profile_tracker_settings', {
        p_profile_id: r.profile_id,
      });
      for (const row of current) {
        if (!wanted.has(String(row.tracker))) {
          await client.rpc('upsert_profile_tracker_settings', {
            p_profile_id: r.profile_id,
            p_tracker: row.tracker,
            p_enabled_statuses: [],
            p_row_order: [],
            p_send_progress: true,
          });
        }
      }
      for (const row of beforeRows) {
        await client.rpc('upsert_profile_tracker_settings', {
          p_profile_id: r.profile_id,
          p_tracker: row.tracker,
          p_enabled_statuses: row.enabled_statuses ?? [],
          p_row_order: row.row_order ?? [],
          p_send_progress: row.send_progress ?? true,
        });
      }
      return `Restored tracker settings for profile ${r.profile_id}.`;
    }
    case 'profile_setup': {
      const data = before as {
        settings: Record<string, unknown | null>;
        provider_credentials: Array<{ provider: string; credential_json: unknown }>;
      };
      for (const [platform, json] of Object.entries(data.settings ?? {})) {
        if (json === null || json === undefined) continue;
        await client.rpc('sync_push_profile_settings_blob', {
          p_profile_id: r.profile_id,
          p_platform: platform,
          p_settings_json: json,
          p_origin_client_id: origin,
        });
      }
      const wanted = new Set((data.provider_credentials ?? []).map((c) => c.provider));
      const current = await client.rpc<Array<{ provider: string }>>('sync_pull_provider_credentials', {
        p_profile_id: r.profile_id,
      });
      for (const cred of current) {
        if (!wanted.has(cred.provider)) {
          await client.rpc('sync_delete_provider_credentials', {
            p_profile_id: r.profile_id,
            p_provider: cred.provider,
            p_origin_client_id: origin,
          });
        }
      }
      if ((data.provider_credentials ?? []).length > 0) {
        await client.rpc('sync_push_provider_credentials', {
          p_profile_id: r.profile_id,
          p_credentials: data.provider_credentials.map((c) => ({
            provider: c.provider,
            credential_json: c.credential_json,
          })),
          p_origin_client_id: origin,
        });
      }
      return `Restored setup for profile ${r.profile_id}.`;
    }
    default:
      throw new NuvioError(`No automatic revert available for resource "${(r as ResourceRef).kind}".`);
  }
}

function progressKeyOf(p: Record<string, unknown>): string {
  if (typeof p.progress_key === 'string' && p.progress_key) return p.progress_key;
  return p.season != null ? `${p.content_id}_s${p.season}e${p.episode}` : String(p.content_id);
}

function historyKeyOf(i: Record<string, unknown>): string {
  return `${i.content_id}|${i.season ?? -1}|${i.episode ?? -1}`;
}

function secondsUntil(expiresAt: unknown): number {
  const ts = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (Number.isNaN(ts)) return 3600;
  return Math.max(60, Math.floor((ts - Date.now()) / 1000));
}

export function describe(s: Snapshot): string {
  const target = 'profile_id' in s.resource ? ` profile ${s.resource.profile_id}` : '';
  const platform = 'platform' in s.resource ? `/${s.resource.platform}` : '';
  const flags =
    (s.reversible ? '' : ' [not reversible]') +
    (s.sensitive ? ' [sensitive]' : '') +
    (s.note ? ` — ${s.note}` : '');
  return `${s.id}  ${s.ts}  ${s.tool} -> ${s.resource.kind}${target}${platform}${flags}`;
}
