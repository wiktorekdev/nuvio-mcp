import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import type { ApplyResult } from '../nuvio/types.js';
import { withCallCache } from '../nuvio/call-context.js';
import { NuvioError } from '../nuvio/errors.js';
import {
  capture,
  captureComposite,
  getSnapshot,
  readResource,
  removeSnapshot,
  restore,
  SnapshotError,
  type ResourceRef,
  type Snapshot,
} from '../nuvio/snapshots.js';
import { applyPlan, type PlanOperation, type PlanResult } from '../nuvio/ops/plan.js';
import { ConfirmationGate } from '../nuvio/confirm.js';
import { maskDeep } from '../mask.js';

export type Risk = 'read' | 'write' | 'destructive';

export interface ExecCtx {
  client: NuvioClient;
  config: NuvioConfig;
  /** True when the write should be performed (i.e. not a dry run and confirmed). */
  apply: boolean;
  /** True when the caller asked only for the diff. */
  dryRun: boolean;
  /** Cached pre-change state of the mutation's resource, if it has one. */
  before: unknown;
  /** Read any resource with per-call caching (at most one backend request per resource). */
  read: (ref: ResourceRef) => Promise<unknown>;
}

interface CommonSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  risk: Risk;
  schema: S;
  annotations?: ToolAnnotations;
  /** False for legacy aliases; they stay callable but are hidden from capabilities. */
  canonical?: boolean;
  /** Replacement tool name for deprecated aliases. */
  replacement?: string;
}

export interface ReadSpec<S extends z.ZodRawShape> extends CommonSpec<S> {
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ExecCtx) => Promise<unknown> | unknown;
}

export interface MutationSpec<S extends z.ZodRawShape> extends CommonSpec<S> {
  /** Which slice of state this mutation touches; used for the mandatory pre-change snapshot. */
  resource: ResourceRef | ((args: z.infer<z.ZodObject<S>>) => ResourceRef);
  /** Identities the mutation touches, for precise, truncation-safe undo. */
  scope?: (args: z.infer<z.ZodObject<S>>) => unknown;
  /** False for operations a snapshot cannot truly reverse (delete profile, PIN, sessions, restore). */
  reversible?: boolean;
  note?: string;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ExecCtx) => Promise<ApplyResult<unknown>>;
}

/** A destructive operation that only affects local MCP state (no backend resource). */
export interface LocalMutationSpec<S extends z.ZodRawShape> extends CommonSpec<S> {
  handler: (
    args: z.infer<z.ZodObject<S>>,
    ctx: ExecCtx
  ) => Promise<{ changed: boolean; applied: boolean; diff: string[] }>;
}

export interface RegisteredToolInfo {
  name: string;
  title: string;
  risk: Risk;
  description: string;
  canonical: boolean;
  replacement?: string;
}

export const registry: RegisteredToolInfo[] = [];

/** Per-process confirmation gate for irreversible operations. */
export const confirmationGate = new ConfirmationGate();

const AUDIT_MAX_BYTES = 5 * 1024 * 1024;

function audit(cfg: NuvioConfig, entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(cfg.auditFile), { recursive: true, mode: 0o700 });
    try {
      if (statSync(cfg.auditFile).size > AUDIT_MAX_BYTES) {
        renameSync(cfg.auditFile, `${cfg.auditFile}.1`);
      }
    } catch {
      /* the audit file does not exist yet */
    }
    appendFileSync(
      cfg.auditFile,
      `${JSON.stringify({ ts: new Date().toISOString(), ...(maskDeep(entry) as Record<string, unknown>) })}\n`,
      { mode: 0o600 }
    );
  } catch {
    /* auditing is best-effort; never break a tool call */
  }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], isError };
}

function jsonBlock(data: unknown): string {
  return '```json\n' + JSON.stringify(maskDeep(data), null, 2) + '\n```';
}

function diffLines(lines: string[]): string {
  return lines.length ? lines.map((d) => `  - ${d}`).join('\n') : '  (no field changes)';
}

function formatPreview(title: string, result: ApplyResult<unknown>, extra?: string): string {
  return `📝 Preview for ${title} — nothing was written.\n\nChanges:\n${diffLines(result.diff)}${extra ?? ''}`;
}

