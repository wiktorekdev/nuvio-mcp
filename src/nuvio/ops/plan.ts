import { z } from 'zod';
import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
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
  diffTree,
  getSettings,
  isConcurrencyConflict,
  writeSettings,
  getHomeCatalogSettings,
  type SettingsPatch,
} from './settings.js';
import { PROVIDER_CREDENTIAL_FIELD } from './providers.js';

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

/** A writer failure, with the side-effect information the plan needs to classify it. */
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
  /** Canonical Zod schema — identical to the one the direct tool registers. */
  schema: z.ZodRawShape;
  /** Handler-level validation shared with the direct tool. */
  validate?: (args: Record<string, unknown>) => void;
  ref(args: Record<string, unknown>): ResourceRef;
  scope?(args: Record<string, unknown>): unknown[];
  plan(state: unknown, args: Record<string, unknown>): { state: unknown; diff: string[] };
  readMeta?(client: NuvioClient, ref: ResourceRef): Promise<Record<string, unknown>>;
  write(
    client: NuvioClient,
    ref: ResourceRef,
    state: unknown,
    meta: Record<string, unknown>,
    originId: string
  ): Promise<void>;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

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

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

export function resourceKey(ref: ResourceRef): string {
  const r = ref as { kind: string; profile_id?: number; platform?: string };
  return `${r.kind}${r.profile_id !== undefined ? `:${r.profile_id}` : ''}${r.platform ? `/${r.platform}` : ''}`;
}

/** Apply list upserts/removes with partial-write awareness. */
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
    return !prev || !same(prev, i);
  });
  const removals = before.filter((i) => !a.has(keyOf(i)));

  let wroteSomething = false;
  try {
    if (removals.length > 0) {
      await client.rpc(deleteRpc, {
        p_profile_id: profileId,
        [deleteField]: removals.map(mapDeleteKey),
        p_origin_client_id: originId,
      });
      wroteSomething = true;
    }
    if (upserts.length > 0) {
      await client.rpc(upsertRpc, {
        p_profile_id: profileId,
        [upsertField]: upserts,
        p_origin_client_id: originId,
      });
      wroteSomething = true;
    }
  } catch (error) {
    throw new WriteFailure(error instanceof Error ? error.message : String(error), {
      mayHaveApplied: wroteSomething,
    });
  }
}

// ---------------------------------------------------------------------------
// Planners (canonical plan-supported tools only)
// ---------------------------------------------------------------------------

function settingsPlan(state: unknown, args: Record<string, unknown>): { state: unknown; diff: string[] } {
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
      await writeSettings(
        client,
        r.profile_id,
        r.platform,
        state as Record<string, unknown>,
        (meta.updated_at as string | null) ?? null,
        originId
      );
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
};

const homeDescriptor: Descriptor = {
  schema: updateSettingsShape,
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
  args: Record<string, unknown>
): Record<string, unknown> {
  if (typeof args.url === 'string') {
    const found = list.find((a) => a.url === args.url);
    if (found) return found;
  }
  if (typeof args.id === 'string') {
    const found = list.find((a) => a.id === args.id);
    if (found) return found;
  }
  throw new NuvioError('Addon not found');
}

