import { z } from 'zod';
import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
import { libraryKeyOf, progressKeyOf, storedProgressKey } from '../keys.js';
import { readResource, type ResourceRef, type SnapshotResourceEntry } from '../snapshots.js';
import {
  addonAddShape,
  addonRemoveShape,
  addonReorderShape,
  addonUpdateShape,
  assertTarget,
  historyAddShape,
  historyDeleteShape,
  libraryAddShape,
  libraryRemoveShape,
  progressDeleteShape,
  progressSetShape,
  providerDeleteShape,
  providerSetShape,
  updateSettingsShape,
} from '../schemas.js';
import {
  applySettingsEdit,
  assertEditProvided,
  diffTree,
  getHomeCatalogSettings,
  getSettings,
  isConcurrencyConflict,
  writeSettings,
  type SettingsPatch,
} from './settings.js';
import { PROVIDER_CREDENTIAL_FIELD } from './providers.js';
import {
  planHistoryAdd,
  planHistoryDelete,
  planLibraryAdd,
  planLibraryRemove,
  planProgressDelete,
  planProgressSet,
} from './transitions.js';

export interface PlanOperation {
  tool: string;
  args: Record<string, unknown>;
}

export type PlanStatus = 'preview' | 'applied' | 'rolled_back' | 'partially_applied' | 'failed_before_apply';

export interface PlanOperationReport {
  index: number;
  tool: string;
  resource: string;
  diff: string[];
}

export interface PlanResourceReport {
  resource: string;
  diff: string[];
}

export interface PlanResult {
  status: PlanStatus;
  dry_run: boolean;
  operations: PlanOperationReport[];
  resources: PlanResourceReport[];
  applied_operations: number[];
  attempted_resources: string[];
  completed_resources: string[];
  failed_operation?: { index: number; tool: string; error: string };
  rollback?: { attempted: boolean; successful: boolean; detail: string };
  snapshot_id?: string;
}

/** A writer failure plus the side-effect information the plan needs to classify it. */
export class WriteFailure extends Error {
  constructor(
    message: string,
    readonly opts: { mayHaveApplied: boolean; conflict?: boolean }
  ) {
    super(message);
    this.name = 'WriteFailure';
  }
}

interface ResourceState {
  ref: ResourceRef;
  key: string;
  before: unknown;
  after: unknown;
  scope?: unknown;
  meta: Record<string, unknown>;
}

