import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { defineMutation, defineRead } from './helpers.js';
import * as sessions from '../nuvio/ops/sessions.js';

export function registerSessionTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  defineRead(server, client, cfg, {
    name: 'nuvio_list_sessions',
    title: 'List signed-in devices',
    description:
      'List active login sessions/devices (device name, platform, client, last active, which is current).',
    risk: 'read',
    schema: {},
    handler: () => sessions.listSessions(client),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_revoke_session',
    title: 'Log out a device',
    description:
      'Revoke one login session (log that device out). Cannot be undone — the device must sign in again. Never deletes the account.',
    risk: 'destructive',
    resource: { kind: 'sessions' },
    reversible: false,
    note: 'revoked sessions cannot be recreated; the device needs to sign in again',
    schema: { session_id: z.uuid() },
    handler: (args, ctx) => sessions.revokeSession(client, args.session_id, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_register_device',
    title: 'Register this device',
    description:
      "Register a device/installation against the account. client_name must be one the Nuvio backend accepts (for example 'Nuvio Web'); other values are rejected by the backend.",
    risk: 'write',
    resource: { kind: 'sessions' },
    reversible: false,
    schema: {
      installation_id: z.string(),
      client_name: z.string(),
      client_version: z.string().optional(),
      device_name: z.string().optional(),
      platform: z.string().optional(),
    },
    handler: (args, ctx) =>
      sessions.registerDevice(
        client,
        {
          installation_id: args.installation_id,
          client_name: args.client_name,
          client_version: args.client_version,
          device_name: args.device_name,
          platform: args.platform,
        },
        ctx.apply
      ),
  });
}