function formatApplied(
  title: string,
  result: ApplyResult<unknown>,
  snapshotId?: string,
  snapshotsDisabled?: boolean
): string {
  if (!result.changed) return `No changes required for ${title}.`;
  let undo: string;
  if (snapshotsDisabled) {
    undo = '\n\nSnapshots are disabled (NUVIO_DISABLE_SNAPSHOTS): this change cannot be undone.';
  } else if (snapshotId) {
    undo = `\n\n↩️ Undo available: call nuvio_undo with snapshot_id "${snapshotId}" to revert this change.`;
  } else {
    undo = '\n\n(no automatic undo available for this change)';
  }
  return `✅ Applied ${title}.\n\nChanges:\n${diffLines(result.diff)}${undo}`;
}

interface RegisterInfo {
  name: string;
  title: string;
  description: string;
  risk: Risk;
  canonical?: boolean;
  replacement?: string;
}

function registerInfo(spec: RegisterInfo): RegisteredToolInfo {
  const canonical = spec.canonical ?? true;
  const info: RegisteredToolInfo = {
    name: spec.name,
    title: spec.title,
    risk: spec.risk,
    description: spec.description,
    canonical,
    replacement: spec.replacement,
  };
  registry.push(info);
  return info;
}

function described(spec: CommonSpec<z.ZodRawShape>, base: string): string {
  if (spec.canonical !== false) return base;
  const replacement = spec.replacement ? ` Use ${spec.replacement} instead.` : '';
  return `[DEPRECATED]${replacement} ${base}`;
}

export function defineRead<S extends z.ZodRawShape>(
  server: McpServer,
  client: NuvioClient,
  cfg: NuvioConfig,
  spec: ReadSpec<S>
): void {
  registerInfo(spec);
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: described(spec, spec.description),
      inputSchema: z.object(spec.schema),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true, ...spec.annotations },
    },
    (async (args: z.infer<z.ZodObject<S>>) => {
      return withCallCache(async () => {
        try {
          const ctx: ExecCtx = {
            client,
            config: cfg,
            apply: true,
            dryRun: false,
            before: undefined,
            read: (ref) => readResource(client, ref),
          };
          const data = await spec.handler(args, ctx);
          return textResult(typeof data === 'string' ? data : jsonBlock(data));
        } catch (error) {
          return textResult(formatError(error), true);
        }
      });
    }) as never
  );
}

function dryRunField(destructive: boolean, reversible: boolean): z.ZodRawShape {
  const shape: Record<string, z.ZodType> = {
    dry_run: z
      .boolean()
      .optional()
      .describe('Return the diff without writing anything (no snapshot, no audit entry).'),
  };
  if (destructive && reversible) {
    shape.confirm = z
      .boolean()
      .optional()
      .describe('Required to actually apply a destructive change. Without it a preview is returned.');
  }
  if (!reversible) {
    shape.confirmation_token = z
      .string()
      .optional()
      .describe(
        'Token from a previous call of this tool. Irreversible operations require a two-phase ' +
          'prepare/execute: call once to receive the token, then call again with it.'
      );
  }
  return shape as z.ZodRawShape;
}

