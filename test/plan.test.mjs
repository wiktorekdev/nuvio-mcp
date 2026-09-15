import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startMockNuvio } from './mock-nuvio.mjs';
import { startStdio, lastSnapshotId } from './helpers.mjs';

let mock;
let mcp;

before(async () => {
  mock = await startMockNuvio();
  mcp = await startStdio(mock.url);
});

after(async () => {
  await mcp?.close();
  await mock?.close();
});

const parse = (out) => JSON.parse(out.replace(/```json|```/g, ''));
const calls = (name) => mock.stats()[name] ?? 0;
const snapCount = () => {
  try {
    return readdirSync(join(mcp.dir, 'snapshots')).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
};
const reset = () => {
  mock.resetStats();
  mock.clearFailures();
};

const settingsCall = (extra = {}) => ({
  profile_id: 1,
  platform: 'tv',
  patch: { features: { marker: Date.now() + Math.random() } },
  ...extra,
});

// ---------------------------------------------------------------------------
// Mutation pipeline
// ---------------------------------------------------------------------------

test('a normal write reads its resource exactly once', async () => {
  reset();
  await mcp.call('nuvio_update_settings', settingsCall());
  assert.equal(calls('sync_pull_profile_settings_blob'), 1, 'settings read once');
  assert.equal(
    calls('sync_push_profile_settings_blob') + calls('sync_push_profile_settings_blob_guarded'),
    1,
    'settings written once'
  );
});

test('dry_run writes nothing and creates no snapshot', async () => {
  const before = snapCount();
  reset();
  const out = await mcp.call(
    'nuvio_update_settings',
    settingsCall({ dry_run: true, patch: { features: { dry: 1 } } })
  );
  assert.match(out, /Preview/);
  assert.equal(calls('sync_push_profile_settings_blob'), 0);
  assert.equal(calls('sync_push_profile_settings_blob_guarded'), 0);
  assert.equal(snapCount(), before, 'dry_run must not snapshot');
  const settings = parse(await mcp.call('nuvio_get_settings', { profile_id: 1, platform: 'tv' }));
  assert.equal(settings.settings_json.features?.dry, undefined, 'dry_run must not write');
});

test('an unchanged mutation writes nothing and leaves no snapshot', async () => {
  await mcp.call('nuvio_update_settings', {
    profile_id: 1,
    platform: 'tv',
    patch: { features: { stable: 'v' } },
  });
  const before = snapCount();
  reset();
  const out = await mcp.call('nuvio_update_settings', {
    profile_id: 1,
    platform: 'tv',
    patch: { features: { stable: 'v' } },
  });
  assert.match(out, /No changes required/);
  assert.equal(
    calls('sync_push_profile_settings_blob') + calls('sync_push_profile_settings_blob_guarded'),
    0
  );
  assert.equal(snapCount(), before, 'no snapshot should be left behind');
});

test('an applied mutation creates exactly one snapshot', async () => {
  const before = snapCount();
  await mcp.call('nuvio_update_settings', settingsCall());
  assert.equal(snapCount(), before + 1);
});

test('addons read once per add mutation', async () => {
  reset();
  await mcp.call('nuvio_update_addon', {
    profile_id: 1,
    url: 'https://example.com/a/manifest.json',
    name: 'A2',
  });
  assert.equal(calls('select:addons'), 1);
});

// ---------------------------------------------------------------------------
// apply_plan
// ---------------------------------------------------------------------------

const tenSettingsOps = Array.from({ length: 10 }, (_, i) => ({
  tool: 'nuvio_update_settings',
  args: { profile_id: 1, platform: 'tv', set: [{ path: `features.plan_k${i}`, value: i }] },
}));

test('apply_plan: 10 ops on one resource → 1 read and 1 write', async () => {
  reset();
  const out = await mcp.call('nuvio_apply_plan', { operations: tenSettingsOps, dry_run: false });
  assert.match(out, /Plan applied/);
  assert.equal(calls('sync_pull_profile_settings_blob'), 1, 'one read for the resource');
  assert.equal(calls('sync_push_profile_settings_blob'), 1, 'one write for the resource');
  const settings = parse(await mcp.call('nuvio_get_settings', { profile_id: 1, platform: 'tv' }));
  for (let i = 0; i < 10; i += 1) assert.equal(settings.settings_json.features[`plan_k${i}`], i);
});

test('apply_plan: two resources → two reads', async () => {
  reset();
  await mcp.call('nuvio_apply_plan', {
    operations: [
      {
        tool: 'nuvio_update_settings',
        args: { profile_id: 1, platform: 'tv', patch: { features: { two: 1 } } },
      },
      {
        tool: 'nuvio_update_home_catalog_settings',
        args: { profile_id: 1, platform: 'tv', patch: { row: 1 } },
      },
    ],
    dry_run: true,
  });
  assert.equal(calls('sync_pull_profile_settings_blob'), 1);
  assert.equal(calls('sync_pull_home_catalog_settings'), 1);
  assert.equal(calls('sync_push_profile_settings_blob'), 0);
  assert.equal(calls('sync_push_home_catalog_settings'), 0);
});

test('apply_plan: dry run writes nothing and creates no snapshot', async () => {
  const before = snapCount();
  reset();
  const out = await mcp.call('nuvio_apply_plan', {
    operations: [
      {
        tool: 'nuvio_update_settings',
        args: { profile_id: 1, platform: 'tv', patch: { features: { dr: 1 } } },
      },
    ],
    dry_run: true,
  });
  assert.match(out, /Plan preview/);
  assert.equal(calls('sync_push_profile_settings_blob'), 0);
  assert.equal(snapCount(), before);
});

test('apply_plan: apply creates exactly one composite snapshot', async () => {
  const before = snapCount();
  const out = await mcp.call('nuvio_apply_plan', {
    operations: [
      {
        tool: 'nuvio_update_settings',
        args: { profile_id: 1, platform: 'tv', patch: { features: { c1: 1 } } },
      },
      {
        tool: 'nuvio_update_home_catalog_settings',
        args: { profile_id: 1, platform: 'tv', patch: { c2: 1 } },
      },
    ],
    dry_run: false,
  });
  assert.equal(snapCount(), before + 1, 'exactly one composite snapshot');
  const id = lastSnapshotId(out);
  assert.ok(id);
  const inspected = parse(await mcp.call('nuvio_inspect_snapshot', { snapshot_id: id }));
  assert.equal(inspected.composite, true);
  assert.equal(inspected.resources.length, 2);
});

test('apply_plan rejects an invalid operation before writing', async () => {
  reset();
  const out = await mcp.call('nuvio_apply_plan', {
    operations: [{ tool: 'nuvio_not_a_tool', args: {} }],
    dry_run: false,
  });
  assert.match(out, /rejected before any write|not supported/);
  assert.equal(calls('sync_push_profile_settings_blob'), 0);
});

test('apply_plan rejects an irreversible operation before writing', async () => {
  reset();
  const out = await mcp.call('nuvio_apply_plan', {
    operations: [{ tool: 'nuvio_delete_profile', args: { profile_id: 2 } }],
    dry_run: false,
  });
  assert.match(out, /irreversible/);
  assert.equal(calls('sync_delete_profile_data'), 0);
});

test('apply_plan: failure of the first write is reported as failed_before_apply', async () => {
  reset();
  mock.failRpc('sync_push_profile_settings_blob', 1);
  const out = await mcp.call('nuvio_apply_plan', {
    operations: [
      {
        tool: 'nuvio_update_settings',
        args: { profile_id: 1, platform: 'tv', patch: { features: { f1: 1 } } },
      },
    ],
    dry_run: false,
  });
  assert.match(out, /rejected before any write/);
  assert.ok(calls('sync_push_profile_settings_blob') >= 1, 'the write was attempted');
  const settings = parse(await mcp.call('nuvio_get_settings', { profile_id: 1, platform: 'tv' }));
  assert.equal(settings.settings_json.features?.f1, undefined, 'nothing was applied');
});

test('apply_plan: a middle write failure rolls back everything', async () => {
  // Seed a known settings value so we can prove the rollback restored it.
  await mcp.call('nuvio_update_settings', {
    profile_id: 1,
    platform: 'tv',
    patch: { features: { rollback_probe: 'original' } },
  });
  reset();
  mock.failRpc('sync_push_home_catalog_settings', 1);
  const out = await mcp.call('nuvio_apply_plan', {
    operations: [
      {
        tool: 'nuvio_update_settings',
        args: { profile_id: 1, platform: 'tv', patch: { features: { rollback_probe: 'changed' } } },
      },
      {
        tool: 'nuvio_update_home_catalog_settings',
        args: { profile_id: 1, platform: 'tv', patch: { row: 9 } },
      },
    ],
    dry_run: false,
  });
  assert.match(out, /rolled back/);
  assert.match(out, /Rollback: attempted=true successful=true/);
  const settings = parse(await mcp.call('nuvio_get_settings', { profile_id: 1, platform: 'tv' }));
  assert.equal(settings.settings_json.features.rollback_probe, 'original', 'settings restored');
});

test('apply_plan: a failed rollback is reported as partially_applied', async () => {
  reset();
  // First home push (the plan) and the rollback home push both fail.
  mock.failRpc('sync_push_home_catalog_settings', 2);
  const out = await mcp.call('nuvio_apply_plan', {
    operations: [
      {
        tool: 'nuvio_update_settings',
        args: { profile_id: 1, platform: 'tv', patch: { features: { partial: 1 } } },
      },
      {
        tool: 'nuvio_update_home_catalog_settings',
        args: { profile_id: 1, platform: 'tv', patch: { row: 2 } },
      },
    ],
    dry_run: false,
  });
  assert.match(out, /partially applied/);
  assert.match(out, /Rollback: attempted=true successful=false/);
});

test('apply_plan: a whole plan can be undone and redone', async () => {
  await mcp.call('nuvio_update_settings', {
    profile_id: 1,
    platform: 'tv',
    patch: { features: { plan_undo: 'before' } },
  });
  const applied = await mcp.call('nuvio_apply_plan', {
    operations: [
      {
        tool: 'nuvio_update_settings',
        args: { profile_id: 1, platform: 'tv', patch: { features: { plan_undo: 'after' } } },
      },
      {
        tool: 'nuvio_update_home_catalog_settings',
        args: { profile_id: 1, platform: 'tv', patch: { plan_row: 'after' } },
      },
    ],
    dry_run: false,
  });
  assert.match(applied, /Plan applied/);
  let settings = parse(await mcp.call('nuvio_get_settings', { profile_id: 1, platform: 'tv' }));
  assert.equal(settings.settings_json.features.plan_undo, 'after');

  assert.match(await mcp.call('nuvio_undo'), /Reverted/);
  settings = parse(await mcp.call('nuvio_get_settings', { profile_id: 1, platform: 'tv' }));
  assert.equal(settings.settings_json.features.plan_undo, 'before', 'undo reverts the whole plan');

  assert.match(await mcp.call('nuvio_redo'), /Re-applied/);
  settings = parse(await mcp.call('nuvio_get_settings', { profile_id: 1, platform: 'tv' }));
  assert.equal(settings.settings_json.features.plan_undo, 'after', 'redo re-applies the whole plan');
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test('library and progress upserts are idempotent', async () => {
  const item = { content_id: 'idem-1', content_type: 'movie', name: 'Idem' };
  await mcp.call('nuvio_add_to_library', { profile_id: 1, items: [item] });
  await mcp.call('nuvio_add_to_library', { profile_id: 1, items: [item] });
  const library = parse(await mcp.call('nuvio_get_library', { profile_id: 1 }));
  assert.equal(library.filter((i) => i.content_id === 'idem-1').length, 1);

  const entry = { content_id: 'idem-1', content_type: 'movie', position: 1, duration: 10 };
  await mcp.call('nuvio_set_watch_progress', { profile_id: 1, entries: [entry] });
  await mcp.call('nuvio_set_watch_progress', { profile_id: 1, entries: [entry] });
  const progress = parse(await mcp.call('nuvio_get_watch_progress', { profile_id: 1 }));
  assert.equal(progress.filter((p) => p.content_id === 'idem-1').length, 1);
});

// ---------------------------------------------------------------------------
// Backup scoping
// ---------------------------------------------------------------------------

test('a full backup is returned unwrapped', async () => {
  const out = parse(await mcp.call('nuvio_export_backup', {}));
  assert.equal(out.version, 1);
});

test('a scoped backup that cannot be confirmed warns instead of pretending to be scoped', async () => {
  const out = parse(await mcp.call('nuvio_export_backup', { scope: ['settings'], profile_ids: [1] }));
  assert.equal(out.scope_verified, false);
  assert.match(out.warning, /FULL backup|did not confirm/);
  assert.ok(out.backup, 'the raw backup is still returned for inspection');
});

// ---------------------------------------------------------------------------
// API contract
// ---------------------------------------------------------------------------

test('no public profile tool exposes profile_index', async () => {
  const tools = await mcp.client.listTools();
  for (const tool of tools.tools) {
    const props = tool.inputSchema?.properties ?? {};
    assert.ok(!('profile_index' in props), `${tool.name} must use profile_id, not profile_index`);
  }
});
