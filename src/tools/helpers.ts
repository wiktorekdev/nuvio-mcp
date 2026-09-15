import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import type { ApplyResult } from '../nuvio/types.js';
import { NuvioError } from '../nuvio/errors.js';
import {
  capture,
  readResource,
  removeSnapshot,
  SnapshotError,
  type ResourceRef,
  type Snapshot,
} from '../nuvio/snapshots.js';
import { ConfirmationGate } from '../nuvio/confirm.js';
import { maskDeep } from '../mask.js';

export type Risk = 'read' | 'write' | 'destructive';

export interface ExecCtx {
  client: NuvioClient;
  config: NuvioConfig;
  apply: boolean;
}

interface CommonSpec<S extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  risk: Risk;
  schema: S;
  annotations?: ToolAnnotations;
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

export interface RegisteredToolInfo {
  name: string;
  title: string;
  risk: Risk;
  description: string;
}

export const registry: RegisteredToolInfo[] = [];

/** Per-process confirmation gate for irreversible operations. */
export const confirmationGate = new ConfirmationGate();

function audit(cfg: NuvioConfig, entry: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(cfg.auditFile), { recursive: true, mode: 0o700 });
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

export function defineRead<S extends z.ZodRawShape>(
  server: McpServer,
  client: NuvioClient,
  cfg: NuvioConfig,
  spec: ReadSpec<S>
): void {
  registry.push({ name: spec.name, title: spec.title, risk: spec.risk, description: spec.description });
  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: spec.description,
      inputSchema: z.object(spec.schema),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true, ...spec.annotations },
    },
    (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        const data = await spec.handler(args, { client, config: cfg, apply: true });
        return textResult(typeof data === 'string' ? data : jsonBlock(data));
      } catch (error) {
        return textResult(formatError(error), true);
      }
    }) as never
  );
}

export function defineMutation<S extends z.ZodRawShape>(
  server: McpServer,
  client: NuvioClient,
  cfg: NuvioConfig,
  spec: MutationSpec<S>
): void {
  registry.push({ name: spec.name, title: spec.title, risk: spec.risk, description: spec.description });
  const destructive = spec.risk === 'destructive';
  const reversible = spec.reversible ?? true;

  const baseShape = destructive
    ? {
        ...spec.schema,
        confirm: z
          .boolean()
          .optional()
          .describe('Required for reversible destructive changes. Without it a preview is returned.'),
      }
    : spec.schema;
  const shape = (
    reversible
      ? baseShape
      : {
          ...baseShape,
          confirmation_token: z
            .string()
            .optional()
            .describe(
              'Token from a previous call of this tool. Irreversible operations require a two-phase ' +
                'prepare/execute: call once to receive the token, then call again with it.'
            ),
        }
  ) as z.ZodRawShape;

  server.registerTool(
    spec.name,
    {
      title: spec.title,
      description: reversible
        ? `${spec.description} The previous state is snapshotted before the write; revert with nuvio_undo.`
        : `${spec.description} This operation cannot be undone: it uses two-phase confirmation — call it once to get a short-lived confirmation token, then call again with that token to execute.`,
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
      try {
        const typed = args as z.infer<z.ZodObject<S>>;
        const resource = typeof spec.resource === 'function' ? spec.resource(typed) : spec.resource;

        // Irreversible operations: two-phase token instead of the confirm flag.
        if (!reversible) {
          if (typeof args.confirmation_token !== 'string' || args.confirmation_token.length === 0) {
            const preview = await spec.handler(typed, { client, config: cfg, apply: false });
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
          confirmationGate.verify(spec.name, args, args.confirmation_token);
        }

        // Determine whether the write happens, then take the mandatory snapshot first.
        const apply = reversible ? (destructive ? args.confirm === true : true) : true;
        const snapshotsDisabled = cfg.disableSnapshots;

        let snapshot: Snapshot | undefined;
        if (reversible && apply && !snapshotsDisabled) {
          const before = await readResource(client, resource);
          snapshot = capture(cfg, client, {
            tool: spec.name,
            resource,
            before,
            reversible: true,
            note: spec.note,
            scope: spec.scope?.(typed),
          });
        }

        const result = await spec.handler(typed, { client, config: cfg, apply });

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
    }) as never
  );
}

function formatError(error: unknown): string {
  if (error instanceof SnapshotError) return `🛑 ${error.message}`;
  if (error instanceof NuvioError) return `❌ Nuvio API error: ${error.toHuman()}`;
  if (error instanceof Error) return `❌ ${error.message}`;
  return `❌ ${String(error)}`;
}