export function defineMutation<S extends z.ZodRawShape>(
  server: McpServer,
  client: NuvioClient,
  cfg: NuvioConfig,
  spec: MutationSpec<S>
): void {
  registerInfo(spec);
  const destructive = spec.risk === 'destructive';
  const reversible = spec.reversible ?? true;
  const shape = { ...spec.schema, ...dryRunField(destructive, reversible) } as z.ZodRawShape;

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: described(
        spec,
        reversible
          ? `${spec.description} Supports dry_run and snapshots the previous state before the write; revert with nuvio_undo.`
          : `${spec.description} Cannot be undone: call it once to get a short-lived confirmation token, then call again with that token. Supports dry_run.`
      ),
      inputSchema: z.object(shape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: destructive,
        idempotentHint: false,
        openWorldHint: true,
        ...spec.annotations,
      },
    },
    (async (args: Record<string, unknown>) => {
      return withCallCache(async () => {
        try {
          const typed = args as z.infer<z.ZodObject<S>>;
          const resource = typeof spec.resource === 'function' ? spec.resource(typed) : spec.resource;
          const dryRun = args.dry_run === true;

          // Irreversible operations: two-phase token instead of the confirm flag.
          if (!reversible) {
            if (
              !dryRun &&
              (typeof args.confirmation_token !== 'string' || args.confirmation_token.length === 0)
            ) {
              const preview = await spec.handler(typed, {
                client,
                config: cfg,
                apply: false,
                dryRun: false,
                before: undefined,
                read: (ref) => readResource(client, ref),
              });
              const { token, expires_at } = confirmationGate.prepare(spec.name, args);
              return textResult(
                formatPreview(
                  spec.title,
                  preview,
                  `\n\n⚠️ ${spec.title} cannot be undone. To execute, call the same tool again with the same ` +
                    `arguments plus:\n  confirmation_token: "${token}"\nToken expires at ${expires_at}.`
                )
              );
            }
            if (!dryRun) confirmationGate.verify(spec.name, args, args.confirmation_token);
          }

          const apply = !dryRun && (reversible ? (destructive ? args.confirm === true : true) : true);
          const snapshotsDisabled = cfg.disableSnapshots;

          let snapshot: Snapshot | undefined;
          let before: unknown;
          if (apply && reversible && !snapshotsDisabled) {
            before = await readResource(client, resource);
            snapshot = capture(cfg, client, {
              tool: spec.name,
              resource,
              before,
              reversible: true,
              note: spec.note,
              scope: spec.scope?.(typed),
            });
          }

          const ctx: ExecCtx = {
            client,
            config: cfg,
            apply,
            dryRun,
            before,
            read: (ref) => readResource(client, ref),
          };
          const result = await spec.handler(typed, ctx);

          if (snapshot && !(result.applied && result.changed)) removeSnapshot(cfg, snapshot.id);

          if (result.applied && result.changed) {
            audit(cfg, { tool: spec.name, resource, args, diff: result.diff, snapshot: snapshot?.id });
          }
          if (!result.applied) {
            return textResult(
              result.changed ? formatPreview(spec.title, result) : `No changes required for ${spec.title}.`
            );
          }
          return textResult(formatApplied(spec.title, result, snapshot?.id, snapshotsDisabled));
        } catch (error) {
          return textResult(formatError(error), true);
        }
      });
    }) as never
  );
}

/**
 * A destructive operation that touches only local MCP state (no backend
 * resource, so no pre-change snapshot). Supports dry_run; a real run requires
 * `confirm: true`.
 */
export function defineLocalMutation<S extends z.ZodRawShape>(
  server: McpServer,
  client: NuvioClient,
  cfg: NuvioConfig,
  spec: LocalMutationSpec<S>
): void {
  registerInfo(spec);
  const shape = {
    ...spec.schema,
    dry_run: z
      .boolean()
      .optional()
      .default(true)
      .describe('Default true: only reports what would be removed.'),
    confirm: z.boolean().optional().describe('Required to actually delete. Without it nothing is removed.'),
  } as z.ZodRawShape;

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: `${spec.description} Destructive local operation: defaults to dry_run and requires confirm to delete.`,
      inputSchema: z.object(shape),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (async (args: Record<string, unknown>) => {
      try {
        const typed = args as z.infer<z.ZodObject<S>>;
        const dryRun = args.dry_run !== false;
        const apply = !dryRun && args.confirm === true;
        const ctx: ExecCtx = {
          client,
          config: cfg,
          apply,
          dryRun,
          before: undefined,
          read: (ref) => readResource(client, ref),
        };
        const result = await spec.handler(typed, ctx);
        if (result.applied && result.changed) {
          audit(cfg, { tool: spec.name, args, diff: result.diff });
        }
        if (!result.changed) return textResult(`No changes required for ${spec.title}.`);
        if (!result.applied) {
          return textResult(
            `📝 Preview for ${spec.title} — nothing was removed.\n\nWould remove:\n${diffLines(result.diff)}` +
              '\n\nPass confirm: true to delete.'
          );
        }
        return textResult(`✅ Applied ${spec.title}.\n\nChanges:\n${diffLines(result.diff)}`);
      } catch (error) {
        return textResult(formatError(error), true);
      }
    }) as never
  );
}

