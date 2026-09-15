import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { defineMutation, defineRead } from './helpers.js';
import * as settings from '../nuvio/ops/settings.js';

const platform = z.string().default('tv').describe('Platform namespace: tv | mobile | desktop | web');
const profile = z.number().int().min(1).max(6).default(1);

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
      "Shallow-merge top-level keys into a profile's settings blob. For nested keys use nuvio_set_setting.",
    risk: 'write',
    resource: settingsResource,
    schema: { profile_id: profile, platform, settings: z.record(z.string(), z.unknown()) },
    handler: (args) =>
      settings.updateSettings(client, args.profile_id, args.platform, args.settings, originId, true),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_set_setting',
    title: 'Set a nested setting',
    description:
      "Set one nested value by dot path (e.g. 'features.player_settings.auto_play_next' or 'rows.0.height'). Creates intermediate objects/arrays as needed.",
    risk: 'write',
    resource: settingsResource,
    schema: {
      profile_id: profile,
      platform,
      path: z.string().min(1).describe('Dot path into settings_json'),
      value: z.unknown().describe('Any JSON value'),
    },
    handler: (args) =>
      settings.setSetting(client, args.profile_id, args.platform, args.path, args.value, originId, true),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_unset_setting',
    title: 'Unset a nested setting',
    description: 'Delete one nested value by dot path from the settings blob.',
    risk: 'write',
    resource: settingsResource,
    schema: { profile_id: profile, platform, path: z.string().min(1) },
    handler: (args) =>
      settings.unsetSetting(client, args.profile_id, args.platform, args.path, originId, true),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_copy_settings',
    title: 'Copy settings between profiles/platforms',
    description:
      "Replace the target's settings blob with a copy of the source's. Works across profiles and platforms (e.g. tv -> mobile).",
    risk: 'write',
    resource: (args) => ({ kind: 'settings', profile_id: args.to_profile_id, platform: args.to_platform }),
    schema: {
      from_profile_id: profile,
      from_platform: platform,
      to_profile_id: profile,
      to_platform: platform,
    },
    handler: (args) =>
      settings.copySettings(
        client,
        { profile_id: args.from_profile_id, platform: args.from_platform },
        { profile_id: args.to_profile_id, platform: args.to_platform },
        originId,
        true
      ),
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_get_home_catalog_settings',
    title: 'Get home catalog settings',
    description: 'Read the home screen layout/catalog configuration for a profile on a platform.',
    risk: 'read',
    schema: { profile_id: profile, platform },
    handler: (args) => settings.getHomeCatalogSettings(client, args.profile_id, args.platform),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_update_home_catalog_settings',
    title: 'Update home catalog settings',
    description: 'Shallow-merge keys (e.g. rows, hidden_catalogs) into the home catalog settings blob.',
    risk: 'write',
    resource: homeResource,
    schema: { profile_id: profile, platform, settings: z.record(z.string(), z.unknown()) },
    handler: (args) =>
      settings.updateHomeCatalogSettings(
        client,
        args.profile_id,
        args.platform,
        args.settings,
        originId,
        true
      ),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_set_home_catalog_path',
    title: 'Set a nested home catalog value',
    description: 'Set one nested value by dot path inside the home catalog settings blob.',
    risk: 'write',
    resource: homeResource,
    schema: { profile_id: profile, platform, path: z.string().min(1), value: z.unknown() },
    handler: (args) =>
      settings.setHomeCatalogPath(
        client,
        args.profile_id,
        args.platform,
        args.path,
        args.value,
        originId,
        true
      ),
  });
}
