import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { defineMutation, defineRead } from './helpers.js';
import * as profiles from '../nuvio/ops/profiles.js';

export function registerProfileTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  const originId = cfg.originClientId;
  const index = z.number().int().min(1).max(6);

  defineRead(server, client, cfg, {
    name: 'nuvio_list_profiles',
    title: 'List Nuvio profiles',
    description: 'List all profiles (index 1..6, name, avatar, flags, PIN lock state).',
    risk: 'read',
    schema: {},
    handler: () => profiles.listProfiles(client),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_create_profile',
    title: 'Create a Nuvio profile',
    description: 'Add a new profile, preserving every existing one. Max 6 profiles; profile 1 is primary.',
    risk: 'write',
    resource: { kind: 'profiles' },
    schema: {
      name: z.string().min(1),
      profile_index: index.optional().describe('Slot 1..6; auto-picked if omitted'),
      avatar_color_hex: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      avatar_id: z.string().optional().describe('Avatar catalog id (see nuvio_list_avatars)'),
      avatar_url: z.url().optional(),
      uses_primary_addons: z.boolean().optional().describe('Share addons with profile 1'),
    },
    handler: (args) =>
      profiles.createProfile(client, args as Parameters<typeof profiles.createProfile>[1], originId, true),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_update_profile',
    title: 'Update a Nuvio profile',
    description: 'Sparsely update one profile (name, avatar color, avatar id/url, uses_primary_addons).',
    risk: 'write',
    resource: { kind: 'profiles' },
    schema: {
      profile_index: index,
      name: z.string().min(1).optional(),
      avatar_color_hex: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
      avatar_id: z.string().nullable().optional(),
      avatar_url: z.url().nullable().optional(),
      uses_primary_addons: z.boolean().optional(),
    },
    handler: (args) =>
      profiles.updateProfile(
        client,
        args.profile_index,
        {
          name: args.name,
          avatar_color_hex: args.avatar_color_hex,
          ...('avatar_id' in args ? { avatar_id: args.avatar_id } : {}),
          ...('avatar_url' in args ? { avatar_url: args.avatar_url } : {}),
          uses_primary_addons: args.uses_primary_addons,
        },
        true
      ),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_delete_profile',
    title: 'Delete a Nuvio profile',
    description:
      'Delete a profile and ALL of its data (addons, settings, collections, library, history). Profile 1 cannot be deleted and this cannot be undone.',
    risk: 'destructive',
    resource: { kind: 'profiles' },
    reversible: false,
    note: 'profile data is deleted permanently and cannot be restored from a snapshot',
    schema: { profile_index: index.min(2) },
    handler: (args, ctx) => profiles.deleteProfile(client, args.profile_index, originId, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_copy_profile_setup',
    title: 'Copy setup between profiles',
    description:
      'Copy TV/mobile/desktop settings (and optionally provider credentials) from one profile to another.',
    risk: 'write',
    resource: (args) => ({ kind: 'profile_setup', profile_id: args.target_profile_id }),
    schema: {
      source_profile_id: index,
      target_profile_id: index,
      copy_tv: z.boolean().optional().default(true),
      copy_mobile: z.boolean().optional().default(true),
      copy_desktop: z.boolean().optional().default(false),
      copy_provider_credentials: z.boolean().optional().default(false),
      replace_provider_credentials: z.boolean().optional().default(false),
    },
    handler: (args) =>
      profiles.copyProfileSetup(
        client,
        args.source_profile_id,
        args.target_profile_id,
        {
          copy_tv: args.copy_tv,
          copy_mobile: args.copy_mobile,
          copy_desktop: args.copy_desktop,
          copy_provider_credentials: args.copy_provider_credentials,
          replace_provider_credentials: args.replace_provider_credentials,
        },
        originId,
        true
      ),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_set_profile_pin',
    title: 'Set a profile PIN',
    description: 'Set or change the PIN lock on a profile. Not reversible (the PIN hash is never returned).',
    risk: 'destructive',
    resource: { kind: 'profiles' },
    reversible: false,
    note: 'PIN changes cannot be reversed automatically',
    schema: { profile_index: index, pin: z.string().min(1), current_pin: z.string().optional() },
    handler: (args, ctx) =>
      profiles.setProfilePin(client, args.profile_index, args.pin, args.current_pin, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_clear_profile_pin',
    title: 'Clear a profile PIN',
    description: 'Remove the PIN lock from a profile. Not reversible.',
    risk: 'destructive',
    resource: { kind: 'profiles' },
    reversible: false,
    note: 'PIN changes cannot be reversed automatically',
    schema: { profile_index: index, current_pin: z.string().optional() },
    handler: (args, ctx) => profiles.clearProfilePin(client, args.profile_index, args.current_pin, ctx.apply),
  });
}
