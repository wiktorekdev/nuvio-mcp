import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { defineMutation, defineRead } from './helpers.js';
import * as settings from '../nuvio/ops/settings.js';

const platform = z.string().default('tv').describe('Platform namespace: tv | mobile | desktop | web');
const profile = z.number().int().min(1).max(6).default(1);

const editShape = {
  patch: z.record(z.string(), z.unknown()).optional().describe('Deep-merged into the settings tree.'),
  set: z
    .array(z.object({ path: z.string().min(1), value: z.unknown() }))
    .optional()
    .describe('Set nested values by dot path, applied after patch.'),
  unset: z.array(z.string().min(1)).optional().describe('Delete nested keys by dot path, applied last.'),
};

export function registerSettingsTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  const originId = cfg.originClientId;
  const settingsResource = (args: { profile_id: number; platform: string }) =>
    ({ kind: 'settings', profile_id: args.profile_id, platform: args.platform }) as const;
  const homeResource = (args: { profile_id: number; platform: string }) =>
    ({ kind: 'home_catalog_settings', profile_id: args.profile_id, platform: args.platform }) as const;

  defineRead(server, client, cfg, {
    name: 'nuvio_get_settings',
    title: 'Get profile settings',
    description: 'Read the JSON settings blob for a profile on a platform.',
    risk: 'read',
    schema: { profile_id: profile, platform },
    handler: (args) => settings.getSettings(client, args.profile_id, args.platform),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_update_settings',
    title: 'Update profile settings',
    description:
      'Update a profile settings blob. `patch` is deep-merged (nested keys are preserved, arrays and scalars ' +
      'replace), `set` assigns nested dot paths and `unset` deletes them — applied in the order patch, set, unset. ' +
      'This is the canonical replacement for nuvio_set_setting / nuvio_unset_setting.',
    risk: 'write',
    resource: settingsResource,
    schema: { profile_id: profile, platform, ...editShape },
    handler: (args, ctx) =>
      settings.updateSettings(client, args.profile_id, args.platform, args, originId, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_update_home_catalog_settings',
    title: 'Update home catalog settings',
    description:
      'Update the home screen layout/catalog blob with the same patch/set/unset semantics as nuvio_update_settings.',
    risk: 'write',
    resource: homeResource,
    schema: { profile_id: profile, platform, ...editShape },
    handler: (args, ctx) =>
      settings.updateHomeCatalogSettings(client, args.profile_id, args.platform, args, originId, ctx.apply),
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_get_home_catalog_settings',
    title: 'Get home catalog settings',
    description: 'Read the home screen layout/catalog configuration for a profile on a platform.',
    risk: 'read',
    schema: { profile_id: profile, platform },
    handler: (args) => settings.getHomeCatalogSettings(client, args.profile_id, args.platform),
  });

  // ---------------------------------------------------------------------------
  // Deprecated aliases (kept for compatibility; superseded by the tools above).
  // ---------------------------------------------------------------------------
  defineMutation(server, client, cfg, {
    name: 'nuvio_set_setting',
    title: 'Set a nested setting',
    canonical: false,
    replacement: 'nuvio_update_settings',
    description: 'Set one nested value by dot path.',
    risk: 'write',
    resource: settingsResource,
    schema: { profile_id: profile, platform, path: z.string().min(1), value: z.unknown() },
    handler: (args, ctx) =>
      settings.updateSettings(
        client,
        args.profile_id,
        args.platform,
        { set: [{ path: args.path, value: args.value }] },
        originId,
        ctx.apply
      ),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_unset_setting',
    title: 'Unset a nested setting',
    canonical: false,
    replacement: 'nuvio_update_settings',
    description: 'Delete one nested value by dot path.',
    risk: 'write',
    resource: settingsResource,
    schema: { profile_id: profile, platform, path: z.string().min(1) },
    handler: (args, ctx) =>
      settings.updateSettings(
        client,
        args.profile_id,
        args.platform,
        { unset: [args.path] },
        originId,
        ctx.apply
      ),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_set_home_catalog_path',
    title: 'Set a nested home catalog value',
    canonical: false,
    replacement: 'nuvio_update_home_catalog_settings',
    description: 'Set one nested value by dot path inside the home catalog settings blob.',
    risk: 'write',
    resource: homeResource,
    schema: { profile_id: profile, platform, path: z.string().min(1), value: z.unknown() },
    handler: (args, ctx) =>
      settings.updateHomeCatalogSettings(
        client,
        args.profile_id,
        args.platform,
        { set: [{ path: args.path, value: args.value }] },
        originId,
        ctx.apply
      ),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_copy_settings',
    title: 'Copy settings between profiles/platforms',
    canonical: false,
    replacement: 'nuvio_copy_setup',
    description: "Replace the target's settings blob with a copy of the source's.",
    risk: 'write',
    resource: (args) => ({ kind: 'settings', profile_id: args.to_profile_id, platform: args.to_platform }),
    schema: {
      from_profile_id: profile,
      from_platform: platform,
      to_profile_id: profile,
      to_platform: platform,
    },
    handler: (args, ctx) =>
      settings.copySettings(
        client,
        { profile_id: args.from_profile_id, platform: args.from_platform },
        { profile_id: args.to_profile_id, platform: args.to_platform },
        originId,
        ctx.apply
      ),
  });
}
