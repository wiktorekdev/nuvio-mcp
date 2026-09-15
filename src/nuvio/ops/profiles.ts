import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
import type { ApplyResult, Profile } from '../types.js';
import { deepMerge } from './settings.js';

export const SETUP_PLATFORMS = ['tv', 'mobile', 'desktop'] as const;
export type SetupPlatform = (typeof SETUP_PLATFORMS)[number];

export interface CopySetupInput {
  source_profile_id: number;
  target_profile_id: number;
  platforms?: string[];
  settings_mode?: 'merge' | 'replace';
  provider_credentials?: 'none' | 'merge' | 'replace';
}

async function readPlatformSettings(
  client: NuvioClient,
  profileId: number,
  platform: string
): Promise<Record<string, unknown> | null> {
  const rows = await client.readRpc<Array<{ settings_json: unknown }>>('sync_pull_profile_settings_blob', {
    p_profile_id: profileId,
    p_platform: platform,
  });
  return (rows[0]?.settings_json as Record<string, unknown>) ?? null;
}

async function readCredentials(
  client: NuvioClient,
  profileId: number
): Promise<Array<{ provider: string; credential_json: unknown }>> {
  return client.readRpc('sync_pull_provider_credentials', { p_profile_id: profileId });
}

/**
 * Copy a profile's setup to another profile: per-platform settings (deep-merged
 * or replaced) and optionally provider credentials (merged or replaced).
 */
