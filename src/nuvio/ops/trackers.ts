import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
import type { ApplyResult } from '../types.js';

export const TRACKERS = ['mal', 'anilist', 'kitsu'] as const;
export type Tracker = (typeof TRACKERS)[number];

export interface TrackerToken {
  tracker: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  tracker_user_id?: string;
  tracker_username?: string;
  updated_at?: string;
}

export interface TrackerSettings {
  tracker: string;
  enabled_statuses: string[];
  row_order: string[];
  send_progress: boolean;
}

function assertTracker(tracker: string): string {
  const key = tracker.trim().toLowerCase();
  if (!TRACKERS.includes(key as Tracker)) {
    throw new NuvioError(`Unsupported tracker "${tracker}". Supported: ${TRACKERS.join(', ')}`);
  }
  return key;
}

export async function listTrackerTokens(client: NuvioClient, profileId: number): Promise<TrackerToken[]> {
  return client.readRpc<TrackerToken[]>('get_tracker_tokens', { p_profile_id: profileId });
}

export async function listTrackerSettings(
  client: NuvioClient,
  profileId: number
): Promise<TrackerSettings[]> {
  return client.readRpc<TrackerSettings[]>('get_profile_tracker_settings', { p_profile_id: profileId });
}

export async function setTrackerSettings(
  client: NuvioClient,
  profileId: number,
  tracker: string,
  settings: { enabled_statuses?: string[]; row_order?: string[]; send_progress?: boolean },
  apply: boolean
): Promise<ApplyResult<TrackerSettings[]>> {
  const key = assertTracker(tracker);
  const before = await listTrackerSettings(client, profileId);
  const existing = before.find((s) => s.tracker === key);
  const merged: TrackerSettings = {
    tracker: key,
    enabled_statuses: settings.enabled_statuses ?? existing?.enabled_statuses ?? [],
    row_order: settings.row_order ?? existing?.row_order ?? [],
    send_progress: settings.send_progress ?? existing?.send_progress ?? true,
  };
  const after = existing ? before.map((s) => (s.tracker === key ? merged : s)) : [...before, merged];
  const diff = [
    `~ ${key} settings: enabled_statuses=${merged.enabled_statuses.length}, send_progress=${merged.send_progress}`,
  ];

  if (apply) {
    await client.rpc('upsert_profile_tracker_settings', {
      p_profile_id: profileId,
      p_tracker: key,
      p_enabled_statuses: merged.enabled_statuses,
      p_row_order: merged.row_order,
      p_send_progress: merged.send_progress,
    });
  }
  return { applied: apply, changed: true, before, after, diff };
}

export async function setTrackerToken(
  client: NuvioClient,
  profileId: number,
  tracker: string,
  token: {
    access_token: string;
    refresh_token?: string;
    expires_in_seconds?: number;
    tracker_user_id?: string;
    username?: string;
  },
  apply: boolean
): Promise<ApplyResult<TrackerToken[]>> {
  const key = assertTracker(tracker);
  if (!token.access_token) throw new NuvioError('access_token is required to link a tracker');
  const before = await listTrackerTokens(client, profileId);
  const after: TrackerToken[] = [
    ...before.filter((t) => t.tracker !== key),
    {
      tracker: key,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      tracker_user_id: token.tracker_user_id,
      tracker_username: token.username,
    },
  ];
  if (apply) {
    await client.rpc('upsert_tracker_tokens', {
      p_profile_id: profileId,
      p_tracker: key,
      p_access_token: token.access_token,
      p_refresh_token: token.refresh_token ?? '',
      p_expires_in_seconds: token.expires_in_seconds ?? 3600,
      p_tracker_user_id: token.tracker_user_id ?? '',
      p_username: token.username ?? '',
    });
  }
  return { applied: apply, changed: true, before, after, diff: [`~ link ${key} tracker`] };
}

export async function unlinkTracker(
  client: NuvioClient,
  profileId: number,
  tracker: string,
  apply: boolean
): Promise<ApplyResult<TrackerToken[]>> {
  const key = assertTracker(tracker);
  const before = await listTrackerTokens(client, profileId);
  if (!before.some((t) => t.tracker === key)) {
    throw new NuvioError(`Tracker "${key}" is not linked on profile ${profileId}`);
  }
  const after = before.filter((t) => t.tracker !== key);
  if (apply) {
    await client.rpc('clear_tracker_tokens', { p_profile_id: profileId, p_tracker: key });
  }
  return { applied: apply, changed: true, before, after, diff: [`- unlink ${key} tracker`] };
}
