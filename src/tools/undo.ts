import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { NuvioError } from '../nuvio/errors.js';
import { maskDeep } from '../mask.js';
import { defineLocalMutation, defineRead } from './helpers.js';
import {
  capture,
  captureComposite,
  describe,
  findLastChange,
  findLastUndo,
  getSnapshot,
  listSnapshots,
  pruneSnapshots,
  readResource,
  restore,
  snapshotResources,
  type Snapshot,
  type SnapshotResourceEntry,
} from '../nuvio/snapshots.js';

async function captureBefore(
  client: NuvioClient,
  cfg: NuvioConfig,
  tool: string,
  snapshot: Snapshot
): Promise<void> {
  if (cfg.disableSnapshots) return;
  const entries: SnapshotResourceEntry[] = [];
  for (const entry of snapshotResources(snapshot)) {
    entries.push({ resource: entry.resource, before: await readResource(client, entry.resource) });
  }
  if (entries.length === 0) return;
  if (entries.length === 1) {
    capture(cfg, client, {
      tool,
      resource: entries[0].resource,
      before: entries[0].before,
      reversible: true,
      note: `state before ${tool === 'nuvio_undo' ? 'undoing' : 'redoing'} ${snapshot.id}`,
    });
  } else {
    captureComposite(cfg, client, {
      tool,
      entries,
      reversible: true,
      note: `state before ${tool === 'nuvio_undo' ? 'undoing' : 'redoing'} ${snapshot.id}`,
    });
  }
}

function formatReport(report: {
  ok: boolean;
  outcomes: Array<{ resource: string; profile_id?: number; platform?: string; ok: boolean; message: string }>;
}): string {
  return report.outcomes
    .map((o) => {
      const where = `${o.resource}${o.profile_id !== undefined ? ` profile ${o.profile_id}` : ''}${o.platform ? `/${o.platform}` : ''}`;
      return `${o.ok ? '✓' : '✗'} ${where}: ${o.message}`;
    })
    .join('\n');
}

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
        composite: snapshot.composite ?? false,
        resources: snapshotResources(snapshot).map((e) => ({
          resource: e.resource,
          before: maskDeep(e.before),
        })),
        reversible: snapshot.reversible,
        sensitive: snapshot.sensitive,
        note: snapshot.note,
      };
    },
  });

  defineRead(server, client, cfg, {
    name: 'nuvio_undo',
    title: 'Undo a change',
    description:
      'Revert a previous change using its snapshot (single or composite). Defaults to the most recent change. ' +
      'Snapshots the current state first, so an undo can itself be undone.',
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
      await captureBefore(client, cfg, 'nuvio_undo', target);
      const report = await restore(client, cfg, target);
      const suffix = cfg.disableSnapshots
        ? ' Snapshots are disabled, so this undo cannot itself be undone.'
        : '';
      const failed = report.outcomes.filter((o) => !o.ok).length;
      return (
        `${report.ok ? 'Reverted' : `Partially reverted (${failed} failed)`} snapshot ${target.id} (${target.tool}).` +
        `\n${formatReport(report)}${suffix}`
      );
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
      await captureBefore(client, cfg, 'nuvio_redo', target);
      const report = await restore(client, cfg, target);
      const suffix = cfg.disableSnapshots ? ' Snapshot writing is disabled; this redo was not recorded.' : '';
      const failed = report.outcomes.filter((o) => !o.ok).length;
      return (
        `${report.ok ? 'Re-applied' : `Partially re-applied (${failed} failed)`} snapshot ${target.id}.` +
        `\n${formatReport(report)}${suffix}`
      );
    },
  });

  defineLocalMutation(server, client, cfg, {
    name: 'nuvio_prune_snapshots',
    title: 'Prune snapshots',
    description:
      'Delete old snapshot files according to retention limits (age, count, total size). Local-only; defaults to dry_run.',
    risk: 'destructive',
    schema: {
      older_than_days: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Delete snapshots older than N days (0 disables).'),
      keep_last: z.number().int().min(0).optional().describe('Always keep the newest N snapshots.'),
      max_total_bytes: z.number().int().min(0).optional().describe('Keep total snapshot bytes under this.'),
    },
    handler: async (args, ctx) => {
      const result = pruneSnapshots(cfg, {
        olderThanDays: args.older_than_days,
        keepLast: args.keep_last,
        maxCount: 0,
        maxTotalBytes: args.max_total_bytes,
        dryRun: !ctx.apply,
      });
      const diff = result.removed.map((r) => `- ${r.id} (${r.reason}, ${r.bytes} bytes)`);
      return { changed: result.removed.length > 0, applied: ctx.apply, diff };
    },
  });
}
