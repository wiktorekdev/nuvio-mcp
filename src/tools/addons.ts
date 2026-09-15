import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { fetchJsonFromPublicUrl } from '../nuvio/safe-fetch.js';
import { defineMutation, defineRead } from './helpers.js';
import {
  addonAddShape,
  addonRemoveShape,
  addonReorderShape,
  addonUpdateShape,
  assertTarget,
  profile,
} from '../nuvio/schemas.js';
import { schemeTolerantUrl } from './url.js';
import * as addons from '../nuvio/ops/addons.js';

export function registerAddonTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  const originId = cfg.originClientId;

  defineRead(server, client, cfg, {
    name: 'nuvio_list_addons',
    title: 'List addons',
    description: 'List the addons installed on a profile (url, name, enabled, sort_order).',
    risk: 'read',
    schema: { profile_id: profile },
    handler: (args) => addons.listAddons(client, args.profile_id),
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_inspect_addon',
    title: 'Inspect an addon manifest',
    description:
      'Fetch and summarise a Stremio/Nuvio addon manifest (name, version, resources, catalog types) before installing.',
    risk: 'read',
    schema: { url: z.url() },
    handler: async (args) => {
      const manifest = (await fetchJsonFromPublicUrl(args.url)) as Record<string, unknown>;
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        types: manifest.types,
        resources: manifest.resources,
        catalogs: Array.isArray(manifest.catalogs)
          ? (manifest.catalogs as Array<Record<string, unknown>>).map((c) => ({
              type: c.type,
              id: c.id,
              name: c.name,
            }))
          : [],
      };
    },
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_add_addon',
    title: 'Install an addon',
    description:
      'Install an addon on a profile by manifest URL. The current addon list is read and preserved; only the new addon is appended.',
    risk: 'write',
    resource: (args) => ({ kind: 'addons', profile_id: args.profile_id }),
    schema: addonAddShape,
    handler: (args, ctx) => addons.addAddon(client, args.profile_id, args, originId, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_update_addon',
    title: 'Update an addon',
    description: 'Change an addon name, enabled flag or sort order. Identify it by url or table id.',
    risk: 'write',
    resource: (args) => ({ kind: 'addons', profile_id: args.profile_id }),
    schema: addonUpdateShape,
    handler: (args, ctx) => {
      assertTarget('nuvio_update_addon', args);
      const { profile_id, url, id, ...changes } = args;
      return addons.updateAddon(client, profile_id, { url, id }, changes, originId, ctx.apply);
    },
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_reorder_addons',
    title: 'Reorder addons',
    description:
      "Set the display order of a profile's addons. Provide every installed addon URL exactly once, in the desired order.",
    risk: 'write',
    resource: (args) => ({ kind: 'addons', profile_id: args.profile_id }),
    schema: addonReorderShape,
    handler: (args, ctx) =>
      addons.reorderAddons(client, args.profile_id, args.ordered_urls, originId, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_remove_addon',
    title: 'Remove an addon',
    description: 'Uninstall one addon from a profile.',
    risk: 'destructive',
    resource: (args) => ({ kind: 'addons', profile_id: args.profile_id }),
    schema: addonRemoveShape,
    handler: (args, ctx) => {
      assertTarget('nuvio_remove_addon', args);
      return addons.removeAddon(client, args.profile_id, { url: args.url, id: args.id }, originId, ctx.apply);
    },
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_toggle_addon',
    title: 'Enable or disable an addon',
    canonical: false,
    replacement: 'nuvio_update_addon',
    description: 'Turn one addon on or off for a profile.',
    risk: 'write',
    resource: (args) => ({ kind: 'addons', profile_id: args.profile_id }),
    schema: {
      profile_id: profile,
      url: schemeTolerantUrl.optional(),
      id: z.uuid().optional(),
      enabled: z.boolean(),
    },
    handler: (args, ctx) => {
      assertTarget('nuvio_toggle_addon', args);
      return addons.updateAddon(
        client,
        args.profile_id,
        { url: args.url, id: args.id },
        { enabled: args.enabled },
        originId,
        ctx.apply
      );
    },
  });
}
