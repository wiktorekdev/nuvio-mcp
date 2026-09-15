import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { defineMutation, defineRead } from './helpers.js';
import {
  TRACKERS,
  listTrackerTokens,
  listTrackerSettings,
  setTrackerSettings,
  setTrackerToken,
  unlinkTracker,
} from '../nuvio/ops/trackers.js';

export function registerTrackerTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  const profile = z.number().int().min(1).max(6).default(1);
  const tracker = z.enum(TRACKERS).describe('Tracker: mal | anilist | kitsu');

  defineRead(server, client, cfg, {
    name: 'nuvio_list_trackers',
    title: 'List trackers',
    description:
      'List linked trackers (MAL / AniList / Kitsu) and their per-profile settings. Access tokens are masked.',
    risk: 'read',
    schema: { profile_id: profile },
    handler: async (args) => {
      const [tokens, settings] = await Promise.all([
        listTrackerTokens(client, args.profile_id),
        listTrackerSettings(client, args.profile_id),
      ]);
      const byTracker = new Map(settings.map((s) => [s.tracker, s]));
      return TRACKERS.map((name) => {
        const token = tokens.find((t) => t.tracker === name);
        const setting = byTracker.get(name);
        return {
          tracker: name,
          linked: Boolean(token),
          username: token?.tracker_username ?? null,
          expires_at: token?.expires_at ?? null,
          enabled_statuses: setting?.enabled_statuses ?? [],
          send_progress: setting?.send_progress ?? null,
        };
      });
    },
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_set_tracker_settings',
    title: 'Update tracker settings',
    description: 'Set which statuses sync, row order and progress syncing for a linked tracker.',
    risk: 'write',
    resource: (args) => ({ kind: 'tracker_settings', profile_id: args.profile_id }),
    schema: {
      profile_id: profile,
      tracker,
      enabled_statuses: z.array(z.string()).optional(),
      row_order: z.array(z.string()).optional(),
      send_progress: z.boolean().optional(),
    },
    handler: (args, ctx) =>
      setTrackerSettings(
        client,
        args.profile_id,
        args.tracker,
        {
          enabled_statuses: args.enabled_statuses,
          row_order: args.row_order,
          send_progress: args.send_progress,
        },
        ctx.apply
      ),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_link_tracker',
    title: 'Link a tracker',
    description:
      'Store tracker OAuth tokens for a profile. Use this only when tokens were obtained out-of-band; prefer the app sign-in flow.',
    risk: 'write',
    resource: (args) => ({ kind: 'tracker_tokens', profile_id: args.profile_id }),
    schema: {
      profile_id: profile,
      tracker,
      access_token: z.string().min(1),
      refresh_token: z.string().optional(),
      expires_in_seconds: z.number().int().positive().optional(),
      tracker_user_id: z.string().optional(),
      username: z.string().optional(),
    },
    handler: (args, ctx) =>
      setTrackerToken(
        client,
        args.profile_id,
        args.tracker,
        {
          access_token: args.access_token,
          refresh_token: args.refresh_token,
          expires_in_seconds: args.expires_in_seconds,
          tracker_user_id: args.tracker_user_id,
          username: args.username,
        },
        ctx.apply
      ),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_unlink_tracker',
    title: 'Unlink a tracker',
    description: 'Remove stored tokens for a tracker on a profile.',
    risk: 'destructive',
    resource: (args) => ({ kind: 'tracker_tokens', profile_id: args.profile_id }),
    schema: { profile_id: profile, tracker },
    handler: (args, ctx) => unlinkTracker(client, args.profile_id, args.tracker, ctx.apply),
  });
}
