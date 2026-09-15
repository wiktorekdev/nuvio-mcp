import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
import type { ResourceRef } from '../snapshots.js';
import { readResource } from '../snapshots.js';
import { applySettingsEdit, diffTree, type SettingsPatch } from './settings.js';

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
  failed_operation?: { index: number; tool: string; error: string };
  rollback?: { attempted: boolean; successful: boolean; detail: string };
  snapshot_id?: string;
}

interface ResourceState {
  ref: ResourceRef;
  key: string;
  before: unknown;
  after: unknown;
}

interface Planner {
  /** Map operation args to the resource it touches. */
  ref(args: Record<string, unknown>): ResourceRef;
  /** Pure transform of the resource state. Returns the next state and a diff. */
  plan(state: unknown, args: Record<string, unknown>): { state: unknown; diff: string[] };
  /** Persist the final resource state. */
  write(client: NuvioClient, ref: ResourceRef, state: unknown, originId: string): Promise<void>;
}

function num(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 6) {
    throw new NuvioError(`apply_plan: "${key}" must be an integer 1..6`);
  }
  return value;
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0)
    throw new NuvioError(`apply_plan: "${key}" is required`);
  return value;
}

function platform(args: Record<string, unknown>): string {
  return typeof args.platform === 'string' && args.platform ? args.platform : 'tv';
}

