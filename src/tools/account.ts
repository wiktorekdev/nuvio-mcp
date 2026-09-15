import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { defineMutation, defineRead } from './helpers.js';
import * as account from '../nuvio/ops/account.js';

export function registerAccountTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  defineRead(server, client, cfg, {
    name: 'nuvio_whoami',
    title: 'Get current account',
    description: 'Return the signed-in Nuvio account and the backend URL.',
    risk: 'read',
    schema: {},
    handler: async () => ({ backend_url: client.backendUrl, account: await account.getAccount(client) }),
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_sync_overview',
    title: 'Get data overview',
    description: 'Summary counts of profiles, addons, plugins, library items, watch progress and history.',
    risk: 'read',
    schema: {},
    handler: () => account.getSyncOverview(client),
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_list_avatars',
    title: 'List avatars',
    description: 'List avatar catalog ids available for profile avatars.',
    risk: 'read',
    schema: {},
    handler: () => account.listAvatars(client),
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_health',
    title: 'Backend health check',
    description: 'Ping the Nuvio backend database.',
    risk: 'read',
    schema: {},
    handler: () => account.health(client),
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_export_backup',
    title: 'Export account backup',
    description:
      'Export account data as a JSON backup (profiles, addons, plugins, library, progress, history, settings, ' +
      'collections). Credentials and tokens are excluded server-side. With no scope this is a full backup; pass ' +
      'scope/profile_ids/platforms to narrow it.',
    risk: 'read',
    schema: {
      scope: z.array(z.string()).optional().describe('Sections to include (e.g. settings, addons)'),
      profile_ids: z.array(z.number().int().min(1).max(6)).optional().describe('Only these profiles'),
      platforms: z.array(z.string()).optional().describe('Only these setting platforms'),
    },
    handler: (args) =>
      account.exportBackup(client, {
        scope: args.scope,
        profile_ids: args.profile_ids,
        platforms: args.platforms,
      }),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_restore_backup',
    title: 'Restore account backup',
    description:
      'Replace account data from a backup produced by nuvio_export_backup. Only available on self-hosted backends that expose sync_restore_account_backup. High risk: overwrites profiles/addons/library/settings.',
    risk: 'destructive',
    resource: { kind: 'profiles' },
    reversible: false,
    note: 'restore replaces wide account state; revert is not attempted',
    schema: { backup: z.record(z.string(), z.unknown()).describe('Backup JSON from nuvio_export_backup') },
    handler: (args, ctx) => account.restoreBackup(client, args.backup, ctx.apply),
  });
}
