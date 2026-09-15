import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { defineMutation, defineRead } from './helpers.js';
import * as collections from '../nuvio/ops/collections.js';

const sourceSchema = z.object({
  addonId: z.string(),
  type: z.string(),
  catalogId: z.string(),
});

const folderSchema = z.object({
  id: z.string(),
  title: z.string(),
  coverImageUrl: z.string().optional(),
  coverEmoji: z.string().optional(),
  tileShape: z.enum(['POSTER', 'LANDSCAPE', 'SQUARE']).optional(),
  hideTitle: z.boolean().optional(),
  catalogSources: z.array(sourceSchema).optional(),
});

const collectionSchema = z.object({
  id: z.string(),
  title: z.string(),
  backdropImageUrl: z.string().optional(),
  pinToTop: z.boolean().optional(),
  viewMode: z.enum(['TABBED_GRID', 'ROWS', 'FOLLOW_LAYOUT']).optional(),
  showAllTab: z.boolean().optional(),
  folders: z.array(folderSchema).optional(),
});

type FolderInput = z.infer<typeof folderSchema>;
type CollectionInput = z.infer<typeof collectionSchema>;

const normalizeFolder = (folder: FolderInput) => ({ ...folder, catalogSources: folder.catalogSources ?? [] });
const normalizeCollection = (collection: CollectionInput) => ({
  ...collection,
  folders: (collection.folders ?? []).map(normalizeFolder),
});

export function registerCollectionTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  const originId = cfg.originClientId;
  const profile = z.number().int().min(1).max(6).default(1);
  const resource = (args: { profile_id: number }) =>
    ({ kind: 'collections', profile_id: args.profile_id }) as const;

  defineRead(server, client, cfg, {
    name: 'nuvio_list_collections',
    title: 'List collections',
    description: "List a profile's custom collections (titles, view mode, folders, catalog sources).",
    risk: 'read',
    schema: { profile_id: profile },
    handler: (args) => collections.getCollections(client, args.profile_id),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_create_collection',
    title: 'Create a collection',
    description: 'Add a new collection to a profile.',
    risk: 'write',
    resource,
    schema: { profile_id: profile, collection: collectionSchema },
    handler: (args) =>
      collections.createCollection(
        client,
        args.profile_id,
        normalizeCollection(args.collection),
        originId,
        true
      ),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_update_collection',
    title: 'Update a collection',
    description: "Edit a collection's title, view mode, pin state or replace its folder list.",
    risk: 'write',
    resource,
    schema: {
      profile_id: profile,
      collection_id: z.string(),
      changes: collectionSchema.omit({ id: true }).partial(),
    },
    handler: (args) => {
      const { folders, ...rest } = args.changes;
      const changes = folders ? { ...rest, folders: folders.map(normalizeFolder) } : rest;
      return collections.updateCollection(
        client,
        args.profile_id,
        args.collection_id,
        changes,
        originId,
        true
      );
    },
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_delete_collection',
    title: 'Delete a collection',
    description: 'Remove a collection from a profile.',
    risk: 'destructive',
    resource,
    schema: { profile_id: profile, collection_id: z.string() },
    handler: (args, ctx) =>
      collections.deleteCollection(client, args.profile_id, args.collection_id, originId, ctx.apply),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_add_collection_folder',
    title: 'Add a folder to a collection',
    description: 'Append a folder (with catalog sources) to an existing collection.',
    risk: 'write',
    resource,
    schema: { profile_id: profile, collection_id: z.string(), folder: folderSchema },
    handler: (args) =>
      collections.addFolder(
        client,
        args.profile_id,
        args.collection_id,
        normalizeFolder(args.folder),
        originId,
        true
      ),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_update_collection_folder',
    title: 'Update a collection folder',
    description: "Edit a folder's title, cover, tile shape or catalog sources.",
    risk: 'write',
    resource,
    schema: {
      profile_id: profile,
      collection_id: z.string(),
      folder_id: z.string(),
      changes: folderSchema.omit({ id: true }).partial(),
    },
    handler: (args) =>
      collections.updateFolder(
        client,
        args.profile_id,
        args.collection_id,
        args.folder_id,
        args.changes,
        originId,
        true
      ),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_remove_collection_folder',
    title: 'Remove a collection folder',
    description: 'Remove a folder from a collection.',
    risk: 'destructive',
    resource,
    schema: { profile_id: profile, collection_id: z.string(), folder_id: z.string() },
    handler: (args, ctx) =>
      collections.removeFolder(
        client,
        args.profile_id,
        args.collection_id,
        args.folder_id,
        originId,
        ctx.apply
      ),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_reorder_collections',
    title: 'Reorder collections',
    description: 'Set collection order. Provide every collection id exactly once, in the desired order.',
    risk: 'write',
    resource,
    schema: { profile_id: profile, ordered_ids: z.array(z.string()).min(1) },
    handler: (args) =>
      collections.reorderCollections(client, args.profile_id, args.ordered_ids, originId, true),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_duplicate_collection',
    title: 'Duplicate a collection',
    description:
      'Copy a collection (including folders and catalog sources) under a new id, placed right after the source.',
    risk: 'write',
    resource,
    schema: {
      profile_id: profile,
      collection_id: z.string(),
      new_id: z.string(),
      new_title: z.string().optional(),
    },
    handler: (args) =>
      collections.duplicateCollection(
        client,
        args.profile_id,
        args.collection_id,
        args.new_id,
        args.new_title,
        originId,
        true
      ),
  });

  defineMutation(server, client, cfg, {
    name: 'nuvio_reorder_collection_folders',
    title: 'Reorder folders in a collection',
    description:
      'Set folder order. Provide every folder id in the collection exactly once, in the desired order.',
    risk: 'write',
    resource,
    schema: {
      profile_id: profile,
      collection_id: z.string(),
      ordered_folder_ids: z.array(z.string()).min(1),
    },
    handler: (args) =>
      collections.reorderCollectionFolders(
        client,
        args.profile_id,
        args.collection_id,
        args.ordered_folder_ids,
        originId,
        true
      ),
  });
}