interface Descriptor {
  schema: z.ZodRawShape;
  validate?: (args: Record<string, unknown>) => void;
  ref(args: Record<string, unknown>): ResourceRef;
  scope?(args: Record<string, unknown>): unknown[];
  plan(
    state: unknown,
    args: Record<string, unknown>,
    now: number,
    meta: Record<string, unknown>
  ): { state: unknown; diff: string[] };
  readMeta?(client: NuvioClient, ref: ResourceRef): Promise<Record<string, unknown>>;
  write(
    client: NuvioClient,
    ref: ResourceRef,
    state: unknown,
    meta: Record<string, unknown>,
    originId: string
  ): Promise<Record<string, unknown> | void>;
  /** Guarded rollback for resources with optimistic concurrency. */
  guardedRollback?: (meta: Record<string, unknown>) => boolean;
  rollback?(
    client: NuvioClient,
    ref: ResourceRef,
    before: unknown,
    meta: Record<string, unknown>,
    originId: string
  ): Promise<void>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/** Order-independent comparison for detecting concurrent changes. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function resourceKey(ref: ResourceRef): string {
  const r = ref as { kind: string; profile_id?: number; platform?: string };
  return `${r.kind}${r.profile_id !== undefined ? `:${r.profile_id}` : ''}${r.platform ? `/${r.platform}` : ''}`;
}

/**
 * Apply list upserts/removes. Any write RPC that has *started* may have been
 * applied on the backend even if it later throws (timeout, reset response, 5xx
 * after commit), so failures are conservatively marked `mayHaveApplied: true`.
 */
async function pushList(
  client: NuvioClient,
  ref: ResourceRef,
  before: Array<Record<string, unknown>>,
  after: Array<Record<string, unknown>>,
  keyOf: (item: Record<string, unknown>) => string,
  upsertRpc: string,
  upsertField: string,
  deleteRpc: string,
  deleteField: string,
  mapDeleteKey: (item: Record<string, unknown>) => unknown,
  originId: string
): Promise<void> {
  const profileId = (ref as { profile_id: number }).profile_id;
  const b = new Map(before.map((i) => [keyOf(i), i]));
  const a = new Map(after.map((i) => [keyOf(i), i]));
  const upserts = after.filter((i) => {
    const prev = b.get(keyOf(i));
    return !prev || JSON.stringify(prev) !== JSON.stringify(i);
  });
  const removals = before.filter((i) => !a.has(keyOf(i)));

  let writeAttempted = false;
  try {
    if (removals.length > 0) {
      writeAttempted = true;
      await client.rpc(deleteRpc, {
        p_profile_id: profileId,
        [deleteField]: removals.map(mapDeleteKey),
        p_origin_client_id: originId,
      });
    }
    if (upserts.length > 0) {
      writeAttempted = true;
      await client.rpc(upsertRpc, {
        p_profile_id: profileId,
        [upsertField]: upserts,
        p_origin_client_id: originId,
      });
    }
  } catch (error) {
    throw new WriteFailure(error instanceof Error ? error.message : String(error), {
      mayHaveApplied: writeAttempted,
    });
  }
}

// ---------------------------------------------------------------------------
// Planners (canonical plan-supported tools only)
// ---------------------------------------------------------------------------

function settingsPlan(state: unknown, args: Record<string, unknown>, _now: number) {
  const edit: SettingsPatch = {
    patch: args.patch as Record<string, unknown> | undefined,
    set: args.set as Array<{ path: string; value: unknown }> | undefined,
    unset: args.unset as string[] | undefined,
  };
  const result = applySettingsEdit((state as Record<string, unknown>) ?? {}, edit);
  return { state: result.after, diff: result.diff };
}

const settingsDescriptor: Descriptor = {
  schema: updateSettingsShape,
  validate: (args) =>
    assertEditProvided({
      patch: args.patch as Record<string, unknown> | undefined,
      set: args.set as Array<{ path: string; value: unknown }> | undefined,
      unset: args.unset as string[] | undefined,
    }),
  ref: (args) => ({
    kind: 'settings',
    profile_id: args.profile_id as number,
    platform: args.platform as string,
  }),
  plan: settingsPlan,
  readMeta: async (client, ref) => {
    const r = ref as { profile_id: number; platform: string };
    const blob = await getSettings(client, r.profile_id, r.platform);
    return { updated_at: blob?.updated_at ?? null };
  },
  write: async (client, ref, state, meta, originId) => {
    const r = ref as { profile_id: number; platform: string };
    try {
      const result = await writeSettings(
        client,
        r.profile_id,
        r.platform,
        state as Record<string, unknown>,
        (meta.updated_at as string | null) ?? null,
        originId
      );
      return { writtenRevision: result.revision, writtenGuarded: result.guarded };
    } catch (error) {
      if (isConcurrencyConflict(error)) {
        throw new WriteFailure(
          'Settings changed on another device since the plan started (guarded write was rejected).',
          { mayHaveApplied: false, conflict: true }
        );
      }
      throw new WriteFailure(error instanceof Error ? error.message : String(error), {
        mayHaveApplied: true,
      });
    }
  },
  guardedRollback: (meta) => Boolean(meta.writtenGuarded) && Boolean(meta.writtenRevision),
  rollback: async (client, ref, before, meta, originId) => {
    const r = ref as { profile_id: number; platform: string };
    try {
      // Guarded rollback: only succeeds if nobody changed the settings after us.
      await writeSettings(
        client,
        r.profile_id,
        r.platform,
        before as Record<string, unknown>,
        meta.writtenRevision as string,
        originId
      );
    } catch (error) {
      throw new WriteFailure(error instanceof Error ? error.message : String(error), {
        mayHaveApplied: true,
        conflict: isConcurrencyConflict(error),
      });
    }
  },
};

const homeDescriptor: Descriptor = {
  schema: updateSettingsShape,
  validate: (args) =>
    assertEditProvided({
      patch: args.patch as Record<string, unknown> | undefined,
      set: args.set as Array<{ path: string; value: unknown }> | undefined,
      unset: args.unset as string[] | undefined,
    }),
  ref: (args) => ({
    kind: 'home_catalog_settings',
    profile_id: args.profile_id as number,
    platform: args.platform as string,
  }),
  plan: settingsPlan,
  readMeta: async (client, ref) => {
    const r = ref as { profile_id: number; platform: string };
    const blob = await getHomeCatalogSettings(client, r.profile_id, r.platform);
    return { updated_at: blob?.updated_at ?? null };
  },
  write: async (client, ref, state, _meta, originId) => {
    const r = ref as { profile_id: number; platform: string };
    try {
      await client.rpc('sync_push_home_catalog_settings', {
        p_profile_id: r.profile_id,
        p_platform: r.platform,
        p_settings_json: state,
        p_origin_client_id: originId,
      });
    } catch (error) {
      throw new WriteFailure(error instanceof Error ? error.message : String(error), {
        mayHaveApplied: true,
      });
    }
  },
};

function findAddon(
  list: Array<Record<string, unknown>>,
  args: Record<string, unknown>,
  meta: Record<string, unknown>
): Record<string, unknown> {
  if (typeof args.url === 'string') {
    const found = list.find((a) => a.url === args.url);
    if (found) return found;
  }
  if (typeof args.id === 'string') {
    // The list state is the push shape (no id); ids are supplied via readMeta.
    const ids = (meta.ids ?? {}) as Record<string, string>;
    const url = Object.keys(ids).find((u) => ids[u] === args.id);
    const found = url ? list.find((a) => a.url === url) : undefined;
    if (found) return found;
  }
  throw new NuvioError('Addon not found');
}

const addonsDescriptor: Descriptor = {
  schema: addonUpdateShape,
  validate: (args) => assertTarget('nuvio_update_addon', args),
  ref: (args) => ({ kind: 'addons', profile_id: args.profile_id as number }),
  readMeta: async (client, ref) => {
    const rows = await client.select<Array<Record<string, unknown>>>(
      'addons',
      `select=id,user_id,profile_id,url,name,enabled,sort_order,created_at,updated_at` +
        `&profile_id=eq.${(ref as { profile_id: number }).profile_id}&order=sort_order.asc,created_at.asc`
    );
    const ids: Record<string, string> = {};
    for (const row of rows)
      if (typeof row.url === 'string' && typeof row.id === 'string') ids[row.url] = row.id;
    return { ids };
  },
  plan: (state, args, _now, meta) => {
    const list = copy(state as Array<Record<string, unknown>>);
    const tool = String(args.__tool);
    const diff: string[] = [];
    if (tool === 'nuvio_add_addon') {
      const url = String(args.url);
      if (list.some((a) => a.url === url)) throw new NuvioError(`Addon already installed: ${url}`);
      list.push({
        url,
        name: (args.name as string | null) ?? null,
        enabled: (args.enabled as boolean | undefined) ?? true,
        sort_order:
          (args.sort_order as number | undefined) ??
          list.reduce((m, a) => Math.max(m, Number(a.sort_order) + 1), 0),
      });
      diff.push(`+ addon ${url}`);
    } else if (tool === 'nuvio_update_addon') {
      const target = findAddon(list, args, meta);
      if (args.name !== undefined) target.name = args.name;
      if (args.enabled !== undefined) target.enabled = args.enabled;
      if (args.sort_order !== undefined) target.sort_order = args.sort_order;
      diff.push(`~ addon ${String(target.url)}`);
    } else if (tool === 'nuvio_reorder_addons') {
      const ordered = args.ordered_urls as string[];
      const current = list.map((a) => a.url).sort();
      if (ordered.length !== current.length || [...ordered].sort().some((u, i) => u !== current[i])) {
        throw new NuvioError('Reorder must list every installed addon URL exactly once.');
      }
      return {
        state: ordered.map((url, index) => ({ ...list.find((a) => a.url === url)!, sort_order: index })),
        diff: ['~ reorder addons'],
      };
    } else if (tool === 'nuvio_remove_addon') {
      const target = findAddon(list, args, meta);
      diff.push(`- addon ${String(target.url)}`);
      return { state: list.filter((a) => a.url !== target.url), diff };
    } else {
      throw new NuvioError(`Unsupported addon operation: ${tool}`);
    }
    return { state: list, diff };
  },
  write: async (client, ref, state, _meta, originId) => {
    try {
      await client.rpc('sync_push_addons', {
        p_profile_id: (ref as { profile_id: number }).profile_id,
        p_addons: state,
        p_origin_client_id: originId,
      });
    } catch (error) {
      throw new WriteFailure(error instanceof Error ? error.message : String(error), {
        mayHaveApplied: true,
      });
    }
  },
};

const providersDescriptor: Descriptor = {
  schema: providerSetShape,
  validate: (args) => {
    const key = String(args.provider ?? '')
      .trim()
      .toLowerCase();
    if (!PROVIDER_CREDENTIAL_FIELD[key]) {
      throw new NuvioError(
        `Unsupported provider "${String(args.provider)}". Supported: ${Object.keys(PROVIDER_CREDENTIAL_FIELD).join(', ')}`
      );
    }
  },
  ref: (args) => ({ kind: 'provider_credentials', profile_id: args.profile_id as number }),
  plan: (state, args) => {
    const list = copy(state as Array<Record<string, unknown>>);
    const tool = String(args.__tool);
    const provider = String(args.provider ?? '')
      .trim()
      .toLowerCase();
    if (!provider) throw new NuvioError('apply_plan: provider is required');
    const diff: string[] = [];
    if (tool === 'nuvio_delete_provider_credential') {
      const index = list.findIndex((c) => c.provider === provider);
      if (index < 0) throw new NuvioError(`No credential stored for ${provider}`);
      list.splice(index, 1);
      diff.push(`- remove credential for ${provider}`);
    } else {
      const field = provider === 'animeskip' ? 'client_id' : 'api_key';
      const value = String(args.api_key ?? '');
      if (!value.trim()) throw new NuvioError('Credential value cannot be empty');
      const entry = { provider, credential_json: { [field]: value.trim() } };
      const index = list.findIndex((c) => c.provider === provider);
      if (index >= 0) list[index] = entry;
      else list.push(entry);
      diff.push(`~ set credential for ${provider}`);
    }
    return { state: list, diff };
  },
  write: async (client, ref, state, _meta, originId) => {
    const profileId = (ref as { profile_id: number }).profile_id;
    const before = (await readResource(client, ref)) as Array<{ provider: string }>;
    const wanted = new Set((state as Array<{ provider: string }>).map((c) => c.provider));
    const rows = state as Array<{ provider: string; credential_json: unknown }>;
    let writeAttempted = false;
    try {
      for (const cred of before) {
        if (!wanted.has(cred.provider)) {
          writeAttempted = true;
          await client.rpc('sync_delete_provider_credentials', {
            p_profile_id: profileId,
            p_provider: cred.provider,
            p_origin_client_id: originId,
          });
        }
      }
      if (rows.length > 0) {
        writeAttempted = true;
        await client.rpc('sync_push_provider_credentials', {
          p_profile_id: profileId,
          p_credentials: rows,
          p_origin_client_id: originId,
        });
      }
    } catch (error) {
      throw new WriteFailure(error instanceof Error ? error.message : String(error), {
        mayHaveApplied: writeAttempted,
      });
    }
  },
};

const libraryDescriptor: Descriptor = {
  schema: libraryAddShape,
  ref: (args) => ({ kind: 'library', profile_id: args.profile_id as number }),
  scope: (args) => {
    const tool = String(args.__tool);
    const items = (tool === 'nuvio_add_to_library' ? args.items : args.keys) as Array<
      Record<string, unknown>
    >;
    return items.map((i) => ({ content_id: i.content_id, content_type: i.content_type }));
  },
  plan: (state, args, now) => {
    const tool = String(args.__tool);
    const list = state as Array<Record<string, unknown>>;
    const t =
      tool === 'nuvio_add_to_library'
        ? planLibraryAdd(list, args.items as never, now)
        : tool === 'nuvio_remove_from_library'
          ? planLibraryRemove(list, args.keys as never)
          : null;
    if (!t) throw new NuvioError(`Unsupported library operation: ${tool}`);
    return { state: t.after, diff: t.diff };
    throw new NuvioError(`Unsupported library operation: ${tool}`);
  },
  write: async (client, ref, state, _meta, originId) => {
    await pushList(
      client,
      ref,
      (await readResource(client, ref)) as Array<Record<string, unknown>>,
      state as Array<Record<string, unknown>>,
      (i) => libraryKeyOf(i as never),
      'sync_push_library_items',
      'p_items',
      'sync_delete_library_items',
      'p_keys',
      (i) => ({ content_id: i.content_id, content_type: i.content_type }),
      originId
    );
  },
};

const progressDescriptor: Descriptor = {
  schema: progressSetShape,
  ref: (args) => ({ kind: 'watch_progress', profile_id: args.profile_id as number }),
  scope: (args) => {
    const tool = String(args.__tool);
    const items = (tool === 'nuvio_set_watch_progress' ? args.entries : args.keys) as Array<
      Record<string, unknown>
    >;
    return items.map((i) => progressKeyOf(i as never));
  },
  plan: (state, args, now) => {
    const tool = String(args.__tool);
    const list = state as Array<Record<string, unknown>>;
    const t =
      tool === 'nuvio_set_watch_progress'
        ? planProgressSet(list, args.entries as never, now)
        : tool === 'nuvio_delete_watch_progress'
          ? planProgressDelete(list, args.keys as never)
          : null;
    if (!t) throw new NuvioError(`Unsupported watch progress operation: ${tool}`);
    return { state: t.after, diff: t.diff };
    throw new NuvioError(`Unsupported watch progress operation: ${tool}`);
  },
  write: async (client, ref, state, _meta, originId) => {
    await pushList(
      client,
      ref,
      (await readResource(client, ref)) as Array<Record<string, unknown>>,
      state as Array<Record<string, unknown>>,
      (i) => storedProgressKey(i),
      'sync_push_watch_progress',
      'p_entries',
      'sync_delete_watch_progress',
      'p_keys',
      (i) => storedProgressKey(i),
      originId
    );
  },
};

const historyDescriptor: Descriptor = {
  schema: historyAddShape,
  ref: (args) => ({ kind: 'watch_history', profile_id: args.profile_id as number }),
  scope: (args) => {
    const tool = String(args.__tool);
    const items = (tool === 'nuvio_add_to_watch_history' ? args.items : args.keys) as Array<
      Record<string, unknown>
    >;
    return items.map((i) => ({
      content_id: i.content_id,
      season: i.season ?? null,
      episode: i.episode ?? null,
    }));
  },
  plan: (state, args, now) => {
    const tool = String(args.__tool);
    const list = state as Array<Record<string, unknown>>;
    const t =
      tool === 'nuvio_add_to_watch_history'
        ? planHistoryAdd(list, args.items as never, now)
        : tool === 'nuvio_delete_watch_history'
          ? planHistoryDelete(list, args.keys as never)
          : null;
    if (!t) throw new NuvioError(`Unsupported watch history operation: ${tool}`);
    return { state: t.after, diff: t.diff };
    throw new NuvioError(`Unsupported watch history operation: ${tool}`);
  },
  write: async (client, ref, state, _meta, originId) => {
    await pushList(
      client,
      ref,
      (await readResource(client, ref)) as Array<Record<string, unknown>>,
      state as Array<Record<string, unknown>>,
      (i) => `${i.content_id}|${i.season ?? -1}|${i.episode ?? -1}`,
      'sync_push_watched_items',
      'p_items',
      'sync_delete_watched_items',
      'p_keys',
      (i) => ({ content_id: i.content_id, season: i.season ?? null, episode: i.episode ?? null }),
      originId
    );
  },
};

const DESCRIPTORS: Record<string, Descriptor> = {
  nuvio_update_settings: settingsDescriptor,
  nuvio_update_home_catalog_settings: homeDescriptor,
  nuvio_add_addon: addonsDescriptor,
  nuvio_update_addon: addonsDescriptor,
  nuvio_reorder_addons: addonsDescriptor,
  nuvio_remove_addon: addonsDescriptor,
  nuvio_set_provider_credential: providersDescriptor,
  nuvio_delete_provider_credential: providersDescriptor,
  nuvio_add_to_library: libraryDescriptor,
  nuvio_remove_from_library: libraryDescriptor,
  nuvio_set_watch_progress: progressDescriptor,
  nuvio_delete_watch_progress: progressDescriptor,
  nuvio_add_to_watch_history: historyDescriptor,
  nuvio_delete_watch_history: historyDescriptor,
};

const SCHEMA_OVERRIDES: Record<string, z.ZodRawShape> = {
  nuvio_add_addon: addonAddShape,
  nuvio_update_addon: addonUpdateShape,
  nuvio_reorder_addons: addonReorderShape,
  nuvio_remove_addon: addonRemoveShape,
  nuvio_delete_provider_credential: providerDeleteShape,
  nuvio_remove_from_library: libraryRemoveShape,
  nuvio_delete_watch_progress: progressDeleteShape,
  nuvio_delete_watch_history: historyDeleteShape,
};

/** Per-tool validation override (e.g. reorder has no url/id target to assert). */
const VALIDATE_OVERRIDES = new Map<string, ((args: Record<string, unknown>) => void) | null>([
  ['nuvio_reorder_addons', null],
]);

function validateFor(tool: string, descriptor: Descriptor, parsed: Record<string, unknown>): void {
  if (VALIDATE_OVERRIDES.has(tool)) {
    VALIDATE_OVERRIDES.get(tool)?.(parsed);
    return;
  }
  descriptor.validate?.(parsed);
}

function parseArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  return z.object(planSchemaFor(tool)!).parse(args) as Record<string, unknown>;
}

