import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { defineMutation, defineRead } from './helpers.js';
import {
  PROVIDER_CREDENTIAL_FIELD,
  listProviderCredentials,
  setProviderCredential,
  deleteProviderCredential,
  testProviderCredential,
} from '../nuvio/ops/providers.js';
import { providerSetShape } from '../nuvio/schemas.js';

export function registerProviderTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  const originId = cfg.originClientId;
  const profile = z.number().int().min(1).max(6).default(1);
  const resource = (args: { profile_id: number }) =>
    ({ kind: 'provider_credentials', profile_id: args.profile_id }) as const;

  defineRead(server, client, cfg, {
    name: 'nuvio_list_provider_credentials',
    title: 'List provider credentials',
    description:
      'List configured providers for a profile (debrid services, TMDB, MDBList, AniSkip, IntroDB). Secret values are masked.',
    risk: 'read',
    schema: { profile_id: profile },
    handler: async (args) => {
      const rows = await listProviderCredentials(client, args.profile_id);
      return {
        supported_providers: Object.keys(PROVIDER_CREDENTIAL_FIELD),
        configured: rows.map((row) => ({
          provider: row.provider,
          configured: true,
          updated_at: row.updated_at,
        })),
      };
    },
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_set_provider_credential',
    title: 'Set a provider credential',
    description:
      'Store an API key for a provider: debrid:torbox, debrid:premiumize, debrid:realdebrid, tmdb, mdblist, introdb (api key) or animeskip (client id).',
    risk: 'write',
    resource,
    schema: providerSetShape,
    handler: (args, ctx) =>
      setProviderCredential(client, args.profile_id, args.provider, args.api_key, originId, ctx.apply),
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_test_provider_credential',
    title: 'Test a provider credential',
    description:
      'Verify a provider credential without storing it. The secret is never returned or logged; the result ' +
      'reports format validity and, where the provider exposes a cheap endpoint, a live check.',
    risk: 'read',
    schema: {
      provider: z.string().describe('One of the supported provider ids'),
      api_key: z.string().min(1).describe('API key / client id value to verify'),
    },
    handler: (args) => testProviderCredential(args.provider, args.api_key),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_delete_provider_credential',
    title: 'Delete a provider credential',
    description: 'Remove a stored provider credential from a profile.',
    risk: 'destructive',
    resource,
    schema: { profile_id: profile, provider: z.string() },
    handler: (args, ctx) =>
      deleteProviderCredential(client, args.profile_id, args.provider, originId, ctx.apply),
  });
}
