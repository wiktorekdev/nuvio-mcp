import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { NuvioError } from '../nuvio/errors.js';
import { defineMutation, defineRead } from './helpers.js';
import { schemeTolerantUrl } from './url.js';
import * as plugins from '../nuvio/ops/plugins.js';

export function registerPluginTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  const originId = cfg.originClientId;
  const profile = z.number().int().min(1).max(6).default(1);
  const resource = (args: { profile_id: number }) =>
    ({ kind: 'plugins', profile_id: args.profile_id }) as const;

  defineRead(server, client, cfg, {
    name: 'nuvio_list_plugins',
    title: 'List plugins',
    description: 'List plugins installed on a profile.',
    risk: 'read',
    schema: { profile_id: profile },
    handler: (args) => plugins.listPlugins(client, args.profile_id),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_add_plugin',
    title: 'Install a plugin',
    description: 'Install a plugin on a profile by URL, preserving the existing plugin list.',
    risk: 'write',
    resource,
    schema: {
      profile_id: profile,
      url: z.url(),
      name: z.string().optional(),
      repo_type: z.string().optional(),
      enabled: z.boolean().optional().default(true),
    },
    handler: (args, ctx) => plugins.addPlugin(client, args.profile_id, args, originId, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_update_plugin',
    title: 'Update a plugin',
    description:
      'Change a plugin name, enabled flag, repo type or sort order. Identify it by url or table id.',
    risk: 'write',
    resource,
    schema: {
      profile_id: profile,
      url: schemeTolerantUrl.optional(),
      id: z.uuid().optional(),
      name: z.string().nullable().optional(),
      enabled: z.boolean().optional(),
      repo_type: z.string().nullable().optional(),
      sort_order: z.number().int().optional(),
    },
    handler: (args, ctx) => {
      if (!args.url && !args.id) throw new NuvioError('Provide either url or id to identify the plugin.');
      const { profile_id, url, id, ...changes } = args;
      return plugins.updatePlugin(client, profile_id, { url, id }, changes, originId, ctx.apply);
    },
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_reorder_plugins',
    title: 'Reorder plugins',
    description: 'Set plugin order. Provide every installed plugin URL exactly once, in the desired order.',
    risk: 'write',
    resource,
    schema: { profile_id: profile, ordered_urls: z.array(schemeTolerantUrl).min(1) },
    handler: (args, ctx) =>
      plugins.reorderPlugins(client, args.profile_id, args.ordered_urls, originId, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_remove_plugin',
    title: 'Remove a plugin',
    description: 'Uninstall a plugin from a profile.',
    risk: 'destructive',
    resource,
    schema: { profile_id: profile, url: schemeTolerantUrl.optional(), id: z.uuid().optional() },
    handler: (args, ctx) => {
      if (!args.url && !args.id) throw new NuvioError('Provide either url or id to identify the plugin.');
      return plugins.removePlugin(
        client,
        args.profile_id,
        { url: args.url, id: args.id },
        originId,
        ctx.apply
      );
    },
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_toggle_plugin',
    title: 'Enable or disable a plugin',
    canonical: false,
    replacement: 'nuvio_update_plugin',
    description: 'Turn one plugin on or off for a profile.',
    risk: 'write',
    resource,
    schema: { profile_id: profile, url: schemeTolerantUrl, enabled: z.boolean() },
    handler: (args, ctx) =>
      plugins.togglePlugin(client, args.profile_id, args.url, args.enabled, originId, ctx.apply),
  });
}
