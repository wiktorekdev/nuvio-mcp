import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { defineMutation, defineRead } from './helpers.js';
import {
  historyAddShape,
  historyDeleteShape,
  historyItemSchema,
  libraryAddShape,
  libraryRemoveShape,
  progressDeleteShape,
  progressSetShape,
  profile,
} from '../nuvio/schemas.js';
import * as library from '../nuvio/ops/library.js';

export function registerLibraryTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  const originId = cfg.originClientId;
  const resource = (kind: 'library' | 'watch_progress' | 'watch_history') => (args: { profile_id: number }) =>
    ({ kind, profile_id: args.profile_id }) as const;

  defineRead(server, client, cfg, {
    name: 'nuvio_get_library',
    title: 'Get library',
    description: "List items in a profile's library (bookmarks/favourites).",
    risk: 'read',
    schema: {
      profile_id: profile,
      limit: z.number().int().min(1).max(1000).default(100),
      offset: z.number().int().min(0).default(0),
    },
    handler: (args) => library.getLibrary(client, args.profile_id, args.limit, args.offset),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_add_to_library',
    title: 'Add to library',
    description: 'Add or update library items in bulk (upsert by content_id + content_type).',
    risk: 'write',
    resource: resource('library'),
    scope: (args) => args.items.map((i) => ({ content_id: i.content_id, content_type: i.content_type })),
    schema: libraryAddShape,
    handler: (args, ctx) => library.addToLibrary(client, args.profile_id, args.items, originId, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_remove_from_library',
    title: 'Remove from library',
    description: "Remove items from a profile's library by content_id + content_type.",
    risk: 'destructive',
    resource: resource('library'),
    scope: (args) => args.keys,
    schema: libraryRemoveShape,
    handler: (args, ctx) =>
      library.removeFromLibrary(client, args.profile_id, args.keys, originId, ctx.apply),
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_get_watch_progress',
    title: 'Get watch progress',
    description: 'List "continue watching" progress entries for a profile.',
    risk: 'read',
    schema: { profile_id: profile, limit: z.number().int().min(1).max(100000).default(100) },
    handler: (args) => library.getWatchProgress(client, args.profile_id, args.limit),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_set_watch_progress',
    title: 'Set watch progress',
    description:
      'Create or update continue-watching entries (position/duration) for movies or episodes, in bulk.',
    risk: 'write',
    resource: resource('watch_progress'),
    scope: (args) => args.entries.map((e) => library.progressKeyOf(e)),
    schema: progressSetShape,
    handler: (args, ctx) =>
      library.setWatchProgress(client, args.profile_id, args.entries, originId, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_delete_watch_progress',
    title: 'Delete watch progress',
    description:
      'Delete continue-watching entries using structured keys (content_id + optional season/episode).',
    risk: 'destructive',
    resource: resource('watch_progress'),
    scope: (args) => args.keys.map((k) => library.progressKeyOf(k)),
    schema: progressDeleteShape,
    handler: (args, ctx) =>
      library.deleteWatchProgress(client, args.profile_id, args.keys, originId, ctx.apply),
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_get_watch_history',
    title: 'Get watch history',
    description: 'List watched items for a profile.',
    risk: 'read',
    schema: {
      profile_id: profile,
      page: z.number().int().min(1).default(1).describe('Page number (1-based)'),
      page_size: z.number().int().min(1).max(1000).default(100),
    },
    handler: (args) => library.getWatchHistory(client, args.profile_id, args.page, args.page_size),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_add_to_watch_history',
    title: 'Add to watch history',
    description:
      "Idempotently add watched items to a profile's history (upsert by content_id + season + episode). " +
      'A repeated identical call does not create a duplicate.',
    risk: 'write',
    resource: resource('watch_history'),
    scope: (args) =>
      args.items.map((i) => ({
        content_id: i.content_id,
        season: i.season ?? null,
        episode: i.episode ?? null,
      })),
    schema: historyAddShape,
    handler: (args, ctx) =>
      library.addToWatchHistory(client, args.profile_id, args.items, originId, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_delete_watch_history',
    title: 'Delete watch history',
    description: 'Delete watch-history entries by content id (and season/episode).',
    risk: 'destructive',
    resource: resource('watch_history'),
    scope: (args) => args.keys,
    schema: historyDeleteShape,
    handler: (args, ctx) =>
      library.deleteWatchHistory(client, args.profile_id, args.keys, originId, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_mark_watched',
    title: 'Mark as watched',
    canonical: false,
    replacement: 'nuvio_add_to_watch_history',
    description: "Add an entry to a profile's watch history.",
    risk: 'write',
    resource: resource('watch_history'),
    scope: (args) => [
      {
        content_id: args.item.content_id,
        season: args.item.season ?? null,
        episode: args.item.episode ?? null,
      },
    ],
    schema: { profile_id: profile, item: historyItemSchema },
    handler: (args, ctx) =>
      library.addToWatchHistory(client, args.profile_id, [args.item], originId, ctx.apply),
  });
}
