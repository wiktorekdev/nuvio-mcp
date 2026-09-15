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

export interface ScopedBackupResult {
  backup: unknown;
  scope_requested: BackupScope;
  /** True only when the response positively confirms the requested narrowing. */
  scope_verified: boolean;
  warning?: string;
}

const BACKUP_METADATA_KEYS = new Set(['version', 'exported_at', 'exportedAt', 'generated_at']);

/**
 * Best-effort check that the backend actually narrowed the export. Verification
 * is positive-only: the response must contain at least one requested section and
 * nothing outside it, and selected profiles/platforms must be a subset. Anything
 * that cannot be confirmed counts as unverified (so we never assume a scoped
 * export when the backend may have ignored the arguments).
 */
function verifyScopeApplied(backup: unknown, options: BackupScope): boolean {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) return false;
  const record = backup as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => !BACKUP_METADATA_KEYS.has(k));

  if (options.scope?.length) {
    const allowed = new Set(options.scope);
    const requested = keys.filter((k) => allowed.has(k));
    const foreign = keys.filter((k) => !allowed.has(k));
    if (requested.length === 0 || foreign.length > 0) return false;
  }
  if (options.profile_ids?.length) {
    const profiles = record.profiles;
    if (!Array.isArray(profiles)) return false;
    const wanted = new Set(options.profile_ids);
    const ids = profiles.map(
      (p) =>
        (p as { profile_index?: number; profile_id?: number }).profile_index ??
        (p as { profile_id?: number }).profile_id
    );
    if (ids.some((id) => typeof id !== 'number' || !wanted.has(id))) return false;
  }
  if (options.platforms?.length) {
    const settings = record.settings;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return false;
    const wanted = new Set(options.platforms);
    if (Object.keys(settings as Record<string, unknown>).some((p) => !wanted.has(p))) return false;
  }
  return true;
}

/**
 * Export an account backup. With no scope this is a full backup; passing scope
 * entries, profile ids or platforms asks the backend to narrow the export.
 *
 * If scope was requested but the response cannot positively confirm it, the
 * result carries `scope_verified: false` and an explicit warning — there is no
 * silent fallback to treating an unscoped backup as scoped.
 */
export async function exportBackup(
  client: NuvioClient,
  options: BackupScope = {}
): Promise<unknown | ScopedBackupResult> {
  const requested = Boolean(
    options.scope?.length || options.profile_ids?.length || options.platforms?.length
  );
  // Backup export is a read: use the cached, retry-safe read path.
  if (!requested) return client.readRpc('sync_export_account_backup', {});

  const args: Record<string, unknown> = {};
  if (options.scope?.length) args.p_scope = options.scope;
  if (options.profile_ids?.length) args.p_profile_ids = options.profile_ids;
  if (options.platforms?.length) args.p_platforms = options.platforms;

  const backup = await client.readRpc('sync_export_account_backup', args);
  if (verifyScopeApplied(backup, options)) {
    return { backup, scope_requested: options, scope_verified: true };
  }
  return {
    backup,
    scope_requested: options,
    scope_verified: false,
    warning:
      'The backend did not confirm scope/profile_ids/platforms for this export. The returned data may be a ' +
      'FULL backup — do not treat it as scoped. Verify backend support before relying on it.',
  };
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