export function resourceKey(ref: ResourceRef): string {
  const r = ref as { kind: string; profile_id?: number; platform?: string };
  return `${r.kind}${r.profile_id !== undefined ? `:${r.profile_id}` : ''}${r.platform ? `/${r.platform}` : ''}`;
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

// ---------------------------------------------------------------------------
// Planners
// ---------------------------------------------------------------------------

const settingsPlanner: Planner = {
  ref: (args) => ({ kind: 'settings', profile_id: num(args, 'profile_id'), platform: platform(args) }),
  plan: (state, args) => {
    const edit: SettingsPatch = {
      patch: args.patch as Record<string, unknown> | undefined,
      set: args.set as Array<{ path: string; value: unknown }> | undefined,
      unset: args.unset as string[] | undefined,
    };
    const result = applySettingsEdit((state as Record<string, unknown>) ?? {}, edit);
    return { state: result.after, diff: result.diff };
  },
  write: (client, ref, state, originId) =>
    client.rpc('sync_push_profile_settings_blob', {
      p_profile_id: (ref as { profile_id: number }).profile_id,
      p_platform: (ref as { platform: string }).platform,
      p_settings_json: state,
      p_origin_client_id: originId,
    }),
};

const homePlanner: Planner = {
  ref: (args) => ({
    kind: 'home_catalog_settings',
    profile_id: num(args, 'profile_id'),
    platform: platform(args),
  }),
  plan: (state, args) => {
    const edit: SettingsPatch = {
      patch: args.patch as Record<string, unknown> | undefined,
      set: args.set as Array<{ path: string; value: unknown }> | undefined,
      unset: args.unset as string[] | undefined,
    };
    const result = applySettingsEdit((state as Record<string, unknown>) ?? {}, edit);
    return { state: result.after, diff: result.diff };
  },
  write: (client, ref, state, originId) =>
    client.rpc('sync_push_home_catalog_settings', {
      p_profile_id: (ref as { profile_id: number }).profile_id,
      p_platform: (ref as { platform: string }).platform,
      p_settings_json: state,
      p_origin_client_id: originId,
    }),
};

async function pushList(
  client: NuvioClient,
  ref: ResourceRef,
  before: Record<string, unknown>[],
  after: Record<string, unknown>[],
  keyOf: (item: Record<string, unknown>) => string,
  upsertRpc: string,
  upsertField: string,
  deleteRpc: string,
  deleteField: string,
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
  if (removals.length > 0) {
    await client.rpc(deleteRpc, {
      p_profile_id: profileId,
      [deleteField]: removals.map((i) => keyOf(i)),
      p_origin_client_id: originId,
    });
  }
  if (upserts.length > 0) {
    await client.rpc(upsertRpc, {
      p_profile_id: profileId,
      [upsertField]: upserts,
      p_origin_client_id: originId,
    });
  }
}

const addonsPlanner: Planner = {
  ref: (args) => ({ kind: 'addons', profile_id: num(args, 'profile_id') }),
  plan: (state, args) => {
    const list = copy(state as Record<string, unknown>[]);
    const diff: string[] = [];
    const tool = String(args.__tool);
    if (tool === 'nuvio_add_addon') {
      const url = str(args, 'url');
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
      const changes = args;
      if (changes.name !== undefined) target.name = changes.name;
      if (changes.enabled !== undefined) target.enabled = changes.enabled;
      if (changes.sort_order !== undefined) target.sort_order = changes.sort_order;
      diff.push(`~ addon ${String(target.url)}`);
    } else if (tool === 'nuvio_reorder_addons') {
      const ordered = args.ordered_urls as string[];
      const current = list.map((a) => a.url).sort();
      if (ordered.length !== current.length || [...ordered].sort().some((u, i) => u !== current[i])) {
        throw new NuvioError('Reorder must list every installed addon URL exactly once.');
      }
      const next = ordered.map((url, index) => ({ ...list.find((a) => a.url === url)!, sort_order: index }));
      diff.push('~ reorder addons');
      return { state: next, diff };
    } else if (tool === 'nuvio_remove_addon') {
      const target = findAddon(list, args);
      const next = list.filter((a) => a.url !== target.url);
      diff.push(`- addon ${String(target.url)}`);
      return { state: next, diff };
    } else {
      throw new NuvioError(`Unsupported addon operation: ${tool}`);
    }
    return { state: list, diff };
  },
  write: async (client, ref, state, originId) => {
    await client.rpc('sync_push_addons', {
      p_profile_id: (ref as { profile_id: number }).profile_id,
      p_addons: state,
      p_origin_client_id: originId,
    });
  },
};

function findAddon(list: Record<string, unknown>[], args: Record<string, unknown>): Record<string, unknown> {
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

const providersPlanner: Planner = {
  ref: (args) => ({ kind: 'provider_credentials', profile_id: num(args, 'profile_id') }),
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
  write: async (client, ref, state, originId) => {
    const profileId = (ref as { profile_id: number }).profile_id;
    const before = (await readResource(client, ref)) as Array<{ provider: string }>;
    const wanted = new Set((state as Array<{ provider: string }>).map((c) => c.provider));
    for (const cred of before) {
      if (!wanted.has(cred.provider)) {
        await client.rpc('sync_delete_provider_credentials', {
          p_profile_id: profileId,
          p_provider: cred.provider,
          p_origin_client_id: originId,
        });
      }
    }
    const rows = state as Array<{ provider: string; credential_json: unknown }>;
    if (rows.length > 0) {
      await client.rpc('sync_push_provider_credentials', {
        p_profile_id: profileId,
        p_credentials: rows,
        p_origin_client_id: originId,
      });
    }
  },
};

const libraryPlanner: Planner = {
  ref: (args) => ({ kind: 'library', profile_id: num(args, 'profile_id') }),
  plan: (state, args) => {
    const tool = String(args.__tool);
    const list = copy(state as Record<string, unknown>[]);
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
  write: async (client, ref, state, originId) => {
    const keyOf = (i: Record<string, unknown>) => `${i.content_type}:${i.content_id}`;
    const before = (await readResource(client, ref)) as Record<string, unknown>[];
    await pushList(
      client,
      ref,
      before,
      state as Record<string, unknown>[],
      keyOf,
      'sync_push_library_items',
      'p_items',
      'sync_delete_library_items',
      'p_keys',
      originId
    );
  },
};

const progressPlanner: Planner = {
  ref: (args) => ({ kind: 'watch_progress', profile_id: num(args, 'profile_id') }),
  plan: (state, args) => {
    const tool = String(args.__tool);
    const list = copy(state as Record<string, unknown>[]);
    const diff: string[] = [];
    const keyOf = (i: Record<string, unknown>) =>
      i.season != null ? `${i.content_id}_s${i.season}e${i.episode}` : String(i.content_id);
    if (tool === 'nuvio_set_watch_progress') {
      for (const raw of args.entries as Array<Record<string, unknown>>) {
        const key = keyOf(raw);
        const index = list.findIndex((i) => keyOf(i) === key);
        if (index >= 0) list[index] = { ...list[index], ...raw };
        else list.push(raw);
        diff.push(`~ progress ${key}`);
      }
    } else if (tool === 'nuvio_delete_watch_progress') {
      for (const raw of args.keys as Array<Record<string, unknown>>) {
        const key = keyOf(raw);
        const index = list.findIndex((i) => keyOf(i) === key);
        if (index >= 0) list.splice(index, 1);
        diff.push(`- progress ${key}`);
      }
    } else {
      throw new NuvioError(`Unsupported watch progress operation: ${tool}`);
    }
    return { state: list, diff };
  },
  write: async (client, ref, state, originId) => {
    const keyOf = (i: Record<string, unknown>) =>
      typeof i.progress_key === 'string' && i.progress_key
        ? i.progress_key
        : i.season != null
          ? `${i.content_id}_s${i.season}e${i.episode}`
          : String(i.content_id);
    await pushList(
      client,
      ref,
      (await readResource(client, ref)) as Record<string, unknown>[],
      state as Record<string, unknown>[],
      keyOf,
      'sync_push_watch_progress',
      'p_entries',
      'sync_delete_watch_progress',
      'p_keys',
      originId
    );
  },
};

const historyPlanner: Planner = {
  ref: (args) => ({ kind: 'watch_history', profile_id: num(args, 'profile_id') }),
  plan: (state, args) => {
    const tool = String(args.__tool);
    const list = copy(state as Record<string, unknown>[]);
    const diff: string[] = [];
    const keyOf = (i: Record<string, unknown>) => `${i.content_id}|${i.season ?? -1}|${i.episode ?? -1}`;
    if (tool === 'nuvio_add_to_watch_history') {
      for (const raw of args.items as Array<Record<string, unknown>>) {
        const key = keyOf(raw);
        const index = list.findIndex((i) => keyOf(i) === key);
        if (index >= 0) list[index] = { ...list[index], ...raw };
        else list.push(raw);
        diff.push(`~ watched ${key}`);
      }
    } else if (tool === 'nuvio_delete_watch_history') {
      for (const raw of args.keys as Array<Record<string, unknown>>) {
        const key = keyOf(raw);
        const index = list.findIndex((i) => keyOf(i) === key);
        if (index >= 0) list.splice(index, 1);
        diff.push(`- watched ${key}`);
      }
    } else {
      throw new NuvioError(`Unsupported watch history operation: ${tool}`);
    }
    return { state: list, diff };
  },
  write: async (client, ref, state, originId) => {
    const keyOf = (i: Record<string, unknown>) => `${i.content_id}|${i.season ?? -1}|${i.episode ?? -1}`;
    await pushList(
      client,
      ref,
      (await readResource(client, ref)) as Record<string, unknown>[],
      state as Record<string, unknown>[],
      keyOf,
      'sync_push_watched_items',
      'p_items',
      'sync_delete_watched_items',
      'p_keys',
      originId
    );
  },
};

const PLANNERS: Record<string, Planner> = {
  nuvio_update_settings: settingsPlanner,
  nuvio_set_setting: settingsPlanner,
  nuvio_update_home_catalog_settings: homePlanner,
  nuvio_set_home_catalog_path: homePlanner,
  nuvio_add_addon: addonsPlanner,
  nuvio_update_addon: addonsPlanner,
  nuvio_toggle_addon: addonsPlanner,
  nuvio_reorder_addons: addonsPlanner,
  nuvio_remove_addon: addonsPlanner,
  nuvio_set_provider_credential: providersPlanner,
  nuvio_delete_provider_credential: providersPlanner,
  nuvio_add_to_library: libraryPlanner,
  nuvio_remove_from_library: libraryPlanner,
  nuvio_set_watch_progress: progressPlanner,
  nuvio_delete_watch_progress: progressPlanner,
  nuvio_add_to_watch_history: historyPlanner,
  nuvio_mark_watched: historyPlanner,
  nuvio_delete_watch_history: historyPlanner,
};

/** Irreversible tools that a plan must never contain. */
const IRREVERSIBLE = new Set([
  'nuvio_delete_profile',
  'nuvio_restore_backup',
  'nuvio_revoke_session',
  'nuvio_set_profile_pin',
  'nuvio_clear_profile_pin',
  'nuvio_register_device',
]);

export function isPlanSupported(tool: string): boolean {
  return tool in PLANNERS;
}

export function isPlanIrreversible(tool: string): boolean {
  return IRREVERSIBLE.has(tool);
}

export interface PlanDeps {
  client: NuvioClient;
  originId: string;
  /** Returns a composite snapshot id, or undefined when snapshots are disabled. */
  captureComposite: (entries: Array<{ resource: ResourceRef; before: unknown }>) => string | undefined;
  rollback: (snapshotId: string) => Promise<{ ok: boolean; detail: string }>;
}

/**
 * Execute (or preview) a plan. Validation, reads and pure computation happen
 * before any write; writes are grouped by resource so each resource is read
 * once and written once.
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

  // 1-3. Validate, read once per resource, and compute every change in memory.
  try {
    if (operations.length === 0) throw new NuvioError('apply_plan: at least one operation is required');

    operations.forEach((op, index) => {
      current = { index, tool: op.tool };
      if (isPlanIrreversible(op.tool)) {
        throw new NuvioError(`apply_plan: "${op.tool}" is irreversible and cannot be part of a plan.`);
      }
      const planner = PLANNERS[op.tool];
      if (!planner) throw new NuvioError(`apply_plan: "${op.tool}" is not supported by a plan.`);
      const ref = planner.ref(op.args);
      const key = resourceKey(ref);
      if (!states.has(key)) {
        states.set(key, { ref, key, before: undefined, after: undefined });
        order.push(key);
      }
    });

    for (const key of order) {
      const entry = states.get(key)!;
      entry.before = await readResource(client, entry.ref);
      entry.after = entry.before;
    }

    operations.forEach((op, index) => {
      current = { index, tool: op.tool };
      const planner = PLANNERS[op.tool];
      const ref = planner.ref(op.args);
      const key = resourceKey(ref);
      const entry = states.get(key)!;
      const result = planner.plan(entry.after, { ...op.args, __tool: op.tool });
      entry.after = result.state;
      perOp.push({ index, tool: op.tool, resource: key, diff: result.diff });
    });
  } catch (error) {
    return {
      status: 'failed_before_apply',
      dry_run: dryRun,
      operations: perOp,
      resources: [],
      applied_operations: [],
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
    };
  }

  // 4. Composite snapshot, then exactly one write per resource.
  const snapshotId = deps.captureComposite(
    order.map((key) => ({ resource: states.get(key)!.ref, before: states.get(key)!.before }))
  );
  const applied: number[] = [];
  let failedOperation: PlanResult['failed_operation'];
  let writesSucceeded = 0;

  for (const key of order) {
    const entry = states.get(key)!;
    // Use the first operation touching this resource as the representative writer.
    const representative = perOp.find((op) => op.resource === key)!;
    try {
      await PLANNERS[representative.tool].write(client, entry.ref, entry.after, deps.originId);
      writesSucceeded += 1;
      for (const op of perOp) if (op.resource === key) applied.push(op.index);
    } catch (error) {
      failedOperation = {
        index: representative.index,
        tool: representative.tool,
        error: error instanceof Error ? error.message : String(error),
      };
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
      snapshot_id: snapshotId,
    };
  }

  // 5. Roll back on failure.
  let rollback: PlanResult['rollback'];
  if (!snapshotId) {
    rollback = {
      attempted: false,
      successful: false,
      detail: 'Snapshots are disabled; no rollback was possible.',
    };
  } else {
    try {
      const detail = await deps.rollback(snapshotId);
      rollback = { attempted: true, successful: detail.ok, detail: detail.detail };
    } catch (error) {
      rollback = {
        attempted: true,
        successful: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const status: PlanStatus =
    writesSucceeded === 0 ? 'failed_before_apply' : rollback.successful ? 'rolled_back' : 'partially_applied';

  return {
    status,
    dry_run: false,
    operations: perOp,
    resources,
    applied_operations: applied,
    failed_operation: failedOperation,
    rollback,
    snapshot_id: snapshotId,
  };
}
