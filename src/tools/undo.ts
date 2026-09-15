import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { NuvioError } from '../nuvio/errors.js';
import { maskDeep } from '../mask.js';
import { defineRead } from './helpers.js';
import {
  capture,
  describe,
  findLastChange,
  findLastUndo,
  getSnapshot,
  listSnapshots,
  readResource,
  restore,
} from '../nuvio/snapshots.js';

export function registerUndoTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  defineRead(server, client, cfg, {
    name: 'nuvio_list_undo',
    title: 'List available undos',
    description: 'List recent automatically-captured snapshots. Each can be reverted with nuvio_undo.',
    risk: 'read',
    schema: { limit: z.number().int().min(1).max(200).default(25) },
    handler: (args) => {
      const snapshots = listSnapshots(cfg, args.limit);
      if (snapshots.length === 0) return 'No snapshots recorded yet.';
      return snapshots.map(describe).join('\n');
    },
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_inspect_snapshot',
    title: 'Inspect a snapshot',
    description: 'Show the captured previous state of a snapshot (secrets masked).',
    risk: 'read',
    annotations: { readOnlyHint: true },
    schema: { snapshot_id: z.string() },
    handler: (args) => {
      const snapshot = getSnapshot(cfg, args.snapshot_id);
      if (!snapshot) throw new NuvioError(`Snapshot ${args.snapshot_id} not found.`);
      return {
        id: snapshot.id,
        ts: snapshot.ts,
        tool: snapshot.tool,
        resource: snapshot.resource,
        reversible: snapshot.reversible,
        sensitive: snapshot.sensitive,
        note: snapshot.note,
        before: maskDeep(snapshot.before),
      };
    },
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_undo',
    title: 'Undo a change',
    description:
      'Revert a previous change using its snapshot. Defaults to the most recent change. Snapshots the current state first, so an undo can itself be undone.',
    risk: 'write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    schema: {
      snapshot_id: z
        .string()
        .optional()
        .describe('Snapshot id from nuvio_list_undo. Omit to undo the most recent change.'),
    },
    handler: async (args) => {
      const target = args.snapshot_id ? getSnapshot(cfg, args.snapshot_id) : findLastChange(cfg);
      if (!target) {
        throw new NuvioError(
          args.snapshot_id ? `Snapshot ${args.snapshot_id} not found.` : 'There is nothing to undo.'
        );
      }
      if (!target.reversible) {
        throw new NuvioError(
          `Snapshot ${target.id} (${target.tool}) is not reversible${target.note ? ` — ${target.note}` : ''}.`
        );
      }
      if (!cfg.disableSnapshots) {
        const current = await readResource(client, target.resource);
        capture(cfg, client, {
          tool: 'nuvio_undo',
          resource: target.resource,
          before: current,
          reversible: true,
          note: `state before undoing ${target.id}`,
        });
      }
      const message = await restore(client, cfg, target);
      const suffix = cfg.disableSnapshots
        ? ' Snapshots are disabled, so this undo cannot itself be undone.'
        : '';
      return `${message} Reverted snapshot ${target.id} (${target.tool}).${suffix}`;
    },
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_redo',
    title: 'Redo an undone change',
    description:
      'Re-apply the change that the most recent nuvio_undo reverted. Snapshots current state first.',
    risk: 'write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    schema: {},
    handler: async () => {
      const target = findLastUndo(cfg);
      if (!target) throw new NuvioError('There is nothing to redo.');
      if (!cfg.disableSnapshots) {
        const current = await readResource(client, target.resource);
        capture(cfg, client, {
          tool: 'nuvio_redo',
          resource: target.resource,
          before: current,
          reversible: true,
          note: `state before redoing ${target.id}`,
        });
      }
      const message = await restore(client, cfg, target);
      const suffix = cfg.disableSnapshots ? ' Snapshot writing is disabled; this redo was not recorded.' : '';
      return `${message} Re-applied snapshot ${target.id}.${suffix}`;
    },
  });
}
