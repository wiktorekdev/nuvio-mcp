import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
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
    handler: (args) => plugins.addPlugin(client, args.profile_id, args, originId, true),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_toggle_plugin',
    title: 'Enable or disable a plugin',
    description: 'Turn one plugin on or off for a profile.',
    risk: 'write',
    resource,
    schema: { profile_id: profile, url: schemeTolerantUrl, enabled: z.boolean() },
    handler: (args) => plugins.togglePlugin(client, args.profile_id, args.url, args.enabled, originId, true),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_reorder_plugins',
    title: 'Reorder plugins',
    description: 'Set plugin order. Provide every installed plugin URL exactly once, in the desired order.',
    risk: 'write',
    resource,
    schema: { profile_id: profile, ordered_urls: z.array(schemeTolerantUrl).min(1) },
    handler: (args) => plugins.reorderPlugins(client, args.profile_id, args.ordered_urls, originId, true),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_remove_plugin',
    title: 'Remove a plugin',
    description: 'Uninstall a plugin from a profile.',
    risk: 'destructive',
    resource,
    schema: { profile_id: profile, url: schemeTolerantUrl },
    handler: (args, ctx) => plugins.removePlugin(client, args.profile_id, args.url, originId, ctx.apply),
  });
}
