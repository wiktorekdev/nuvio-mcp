import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { defineMutation, defineRead } from './helpers.js';
import {
  assertTarget,
  pluginAddShape,
  pluginRemoveShape,
  pluginReorderShape,
  pluginUpdateShape,
  profile,
} from '../nuvio/schemas.js';
import { schemeTolerantUrl } from './url.js';
import * as plugins from '../nuvio/ops/plugins.js';

export function registerPluginTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  const originId = cfg.originClientId;
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
    schema: pluginAddShape,
    handler: (args, ctx) => plugins.addPlugin(client, args.profile_id, args, originId, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_update_plugin',
    title: 'Update a plugin',
    description:
      'Change a plugin name, enabled flag, repo type or sort order. Identify it by url or table id.',
    risk: 'write',
    resource,
    schema: pluginUpdateShape,
    handler: (args, ctx) => {
      assertTarget('nuvio_update_plugin', args);
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
    schema: pluginReorderShape,
    handler: (args, ctx) =>
      plugins.reorderPlugins(client, args.profile_id, args.ordered_urls, originId, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_remove_plugin',
    title: 'Remove a plugin',
    description: 'Uninstall a plugin from a profile.',
    risk: 'destructive',
    resource,
    schema: pluginRemoveShape,
    handler: (args, ctx) => {
      assertTarget('nuvio_remove_plugin', args);
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
