import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { defineMutation, defineRead } from './helpers.js';
import * as library from '../nuvio/ops/library.js';

const profile = z.number().int().min(1).max(6).default(1);
const resource = (kind: 'library' | 'watch_progress' | 'watch_history') => (args: { profile_id: number }) =>
  ({ kind, profile_id: args.profile_id }) as const;

export function registerLibraryTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  const originId = cfg.originClientId;

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

  const libraryItem = z.object({
    content_id: z.string(),
    content_type: z.string(),
    name: z.string().nullable().optional(),
    poster: z.string().nullable().optional(),
    poster_shape: z.string().nullable().optional(),
    background: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    release_info: z.string().nullable().optional(),
    imdb_rating: z.number().nullable().optional(),
    genres: z.array(z.string()).nullable().optional(),
    addon_base_url: z.string().nullable().optional(),
    added_at: z.number().int().nullable().optional(),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_add_to_library',
    title: 'Add to library',
    description: "Add or update an item in a profile's library.",
    risk: 'write',
    resource: resource('library'),
    scope: (args) => [{ content_id: args.item.content_id, content_type: args.item.content_type }],
    schema: { profile_id: profile, item: libraryItem },
    handler: (args) => library.addToLibrary(client, args.profile_id, args.item, originId, true),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_remove_from_library',
    title: 'Remove from library',
    description: "Remove items from a profile's library by content_id + content_type.",
    risk: 'destructive',
    resource: resource('library'),
    scope: (args) => args.keys,
    schema: {
      profile_id: profile,
      keys: z.array(z.object({ content_id: z.string(), content_type: z.string() })).min(1),
    },
    handler: (args, ctx) =>
      library.removeFromLibrary(client, args.profile_id, args.keys, originId, ctx.apply),
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_get_watch_progress',
    title: 'Get watch progress',
    description: 'List "continue watching" progress entries for a profile.',
    risk: 'read',
    schema: { profile_id: profile, limit: z.number().int().min(1).max(1000).default(100) },
    handler: (args) => library.getWatchProgress(client, args.profile_id, args.limit),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_set_watch_progress',
    title: 'Set watch progress',
    description: 'Create or update a continue-watching entry (position/duration) for a movie or episode.',
    risk: 'write',
    resource: resource('watch_progress'),
    scope: (args) => [
      args.entry.season != null
        ? `${args.entry.content_id}_s${args.entry.season}e${args.entry.episode}`
        : args.entry.content_id,
    ],
    schema: {
      profile_id: profile,
      entry: z.object({
        content_id: z.string(),
        content_type: z.string(),
        video_id: z.string().nullable().optional(),
        season: z.number().int().nullable().optional(),
        episode: z.number().int().nullable().optional(),
        position: z.number(),
        duration: z.number(),
        last_watched: z.number().int().nullable().optional(),
      }),
    },
    handler: (args) => library.setWatchProgress(client, args.profile_id, args.entry, originId, true),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_delete_watch_progress',
    title: 'Delete watch progress',
    description: 'Delete continue-watching entries by progress key.',
    risk: 'destructive',
    resource: resource('watch_progress'),
    scope: (args) => args.keys,
    schema: { profile_id: profile, keys: z.array(z.string()).min(1).describe('Progress keys') },
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
    name: 'nuvio_mark_watched',
    title: 'Mark as watched',
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
    schema: {
      profile_id: profile,
      item: z.object({
        content_id: z.string(),
        content_type: z.string(),
        title: z.string().nullable().optional(),
        season: z.number().int().nullable().optional(),
        episode: z.number().int().nullable().optional(),
        watched_at: z.number().int().nullable().optional(),
      }),
    },
    handler: (args) => library.markWatched(client, args.profile_id, args.item, originId, true),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_delete_watch_history',
    title: 'Delete watch history',
    description: 'Delete watch-history entries by content id (and season/episode).',
    risk: 'destructive',
    resource: resource('watch_history'),
    scope: (args) => args.keys,
    schema: {
      profile_id: profile,
      keys: z
        .array(
          z.object({
            content_id: z.string(),
            season: z.number().int().nullable().optional(),
            episode: z.number().int().nullable().optional(),
          })
        )
        .min(1),
    },
    handler: (args, ctx) =>
      library.deleteWatchHistory(client, args.profile_id, args.keys, originId, ctx.apply),
  });
}
