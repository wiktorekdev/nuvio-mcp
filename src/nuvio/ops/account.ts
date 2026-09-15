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

export async function exportBackup(client: NuvioClient): Promise<unknown> {
  return client.rpc('sync_export_account_backup', {});
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