export async function copySetup(
  client: NuvioClient,
  input: CopySetupInput,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Record<string, unknown>>> {
  const source = input.source_profile_id;
  const target = input.target_profile_id;
  if (source === target) throw new NuvioError('Source and target profile must differ.');
  const platforms = input.platforms?.length ? input.platforms : [...SETUP_PLATFORMS];
  const mode = input.settings_mode ?? 'merge';
  const credMode = input.provider_credentials ?? 'none';

  const before: Record<string, unknown> = { settings: {}, provider_credentials: [] };
  const after: Record<string, unknown> = { settings: {}, provider_credentials: [] };
  const diff: string[] = [];

  for (const platform of platforms) {
    const src = await readPlatformSettings(client, source, platform);
    const tgt = await readPlatformSettings(client, target, platform);
    (before.settings as Record<string, unknown>)[platform] = tgt;
    if (src === null) continue;
    const next = mode === 'replace' ? src : (deepMerge(tgt ?? {}, src) as Record<string, unknown>);
    (after.settings as Record<string, unknown>)[platform] = next;
    if (JSON.stringify(tgt) !== JSON.stringify(next)) {
      diff.push(`~ ${platform} settings (${mode}) on profile ${target}`);
    }
  }

  const pushCredentials: Array<{ provider: string; credential_json: unknown }> = [];
  const deleteProviders: string[] = [];
  if (credMode !== 'none') {
    const srcCreds = await readCredentials(client, source);
    const tgtCreds = await readCredentials(client, target);
    before.provider_credentials = tgtCreds;
    const tgtByProvider = new Map(tgtCreds.map((c) => [c.provider, c]));
    if (credMode === 'replace') {
      const wanted = new Set(srcCreds.map((c) => c.provider));
      for (const cred of tgtCreds) if (!wanted.has(cred.provider)) deleteProviders.push(cred.provider);
    }
    for (const cred of srcCreds) pushCredentials.push(cred);
    after.provider_credentials = srcCreds;
    if (pushCredentials.length > 0) {
      diff.push(`~ provider credentials (${credMode}): ${pushCredentials.map((c) => c.provider).join(', ')}`);
    }
    for (const provider of deleteProviders) diff.push(`- provider credential ${provider}`);
    void tgtByProvider;
  }

  if (apply && diff.length > 0) {
    for (const [platform, json] of Object.entries(after.settings as Record<string, unknown>)) {
      if (!(platform in (before.settings as Record<string, unknown>))) continue;
      await client.rpc('sync_push_profile_settings_blob', {
        p_profile_id: target,
        p_platform: platform,
        p_settings_json: json,
        p_origin_client_id: originId,
      });
    }
    for (const provider of deleteProviders) {
      await client.rpc('sync_delete_provider_credentials', {
        p_profile_id: target,
        p_provider: provider,
        p_origin_client_id: originId,
      });
    }
    if (pushCredentials.length > 0) {
      await client.rpc('sync_push_provider_credentials', {
        p_profile_id: target,
        p_credentials: pushCredentials,
        p_origin_client_id: originId,
      });
    }
  }

  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

export interface ProfilePush {
  profile_index: number;
  name: string;
  avatar_color_hex: string | null;
  uses_primary_addons: boolean;
  uses_primary_plugins: boolean;
  avatar_id: string | null;
  avatar_url: string | null;
}

export const CLIENT_MAX_PROFILES = 6;

export async function listProfiles(client: NuvioClient): Promise<Profile[]> {
  return client.readRpc<Profile[]>('sync_pull_profiles', {});
}

function toPushShape(profiles: Profile[]): ProfilePush[] {
  return profiles
    .map((p) => ({
      profile_index: p.profile_index,
      name: p.name,
      avatar_color_hex: p.avatar_color_hex,
      uses_primary_addons: p.uses_primary_addons,
      uses_primary_plugins: p.uses_primary_plugins,
      avatar_id: p.avatar_id,
      avatar_url: p.avatar_url,
    }))
    .sort((a, b) => a.profile_index - b.profile_index);
}

function diffProfiles(before: ProfilePush[], after: ProfilePush[]): string[] {
  const diff: string[] = [];
  const b = new Map(before.map((p) => [p.profile_index, p]));
  const a = new Map(after.map((p) => [p.profile_index, p]));
  for (const [idx, p] of a) {
    const prev = b.get(idx);
    if (!prev) diff.push(`+ profile ${idx} "${p.name}"`);
    else {
      if (prev.name !== p.name) diff.push(`~ profile ${idx} name "${prev.name}" -> "${p.name}"`);
      if (prev.avatar_color_hex !== p.avatar_color_hex)
        diff.push(`~ profile ${idx} color ${prev.avatar_color_hex} -> ${p.avatar_color_hex}`);
      if (prev.uses_primary_addons !== p.uses_primary_addons)
        diff.push(
          `~ profile ${idx} uses_primary_addons ${prev.uses_primary_addons} -> ${p.uses_primary_addons}`
        );
    }
  }
  for (const idx of b.keys()) if (!a.has(idx)) diff.push(`- profile ${idx}`);
  return diff.sort();
}

export async function createProfile(
  client: NuvioClient,
  input: {
    name: string;
    profile_index?: number;
    avatar_color_hex?: string | null;
    avatar_id?: string | null;
    avatar_url?: string | null;
    uses_primary_addons?: boolean;
  },
  originId: string,
  apply: boolean
): Promise<ApplyResult<ProfilePush[]>> {
  if (!input.name.trim()) throw new NuvioError('Profile name is required');
  const before = toPushShape(await listProfiles(client));
  const used = new Set(before.map((p) => p.profile_index));
  if (used.size >= CLIENT_MAX_PROFILES) {
    throw new NuvioError(`All ${CLIENT_MAX_PROFILES} profile slots are in use.`);
  }
  let index = input.profile_index;
  if (index === undefined) {
    index = 1;
    while (used.has(index)) index += 1;
  }
  if (index < 1 || index > CLIENT_MAX_PROFILES) throw new NuvioError('profile_index must be 1..6');
  if (used.has(index)) throw new NuvioError(`Profile slot ${index} is already in use.`);

  const after = [
    ...before,
    {
      profile_index: index,
      name: input.name.trim(),
      avatar_color_hex: input.avatar_color_hex ?? null,
      uses_primary_addons: index === 1 ? false : (input.uses_primary_addons ?? false),
      uses_primary_plugins: false,
      avatar_id: input.avatar_id ?? null,
      avatar_url: input.avatar_url ?? null,
    },
  ].sort((x, y) => x.profile_index - y.profile_index);

  // Invariant: every previously existing profile is preserved verbatim.
  if (before.some((p) => !after.find((q) => q.profile_index === p.profile_index))) {
    throw new NuvioError('Internal invariant failed (profile create)');
  }

  const diff = diffProfiles(before, after);
  if (apply) {
    await client.rpc('sync_push_profiles', {
      p_client_max_profiles: CLIENT_MAX_PROFILES,
      p_origin_client_id: originId,
      p_profiles: after,
    });
  }
  return { applied: apply, changed: diff.length > 0, before, after, diff };
}

export async function updateProfile(
  client: NuvioClient,
  profileIndex: number,
  patch: {
    name?: string;
    avatar_color_hex?: string;
    avatar_id?: string | null;
    avatar_url?: string | null;
    uses_primary_addons?: boolean;
  },
  apply: boolean
): Promise<ApplyResult<Profile | null>> {
  const profiles = await listProfiles(client);
  const target = profiles.find((p) => p.profile_index === profileIndex);
  if (!target) throw new NuvioError(`Profile ${profileIndex} not found`);

  const args: Record<string, unknown> = { p_profile_id: profileIndex };
  if (patch.name !== undefined) args.p_name = patch.name;
  if (patch.avatar_color_hex !== undefined) args.p_avatar_color_hex = patch.avatar_color_hex;
  if (patch.uses_primary_addons !== undefined) args.p_uses_primary_addons = patch.uses_primary_addons;
  if ('avatar_id' in patch) {
    args.p_avatar_id = patch.avatar_id;
    args.p_avatar_id_provided = true;
  }
  if ('avatar_url' in patch) {
    args.p_avatar_url = patch.avatar_url;
    args.p_avatar_url_provided = true;
  }

  const preview = { ...target, ...patch } as Profile;
  const diff: string[] = [];
  if (patch.name !== undefined && patch.name !== target.name)
    diff.push(`name "${target.name}" -> "${patch.name}"`);
  if (patch.avatar_color_hex !== undefined && patch.avatar_color_hex !== target.avatar_color_hex)
    diff.push(`color ${target.avatar_color_hex} -> ${patch.avatar_color_hex}`);
  if ('avatar_id' in patch && patch.avatar_id !== target.avatar_id)
    diff.push(`avatar_id -> ${patch.avatar_id}`);
  if ('avatar_url' in patch && patch.avatar_url !== target.avatar_url)
    diff.push(`avatar_url -> ${patch.avatar_url}`);
  if (patch.uses_primary_addons !== undefined && patch.uses_primary_addons !== target.uses_primary_addons)
    diff.push(`uses_primary_addons -> ${patch.uses_primary_addons}`);

  if (apply && diff.length > 0) {
    await client.rpc('sync_patch_profile', args);
  }
  return {
    applied: apply && diff.length > 0,
    changed: diff.length > 0,
    before: target,
    after: preview,
    diff,
  };
}

export async function deleteProfile(
  client: NuvioClient,
  profileIndex: number,
  originId: string,
  apply: boolean
): Promise<ApplyResult<number>> {
  if (profileIndex === 1) {
    throw new NuvioError('Profile 1 is the primary profile and cannot be deleted.');
  }
  const profiles = await listProfiles(client);
  const target = profiles.find((p) => p.profile_index === profileIndex);
  if (!target) throw new NuvioError(`Profile ${profileIndex} not found`);
  const diff = [
    `- profile ${profileIndex} "${target.name}" and ALL of its data (addons, settings, collections, library, history)`,
  ];
  if (apply) {
    await client.rpc('sync_delete_profile_data', {
      p_profile_id: profileIndex,
      p_origin_client_id: originId,
    });
  }
  return { applied: apply, changed: true, before: profileIndex, after: profileIndex, diff };
}

export async function copyProfileSetup(
  client: NuvioClient,
  sourceProfileId: number,
  targetProfileId: number,
  options: {
    copy_tv?: boolean;
    copy_mobile?: boolean;
    copy_desktop?: boolean;
    copy_provider_credentials?: boolean;
    replace_provider_credentials?: boolean;
  },
  originId: string,
  apply: boolean
): Promise<ApplyResult<Record<string, unknown>>> {
  if (sourceProfileId === targetProfileId) {
    throw new NuvioError('Source and target profile must differ.');
  }
  const before = {
    source_profile_id: sourceProfileId,
    target_profile_id: targetProfileId,
    tv: options.copy_tv ?? true,
    mobile: options.copy_mobile ?? true,
    desktop: options.copy_desktop ?? false,
    provider_credentials: options.copy_provider_credentials ?? false,
    replace_provider_credentials: options.replace_provider_credentials ?? false,
  };
  const diff = [
    `~ copy setup ${sourceProfileId} -> ${targetProfileId}`,
    `  tv=${before.tv} mobile=${before.mobile} desktop=${before.desktop} credentials=${before.provider_credentials}`,
  ];
  if (apply) {
    await client.rpc('sync_copy_profile_setup', {
      p_source_profile_id: sourceProfileId,
      p_target_profile_id: targetProfileId,
      p_copy_tv: before.tv,
      p_copy_mobile: before.mobile,
      p_copy_desktop: before.desktop,
      p_copy_provider_credentials: before.provider_credentials,
      p_replace_provider_credentials: before.replace_provider_credentials,
      p_origin_client_id: originId,
    });
  }
  return { applied: apply, changed: true, before, after: before, diff };
}

export async function setProfilePin(
  client: NuvioClient,
  profileIndex: number,
  pin: string,
  currentPin: string | undefined,
  apply: boolean
): Promise<ApplyResult<number>> {
  if (!pin) throw new NuvioError('pin is required');
  if (apply) {
    await client.rpc('set_profile_pin', {
      p_profile_id: profileIndex,
      p_pin: pin,
      p_current_pin: currentPin ?? null,
    });
  }
  return {
    applied: apply,
    changed: true,
    before: profileIndex,
    after: profileIndex,
    diff: [`~ set PIN for profile ${profileIndex}`],
  };
}

export async function clearProfilePin(
  client: NuvioClient,
  profileIndex: number,
  currentPin: string | undefined,
  apply: boolean
): Promise<ApplyResult<number>> {
  if (apply) {
    await client.rpc('clear_profile_pin', {
      p_profile_id: profileIndex,
      p_current_pin: currentPin ?? null,
    });
  }
  return {
    applied: apply,
    changed: true,
    before: profileIndex,
    after: profileIndex,
    diff: [`- clear PIN for profile ${profileIndex}`],
  };
}