const addonsDescriptor: Descriptor = {
  schema: addonUpdateShape,
  validate: (args) => assertTarget('nuvio_update_addon', args),
  ref: (args) => ({ kind: 'addons', profile_id: args.profile_id as number }),
  plan: (state, args) => {
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
      const target = findAddon(list, args);
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
      const target = findAddon(list, args);
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
    let wroteSomething = false;
    try {
      for (const cred of before) {
        if (!wanted.has(cred.provider)) {
          await client.rpc('sync_delete_provider_credentials', {
            p_profile_id: profileId,
            p_provider: cred.provider,
            p_origin_client_id: originId,
          });
          wroteSomething = true;
        }
      }
      if (rows.length > 0) {
        await client.rpc('sync_push_provider_credentials', {
          p_profile_id: profileId,
          p_credentials: rows,
          p_origin_client_id: originId,
        });
        wroteSomething = true;
      }
    } catch (error) {
      throw new WriteFailure(error instanceof Error ? error.message : String(error), {
        mayHaveApplied: wroteSomething,
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
  plan: (state, args) => {
    const tool = String(args.__tool);
    const list = copy(state as Array<Record<string, unknown>>);
    const diff: string[] = [];
    if (tool === 'nuvio_add_to_library') {
      for (const raw of args.items as Array<Record<string, unknown>>) {
        const key = `${raw.content_type}:${raw.content_id}`;
        const index = list.findIndex((i) => `${i.content_type}:${i.content_id}` === key);
        if (index >= 0) list[index] = { ...list[index], ...raw };
        else list.push(raw);
        diff.push(`~ library ${key}`);
      }
    } else if (tool === 'nuvio_remove_from_library') {
      for (const raw of args.keys as Array<Record<string, unknown>>) {
        const key = `${raw.content_type}:${raw.content_id}`;
        const index = list.findIndex((i) => `${i.content_type}:${i.content_id}` === key);
        if (index >= 0) list.splice(index, 1);
        diff.push(`- library ${key}`);
      }
    } else {
      throw new NuvioError(`Unsupported library operation: ${tool}`);
    }
    return { state: list, diff };
  },
  write: async (client, ref, state, _meta, originId) => {
    await pushList(
      client,
      ref,
      (await readResource(client, ref)) as Array<Record<string, unknown>>,
      state as Array<Record<string, unknown>>,
      (i) => `${i.content_type}:${i.content_id}`,
      'sync_push_library_items',
      'p_items',
      'sync_delete_library_items',
      'p_keys',
      (i) => ({ content_id: i.content_id, content_type: i.content_type }),
      originId
    );
  },
};

function progressKey(i: Record<string, unknown>): string {
  return i.season != null ? `${i.content_id}_s${i.season}e${i.episode}` : String(i.content_id);
}

const progressDescriptor: Descriptor = {
  schema: progressSetShape,
  ref: (args) => ({ kind: 'watch_progress', profile_id: args.profile_id as number }),
  scope: (args) => {
    const tool = String(args.__tool);
    const items = (tool === 'nuvio_set_watch_progress' ? args.entries : args.keys) as Array<
      Record<string, unknown>
    >;
    return items.map((i) => progressKey(i));
  },
  plan: (state, args) => {
    const tool = String(args.__tool);
    const list = copy(state as Array<Record<string, unknown>>);
    const diff: string[] = [];
    if (tool === 'nuvio_set_watch_progress') {
      for (const raw of args.entries as Array<Record<string, unknown>>) {
        const key = progressKey(raw);
        const index = list.findIndex((i) => progressKey(i) === key);
        if (index >= 0) list[index] = { ...list[index], ...raw };
        else list.push(raw);
        diff.push(`~ progress ${key}`);
      }
    } else if (tool === 'nuvio_delete_watch_progress') {
      for (const raw of args.keys as Array<Record<string, unknown>>) {
        const key = progressKey(raw);
        const index = list.findIndex((i) => progressKey(i) === key);
        if (index >= 0) list.splice(index, 1);
        diff.push(`- progress ${key}`);
      }
    } else {
      throw new NuvioError(`Unsupported watch progress operation: ${tool}`);
    }
    return { state: list, diff };
  },
  write: async (client, ref, state, _meta, originId) => {
    await pushList(
      client,
      ref,
      (await readResource(client, ref)) as Array<Record<string, unknown>>,
      state as Array<Record<string, unknown>>,
      (i) => (typeof i.progress_key === 'string' && i.progress_key ? i.progress_key : progressKey(i)),
      'sync_push_watch_progress',
      'p_entries',
      'sync_delete_watch_progress',
      'p_keys',
      (i) => i.progress_key ?? progressKey(i),
      originId
    );
  },
};

function historyKey(i: Record<string, unknown>): string {
  return `${i.content_id}|${i.season ?? -1}|${i.episode ?? -1}`;
}

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
  plan: (state, args) => {
    const tool = String(args.__tool);
    const list = copy(state as Array<Record<string, unknown>>);
    const diff: string[] = [];
    if (tool === 'nuvio_add_to_watch_history') {
      for (const raw of args.items as Array<Record<string, unknown>>) {
        const key = historyKey(raw);
        const index = list.findIndex((i) => historyKey(i) === key);
        if (index >= 0) list[index] = { ...list[index], ...raw };
        else list.push(raw);
        diff.push(`~ watched ${key}`);
      }
    } else if (tool === 'nuvio_delete_watch_history') {
      for (const raw of args.keys as Array<Record<string, unknown>>) {
        const key = historyKey(raw);
        const index = list.findIndex((i) => historyKey(i) === key);
        if (index >= 0) list.splice(index, 1);
        diff.push(`- watched ${key}`);
      }
    } else {
      throw new NuvioError(`Unsupported watch history operation: ${tool}`);
    }
    return { state: list, diff };
  },
  write: async (client, ref, state, _meta, originId) => {
    await pushList(
      client,
      ref,
      (await readResource(client, ref)) as Array<Record<string, unknown>>,
      state as Array<Record<string, unknown>>,
      (i) => historyKey(i),
      'sync_push_watched_items',
      'p_items',
      'sync_delete_watched_items',
      'p_keys',
      (i) => ({ content_id: i.content_id, season: i.season ?? null, episode: i.episode ?? null }),
      originId
    );
  },
};

/**
 * Canonical plan-supported operations. Only canonical tools are registered here;
 * deprecated aliases are intentionally absent (a plan rejects them).
 */
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

/** Per-tool schema override: add/reorder/remove share a name-family default schema in the descriptor. */
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
  captureComposite: (entries: SnapshotResourceEntry[]) => string | undefined;
  rollback: (entries: SnapshotResourceEntry[]) => Promise<{ ok: boolean; detail: string }>;
}

/**
 * Execute (or preview) a plan. Every operation is validated against the same Zod
 * schema as its direct tool; reads happen once per resource; writes happen once
 * per resource; a single composite snapshot (with per-resource scope) enables
 * rollback and undo.
 */
export async function applyPlan(
  operations: PlanOperation[],
  dryRun: boolean,
  deps: PlanDeps
): Promise<PlanResult> {
  const { client } = deps;
  const perOp: PlanOperationReport[] = [];
  const states = new Map<string, ResourceState>();
  const order: string[] = [];
  let current: { index: number; tool: string } | undefined;

  try {
    if (operations.length === 0) throw new NuvioError('apply_plan: at least one operation is required');

    // 1. Validate every operation against the canonical schema and resolve resources.
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
      const schema = planSchemaFor(op.tool)!;
      const parsed = z.object(schema).parse(op.args) as Record<string, unknown>;
      descriptor.validate?.(parsed);
      const ref = descriptor.ref(parsed);
      const key = resourceKey(ref);
      if (!states.has(key)) {
        states.set(key, { ref, key, before: undefined, after: undefined, scope: undefined, meta: {} });
        order.push(key);
      }
    });

    // 2. Read each resource exactly once (and its concurrency metadata).
    for (const key of order) {
      const entry = states.get(key)!;
      entry.before = await readResource(client, entry.ref);
      entry.after = entry.before;
      const descriptor = descriptorFor(entry.ref, operations);
      if (descriptor.readMeta) entry.meta = await descriptor.readMeta(client, entry.ref);
    }

    // 3. Plan each operation against the evolving state, unioning per-resource scope.
    operations.forEach((op, index) => {
      current = { index, tool: op.tool };
      const descriptor = DESCRIPTORS[op.tool];
      const schema = planSchemaFor(op.tool)!;
      const parsed = z.object(schema).parse(op.args) as Record<string, unknown>;
      const ref = descriptor.ref(parsed);
      const key = resourceKey(ref);
      const entry = states.get(key)!;
      const result = descriptor.plan(entry.after, { ...parsed, __tool: op.tool });
      entry.after = result.state;
      if (descriptor.scope) {
        const scope = descriptor.scope({ ...parsed, __tool: op.tool });
        entry.scope = unionScope(entry.scope, scope);
      }
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

  // 4. Composite snapshot (per-resource scope), then one write per resource.
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
      await descriptor.write(client, entry.ref, entry.after, entry.meta, deps.originId);
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

  // 5. Roll back only resources that may have been modified. A guarded-write
  //    conflict has no side effect, so it is excluded — a blind rollback would
  //    overwrite the newer concurrent state.
  const rollbackEntries: SnapshotResourceEntry[] = order
    .filter((key) => {
      if (completedResources.includes(key)) return true;
      if (key === attemptedResources[attemptedResources.length - 1]) {
        return failedMayHaveApplied && !failedConflict;
      }
      return false;
    })
    .map((key) => {
      const e = states.get(key)!;
      return { resource: e.ref, before: e.before, scope: e.scope };
    });

  let rollback: PlanResult['rollback'];
  if (failedConflict && rollbackEntries.length === 0) {
    rollback = {
      attempted: false,
      successful: false,
      detail: 'Concurrent change detected; rollback skipped to avoid overwriting the newer state.',
    };
  } else if (!writePhaseStarted) {
    rollback = { attempted: false, successful: false, detail: 'No write was attempted.' };
  } else {
    try {
      const detail = await deps.rollback(rollbackEntries);
      rollback = { attempted: true, successful: detail.ok, detail: detail.detail };
    } catch (error) {
      rollback = {
        attempted: true,
        successful: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  let status: PlanStatus;
  if (!writePhaseStarted) status = 'failed_before_apply';
  else if (failedConflict && rollbackEntries.length === 0) status = 'partially_applied';
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

/** Resolve the descriptor for a resource that may have several contributing tools. */
function descriptorFor(ref: ResourceRef, operations: PlanOperation[]): Descriptor {
  const key = resourceKey(ref);
  for (const op of operations) {
    const d = DESCRIPTORS[op.tool];
    if (
      d &&
      resourceKey(d.ref(z.object(planSchemaFor(op.tool)!).parse(op.args) as Record<string, unknown>)) === key
    ) {
      return d;
    }
  }
  throw new NuvioError(`apply_plan: no descriptor for resource ${key}`);
}