function formatPlanResult(result: PlanResult): string {
  const lines: string[] = [];
  const header: Record<PlanResult['status'], string> = {
    preview: '📝 Plan preview — nothing was written.',
    applied: '✅ Plan applied.',
    rolled_back: '↩️ Plan failed and was rolled back.',
    partially_applied: '⚠️ Plan partially applied; rollback did not fully succeed.',
    failed_before_apply: '🛑 Plan rejected before any write.',
  };
  lines.push(header[result.status]);
  if (result.failed_operation) {
    lines.push(
      `Failed operation #${result.failed_operation.index} (${result.failed_operation.tool}): ${result.failed_operation.error}`
    );
  }
  if (result.rollback) {
    lines.push(
      `Rollback: attempted=${result.rollback.attempted} successful=${result.rollback.successful} — ${result.rollback.detail}`
    );
  }
  if (result.snapshot_id) {
    lines.push(
      `Composite snapshot ${result.snapshot_id}.` +
        `\n\n↩️ Undo available: call nuvio_undo with snapshot_id "${result.snapshot_id}" to revert the whole plan.`
    );
  }
  lines.push(`Applied operations: ${result.applied_operations.length}/${result.operations.length}`);
  for (const op of result.operations) {
    lines.push(`  #${op.index} ${op.tool} [${op.resource}]`);
    for (const d of op.diff) lines.push(`    ${d}`);
  }
  lines.push('Per-resource diff:');
  for (const r of result.resources) {
    lines.push(`  ${r.resource}:`);
    for (const d of r.diff) lines.push(`    ${d}`);
  }
  return lines.join('\n');
}

/** nuvio_apply_plan: a transactional, multi-operation mutation backed by one composite snapshot. */
export function definePlanMutation(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  registerInfo({
    name: 'nuvio_apply_plan',
    title: 'Apply a plan of operations',
    description:
      'Apply several canonical operations as one transaction: validated up front, one read per resource, one write ' +
      'per resource, a single composite snapshot, and rollback on failure. Defaults to dry_run.',
    risk: 'write',
    canonical: true,
  });
  const inputSchema = z.object({
    operations: z
      .array(z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) }))
      .min(1),
    dry_run: z.boolean().optional().default(true).describe('Default true: validate and preview only.'),
  });

  server.registerTool(
    'nuvio_apply_plan',
    {
      title: 'Apply a plan of operations',
      description:
        'Apply several canonical operations as one transaction with a composite snapshot and rollback. Defaults to dry_run.',
      inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    (async (args: { operations: PlanOperation[]; dry_run?: boolean }) => {
      return withCallCache(async () => {
        try {
          const result = await applyPlan(args.operations, args.dry_run !== false, {
            client,
            originId: cfg.originClientId,
            captureComposite: (entries) =>
              cfg.disableSnapshots
                ? undefined
                : captureComposite(cfg, client, {
                    tool: 'nuvio_apply_plan',
                    entries,
                    reversible: true,
                    note: 'composite snapshot for a plan',
                  }).id,
            rollback: async (id) => {
              const snapshot = getSnapshot(cfg, id);
              if (!snapshot) return { ok: false, detail: `snapshot ${id} not found` };
              const report = await restore(client, cfg, snapshot);
              return {
                ok: report.ok,
                detail: report.outcomes.map((o) => `${o.ok ? 'ok' : 'fail'} ${o.resource}`).join(', '),
              };
            },
          });
          if (result.status === 'applied') {
            audit(cfg, {
              tool: 'nuvio_apply_plan',
              operations: args.operations,
              diff: result.resources.flatMap((r) => r.diff),
              snapshot: result.snapshot_id,
            });
          }
          return textResult(formatPlanResult(result));
        } catch (error) {
          return textResult(formatError(error), true);
        }
      });
    }) as never
  );
}

function formatError(error: unknown): string {
  if (error instanceof SnapshotError) return `🛑 ${error.message}`;
  if (error instanceof NuvioError) return `❌ Nuvio API error: ${error.toHuman()}`;
  if (error instanceof Error) return `❌ ${error.message}`;
  return `❌ ${String(error)}`;
}