export function planSchemaFor(tool: string): z.ZodRawShape | undefined {
  return SCHEMA_OVERRIDES[tool] ?? DESCRIPTORS[tool]?.schema;
}

const IRREVERSIBLE = new Set([
  'nuvio_delete_profile',
  'nuvio_restore_backup',
  'nuvio_revoke_session',
  'nuvio_set_profile_pin',
  'nuvio_clear_profile_pin',
  'nuvio_register_device',
]);

export function isPlanSupported(tool: string): boolean {
  return tool in DESCRIPTORS;
}

export function isPlanIrreversible(tool: string): boolean {
  return IRREVERSIBLE.has(tool);
}

export interface PlanDeps {
  client: NuvioClient;
  originId: string;
  snapshotsDisabled: boolean;
  captureComposite: (entries: SnapshotResourceEntry[]) => string | undefined;
  /** Restore one resource via the snapshot machinery (throws on failure). */
  restoreEntry: (entry: SnapshotResourceEntry) => Promise<void>;
}

export async function applyPlan(
  operations: PlanOperation[],
  dryRun: boolean,
  deps: PlanDeps
): Promise<PlanResult> {
  const { client } = deps;
  const planNow = Math.floor(Date.now() / 1000);
  const perOp: PlanOperationReport[] = [];
  const states = new Map<string, ResourceState>();
  const order: string[] = [];
  let current: { index: number; tool: string } | undefined;

  try {
    if (operations.length === 0) throw new NuvioError('apply_plan: at least one operation is required');

    operations.forEach((op, index) => {
      current = { index, tool: op.tool };
      if (isPlanIrreversible(op.tool)) {
        throw new NuvioError(`apply_plan: "${op.tool}" is irreversible and cannot be part of a plan.`);
      }
      const descriptor = DESCRIPTORS[op.tool];
      if (!descriptor) {
        throw new NuvioError(
          `apply_plan: "${op.tool}" is not supported by a plan (canonical plan-supported tools only).`
        );
      }
      const parsed = parseArgs(op.tool, op.args);
      validateFor(op.tool, descriptor, parsed);
      const key = resourceKey(descriptor.ref(parsed));
      if (!states.has(key)) {
        states.set(key, {
          ref: descriptor.ref(parsed),
          key,
          before: undefined,
          after: undefined,
          scope: undefined,
          meta: {},
        });
        order.push(key);
      }
    });

    for (const key of order) {
      const entry = states.get(key)!;
      entry.before = await readResource(client, entry.ref);
      entry.after = entry.before;
      const descriptor = descriptorFor(entry.ref, operations);
      if (descriptor.readMeta) entry.meta = await descriptor.readMeta(client, entry.ref);
    }

    operations.forEach((op, index) => {
      current = { index, tool: op.tool };
      const descriptor = DESCRIPTORS[op.tool];
      const parsed = parseArgs(op.tool, op.args);
      const key = resourceKey(descriptor.ref(parsed));
      const entry = states.get(key)!;
      const result = descriptor.plan(entry.after, { ...parsed, __tool: op.tool }, planNow, entry.meta);
      entry.after = result.state;
      if (descriptor.scope)
        entry.scope = unionScope(entry.scope, descriptor.scope({ ...parsed, __tool: op.tool }));
      perOp.push({ index, tool: op.tool, resource: key, diff: result.diff });
    });
  } catch (error) {
    return {
      status: 'failed_before_apply',
      dry_run: dryRun,
      operations: perOp,
      resources: [],
      applied_operations: [],
      attempted_resources: [],
      completed_resources: [],
      failed_operation: current
        ? {
            index: current.index,
            tool: current.tool,
            error: error instanceof Error ? error.message : String(error),
          }
        : { index: 0, tool: 'unknown', error: error instanceof Error ? error.message : String(error) },
    };
  }

  const resources: PlanResourceReport[] = order.map((key) => {
    const entry = states.get(key)!;
    return { resource: key, diff: diffTree(entry.before, entry.after) };
  });
  const changed = resources.some((r) => r.diff.length > 0);

  if (dryRun || !changed) {
    return {
      status: 'preview',
      dry_run: true,
      operations: perOp,
      resources,
      applied_operations: [],
      attempted_resources: [],
      completed_resources: [],
    };
  }

  const entries: SnapshotResourceEntry[] = order.map((key) => {
    const e = states.get(key)!;
    return { resource: e.ref, before: e.before, scope: e.scope };
  });
  const snapshotId = deps.captureComposite(entries);

  const applied: number[] = [];
  const attemptedResources: string[] = [];
  const completedResources: string[] = [];
  let writePhaseStarted = false;
  let failedOperation: PlanResult['failed_operation'];
  let failedMayHaveApplied = false;
  let failedConflict = false;

  for (const key of order) {
    const entry = states.get(key)!;
    const descriptor = descriptorFor(entry.ref, operations);
    const representative = perOp.find((op) => op.resource === key)!;
    writePhaseStarted = true;
    attemptedResources.push(key);
    try {
      const metaPatch = await descriptor.write(client, entry.ref, entry.after, entry.meta, deps.originId);
      if (metaPatch) Object.assign(entry.meta, metaPatch);
      completedResources.push(key);
      for (const op of perOp) if (op.resource === key) applied.push(op.index);
    } catch (error) {
      failedOperation = {
        index: representative.index,
        tool: representative.tool,
        error: error instanceof Error ? error.message : String(error),
      };
      failedMayHaveApplied = error instanceof WriteFailure ? error.opts.mayHaveApplied : true;
      failedConflict = error instanceof WriteFailure ? Boolean(error.opts.conflict) : false;
      break;
    }
  }

  if (!failedOperation) {
    return {
      status: 'applied',
      dry_run: false,
      operations: perOp,
      resources,
      applied_operations: applied,
      attempted_resources: attemptedResources,
      completed_resources: completedResources,
      snapshot_id: snapshotId,
    };
  }

  const failedKey = attemptedResources[attemptedResources.length - 1];
  const rollbackKeys = order.filter((key) => {
    if (completedResources.includes(key)) return true;
    if (key === failedKey) return failedMayHaveApplied && !failedConflict;
    return false;
  });

  let rollback: PlanResult['rollback'];
  if (deps.snapshotsDisabled) {
    rollback = {
      attempted: false,
      successful: false,
      detail: 'Snapshots are disabled; no rollback was attempted and the final state is unknown.',
    };
  } else if (failedConflict && rollbackKeys.length === 0) {
    rollback = {
      attempted: false,
      successful: false,
      detail: 'Concurrent change detected; rollback skipped to avoid overwriting the newer state.',
    };
  } else if (!writePhaseStarted) {
    rollback = { attempted: false, successful: false, detail: 'No write was attempted.' };
  } else {
    const outcomes: Array<{ ok: boolean; detail: string }> = [];
    for (const key of rollbackKeys) {
      const entry = states.get(key)!;
      const descriptor = descriptorFor(entry.ref, operations);
      const snapshotEntry: SnapshotResourceEntry = {
        resource: entry.ref,
        before: entry.before,
        scope: entry.scope,
      };
      try {
        if (descriptor.rollback && descriptor.guardedRollback?.(entry.meta)) {
          await descriptor.rollback(client, entry.ref, entry.before, entry.meta, deps.originId);
        } else if (completedResources.includes(key)) {
          // No guarded RPC for this resource: only restore if nobody changed it
          // since we wrote it, otherwise a blind rollback would clobber the
          // concurrent change.
          const current = await readResource(client, entry.ref);
          if (JSON.stringify(canonical(current)) !== JSON.stringify(canonical(entry.after))) {
            outcomes.push({
              ok: false,
              detail: `fail ${key}: changed concurrently; restore skipped to avoid overwriting`,
            });
            continue;
          }
          await deps.restoreEntry(snapshotEntry);
        } else {
          await deps.restoreEntry(snapshotEntry);
        }
        outcomes.push({ ok: true, detail: `ok ${key}` });
      } catch (error) {
        outcomes.push({
          ok: false,
          detail: `fail ${key}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const ok = outcomes.every((o) => o.ok);
    rollback = { attempted: true, successful: ok, detail: outcomes.map((o) => o.detail).join(', ') };
  }

  let status: PlanStatus;
  if (!writePhaseStarted) status = 'failed_before_apply';
  else if (deps.snapshotsDisabled) status = 'partially_applied';
  else if (failedConflict && rollbackKeys.length === 0) status = 'partially_applied';
  else if (rollback.successful) status = 'rolled_back';
  else status = 'partially_applied';

  return {
    status,
    dry_run: false,
    operations: perOp,
    resources,
    applied_operations: applied,
    attempted_resources: attemptedResources,
    completed_resources: completedResources,
    failed_operation: failedOperation,
    rollback,
    snapshot_id: snapshotId,
  };
}

function unionScope(existing: unknown, next: unknown[]): unknown[] {
  const base = Array.isArray(existing) ? (existing as unknown[]) : [];
  const seen = new Set(base.map((k) => JSON.stringify(k)));
  const out = [...base];
  for (const item of next) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function descriptorFor(ref: ResourceRef, operations: PlanOperation[]): Descriptor {
  const key = resourceKey(ref);
  for (const op of operations) {
    const d = DESCRIPTORS[op.tool];
    if (d && resourceKey(d.ref(parseArgs(op.tool, op.args))) === key) return d;
  }
  throw new NuvioError(`apply_plan: no descriptor for resource ${key}`);
}
