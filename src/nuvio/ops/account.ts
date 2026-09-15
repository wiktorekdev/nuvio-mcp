import type { NuvioClient } from '../client.js';
import type { ApplyResult, SyncOverview } from '../types.js';

export async function getAccount(client: NuvioClient): Promise<unknown> {
  return client.request('/auth/v1/user');
}

export async function getSyncOverview(client: NuvioClient): Promise<SyncOverview> {
  return client.readRpc<SyncOverview>('get_sync_overview', {});
}

export async function listAvatars(client: NuvioClient): Promise<unknown[]> {
  return client.readRpc('get_avatar_catalog', {});
}

export interface BackupScope {
  scope?: string[];
  profile_ids?: number[];
  platforms?: string[];
}

/**
 * Export an account backup. With no scope this is a full backup; passing scope
 * entries, profile ids or platforms narrows what the backend exports.
 */
export async function exportBackup(client: NuvioClient, options: BackupScope = {}): Promise<unknown> {
  const args: Record<string, unknown> = {};
  if (options.scope?.length) args.p_scope = options.scope;
  if (options.profile_ids?.length) args.p_profile_ids = options.profile_ids;
  if (options.platforms?.length) args.p_platforms = options.platforms;
  return client.rpc('sync_export_account_backup', args);
}

export async function health(client: NuvioClient): Promise<unknown> {
  return client.readRpc('health_ping', {});
}

export async function restoreBackup(
  client: NuvioClient,
  backup: unknown,
  apply: boolean
): Promise<ApplyResult<Record<string, unknown>>> {
  const diff = ['~ restore account backup (replace mode) — this overwrites profiles/addons/library/settings'];
  if (apply) {
    await client.rpc('sync_restore_account_backup', { p_backup: backup, p_mode: 'replace' });
  }
  return { applied: apply, changed: true, before: {}, after: {}, diff };
}
