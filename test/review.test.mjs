import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startMockNuvio } from './mock-nuvio.mjs';
import { startStdio, lastSnapshotId } from './helpers.mjs';

let mock;
let mcp;
let mcpNoSnap;

before(async () => {
  mock = await startMockNuvio();
  mcp = await startStdio(mock.url);
  mcpNoSnap = await startStdio(mock.url, { NUVIO_DISABLE_SNAPSHOTS: 'true' });
});

after(async () => {
  await mcp?.close();
  await mcpNoSnap?.close();
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
  mock.clearHooks();
};
const setSettings = (profile, platform, json) => {
  mock.store.settings[`${profile}:${platform}`] = {
    settings_json: json,
    updated_at: new Date().toISOString(),
  };
};
const validPlan = (operations) => ({ operations, dry_run: false });

// ---------------------------------------------------------------------------
// A. Schema equivalence: direct tool and plan use the same validation
// ---------------------------------------------------------------------------

const malformed = [
  [
    'enabled as string',
    'nuvio_update_addon',
    { profile_id: 1, url: 'https://e.example/m.json', enabled: 'false' },
  ],
  ['invalid profile_id', 'nuvio_update_settings', { profile_id: 7, platform: 'tv', patch: { a: 1 } }],
  ['invalid addon url', 'nuvio_add_addon', { profile_id: 1, url: 'not a url' }],
  ['missing addon identifier', 'nuvio_update_addon', { profile_id: 1, name: 'x' }],
  ['malformed library item', 'nuvio_add_to_library', { profile_id: 1, items: [{ content_id: 'x' }] }],
  [
    'malformed progress entry',
    'nuvio_set_watch_progress',
    { profile_id: 1, entries: [{ content_id: 'x', content_type: 'movie' }] },
  ],
  ['malformed history item', 'nuvio_add_to_watch_history', { profile_id: 1, items: [{ content_id: 'x' }] }],
  [
    'unsupported provider',
    'nuvio_set_provider_credential',
    { profile_id: 1, provider: 'nope', api_key: 'k'.repeat(20) },
  ],
  [
    'wrong settings set shape',
    'nuvio_update_settings',
    { profile_id: 1, platform: 'tv', set: { path: 'a', value: 1 } },
  ],
];

for (const [label, tool, args] of malformed) {
  test(`direct ${tool} rejects: ${label}`, async () => {
    const out = await mcp.call(tool, args);
    assert.match(out, /Invalid|expected|Unsupported|provide either/i, out);
  });

  test(`apply_plan rejects ${label} before writing (0 write, 0 snapshot)`, async () => {
    const before = snapCount();
    reset();
    const out = await mcp.call('nuvio_apply_plan', validPlan([{ tool, args }]));
    assert.match(out, /rejected before any write/);
    assert.equal(snapCount(), before);
    assert.equal(
      calls('sync_push_addons') + calls('sync_push_library_items') + calls('sync_push_watch_progress'),
      0
    );
  });
}

test('apply_plan rejects deprecated aliases inside a plan', async () => {
  const before = snapCount();
  reset();
  for (const tool of [
    'nuvio_set_setting',
    'nuvio_unset_setting',
    'nuvio_set_home_catalog_path',
    'nuvio_toggle_addon',
    'nuvio_mark_watched',
  ]) {
    const out = await mcp.call('nuvio_apply_plan', validPlan([{ tool, args: { profile_id: 1 } }]));
    assert.match(out, /rejected before any write|not supported/);
  }
  assert.equal(snapCount(), before);
});

test('plan defaults match the direct tool (enabled defaults to true)', async () => {
  const url = 'https://defaults.example/manifest.json';
  mock.store.addons[1] = [];
  await mcp.call('nuvio_apply_plan', validPlan([{ tool: 'nuvio_add_addon', args: { profile_id: 1, url } }]));
  const added = (mock.store.addons[1] ?? []).find((a) => a.url === url);
  assert.equal(added.enabled, true, 'plan applies the same default as the direct tool');
});

// ---------------------------------------------------------------------------
// B. Composite scope: undo for library / progress / history
// ---------------------------------------------------------------------------

test('composite undo: library add / update / delete', async () => {
  mock.store.library[1] = [];
  const add = await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_add_to_library',
        args: { profile_id: 1, items: [{ content_id: 'A', content_type: 'movie', name: 'n' }] },
      },
    ])
  );
  assert.ok(mock.store.library[1].some((i) => i.content_id === 'A'));
  await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(add) });
  assert.ok(!mock.store.library[1].some((i) => i.content_id === 'A'), 'add undone');

  mock.store.library[1] = [{ content_id: 'B', content_type: 'movie', name: 'before' }];
  const del = await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_remove_from_library',
        args: { profile_id: 1, keys: [{ content_id: 'B', content_type: 'movie' }] },
      },
    ])
  );
  assert.ok(!mock.store.library[1].some((i) => i.content_id === 'B'));
  await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(del) });
  assert.equal(
    mock.store.library[1].find((i) => i.content_id === 'B')?.name,
    'before',
    'delete undone with fields'
  );

  const upd = await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_add_to_library',
        args: { profile_id: 1, items: [{ content_id: 'B', content_type: 'movie', name: 'after' }] },
      },
    ])
  );
  assert.equal(mock.store.library[1].find((i) => i.content_id === 'B')?.name, 'after');
  await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(upd) });
  assert.equal(mock.store.library[1].find((i) => i.content_id === 'B')?.name, 'before', 'update undone');
});

test('composite undo: watch progress add / update / delete', async () => {
  mock.store.progress[1] = [];
  const add = await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_set_watch_progress',
        args: {
          profile_id: 1,
          entries: [{ content_id: 'P', content_type: 'movie', position: 1, duration: 10 }],
        },
      },
    ])
  );
  assert.ok(mock.store.progress[1].some((p) => p.content_id === 'P'));
  await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(add) });
  assert.ok(!mock.store.progress[1].some((p) => p.content_id === 'P'));

  const upd = await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_set_watch_progress',
        args: {
          profile_id: 1,
          entries: [{ content_id: 'P', content_type: 'movie', position: 5, duration: 10 }],
        },
      },
    ])
  );
  assert.equal(mock.store.progress[1].find((p) => p.content_id === 'P')?.position, 5);
  await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(upd) });
  assert.equal(
    mock.store.progress[1].find((p) => p.content_id === 'P'),
    undefined,
    'update undone to absent'
  );

  mock.store.progress[1] = [
    { content_id: 'Q', content_type: 'movie', position: 9, duration: 20, progress_key: 'Q' },
  ];
  const del = await mcp.call(
    'nuvio_apply_plan',
    validPlan([{ tool: 'nuvio_delete_watch_progress', args: { profile_id: 1, keys: [{ content_id: 'Q' }] } }])
  );
  assert.ok(!mock.store.progress[1].some((p) => p.content_id === 'Q'));
  await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(del) });
  assert.equal(
    mock.store.progress[1].find((p) => p.content_id === 'Q')?.position,
    9,
    'progress delete undone'
  );
});

test('composite undo: watch history add / update / delete', async () => {
  mock.store.history[1] = [];
  const add = await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_add_to_watch_history',
        args: { profile_id: 1, items: [{ content_id: 'H', content_type: 'movie', title: 't' }] },
      },
    ])
  );
  assert.ok(mock.store.history[1].some((h) => h.content_id === 'H'));
  await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(add) });
  assert.ok(!mock.store.history[1].some((h) => h.content_id === 'H'));

  mock.store.history[1] = [{ content_id: 'H2', content_type: 'movie', title: 'before' }];
  const del = await mcp.call(
    'nuvio_apply_plan',
    validPlan([{ tool: 'nuvio_delete_watch_history', args: { profile_id: 1, keys: [{ content_id: 'H2' }] } }])
  );
  assert.ok(!mock.store.history[1].some((h) => h.content_id === 'H2'));
  await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(del) });
  assert.equal(mock.store.history[1].find((h) => h.content_id === 'H2')?.title, 'before');

  const upd = await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_add_to_watch_history',
        args: { profile_id: 1, items: [{ content_id: 'H2', content_type: 'movie', title: 'after' }] },
      },
    ])
  );
  assert.equal(mock.store.history[1].find((h) => h.content_id === 'H2')?.title, 'after');
  await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(upd) });
  assert.equal(mock.store.history[1].find((h) => h.content_id === 'H2')?.title, 'before');
});

test('composite plan across two domains undoes both resources', async () => {
  mock.store.library[1] = [];
  mock.store.history[1] = [];
  const out = await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_add_to_library',
        args: { profile_id: 1, items: [{ content_id: 'X', content_type: 'movie' }] },
      },
      {
        tool: 'nuvio_add_to_watch_history',
        args: { profile_id: 1, items: [{ content_id: 'X', content_type: 'movie' }] },
      },
    ])
  );
  const id = lastSnapshotId(out);
  const inspected = parse(await mcp.call('nuvio_inspect_snapshot', { snapshot_id: id }));
  assert.equal(inspected.resources.length, 2);
  assert.ok(
    inspected.resources.every((r) => r.scope !== undefined),
    'each resource carries its own scope'
  );
  await mcp.call('nuvio_undo', { snapshot_id: id });
  assert.equal(mock.store.library[1].length, 0);
  assert.equal(mock.store.history[1].length, 0);
});

// ---------------------------------------------------------------------------
// C. Partial write inside the first resource writer
// ---------------------------------------------------------------------------

test('a failure in the 2nd RPC of the first resource writer is not failed_before_apply', async () => {
  mock.store.library[1] = [{ content_id: 'keep', content_type: 'movie' }];
  reset();
  mock.failRpc('sync_push_library_items', 1); // delete (1st RPC) succeeds, upsert (2nd) fails
  const out = await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_remove_from_library',
        args: { profile_id: 1, keys: [{ content_id: 'keep', content_type: 'movie' }] },
      },
      {
        tool: 'nuvio_add_to_library',
        args: { profile_id: 1, items: [{ content_id: 'new', content_type: 'movie' }] },
      },
    ])
  );
  assert.doesNotMatch(out, /rejected before any write/);
  assert.match(out, /rolled back/);
  assert.ok(
    mock.store.library[1].some((i) => i.content_id === 'keep'),
    'rollback restored the deleted item'
  );
  assert.ok(!mock.store.library[1].some((i) => i.content_id === 'new'), 'failed upsert not applied');
});

test('a failed rollback after a partial write is reported as partially_applied', async () => {
  mock.store.library[1] = [{ content_id: 'keep2', content_type: 'movie' }];
  reset();
  mock.failRpc('sync_push_library_items', 2); // plan upsert + rollback upsert both fail
  const out = await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_remove_from_library',
        args: { profile_id: 1, keys: [{ content_id: 'keep2', content_type: 'movie' }] },
      },
      {
        tool: 'nuvio_add_to_library',
        args: { profile_id: 1, items: [{ content_id: 'new2', content_type: 'movie' }] },
      },
    ])
  );
  assert.match(out, /partially applied/);
  assert.match(out, /Rollback: attempted=true successful=false/);
});

test('snapshots disabled + partial write is not reported as failed_before_apply', async () => {
  mock.store.library[1] = [{ content_id: 'keep3', content_type: 'movie' }];
  reset();
  mock.failRpc('sync_push_library_items', 1);
  const out = await mcpNoSnap.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_remove_from_library',
        args: { profile_id: 1, keys: [{ content_id: 'keep3', content_type: 'movie' }] },
      },
      {
        tool: 'nuvio_add_to_library',
        args: { profile_id: 1, items: [{ content_id: 'new3', content_type: 'movie' }] },
      },
    ])
  );
  assert.doesNotMatch(out, /rejected before any write/);
  assert.match(out, /partially applied/);
});

// ---------------------------------------------------------------------------
// D. Optimistic concurrency
// ---------------------------------------------------------------------------

test('apply_plan does not overwrite a concurrent settings change', async () => {
  setSettings(1, 'tv', { features: { c: 'A' } });
  reset();
  // Simulate another client winning the race just before the guarded write.
  mock.once('sync_push_profile_settings_blob_guarded', () => {
    const row = mock.store.settings['1:tv'];
    row.updated_at = new Date(Date.now() + 60000).toISOString();
    row.settings_json = { features: { c: 'A', external: 'B' } };
  });
  const out = await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_update_settings',
        args: { profile_id: 1, platform: 'tv', patch: { features: { plan: 1 } } },
      },
    ])
  );
  assert.doesNotMatch(out, /rejected before any write/);
  assert.match(out, /partially applied|rolled back/);
  const row = mock.store.settings['1:tv'];
  assert.equal(row.settings_json.features.external, 'B', 'external change preserved');
  assert.equal(row.settings_json.features.plan, undefined, 'plan change not applied');
});

// ---------------------------------------------------------------------------
// E. copy_setup platform mappings
// ---------------------------------------------------------------------------

test('copy_setup: same-profile tv -> mobile merge', async () => {
  setSettings(1, 'tv', { features: { tvonly: 1 } });
  setSettings(1, 'mobile', { features: { mobileonly: 2 } });
  const out = await mcp.call('nuvio_copy_setup', {
    source_profile_id: 1,
    target_profile_id: 1,
    platforms: [{ from: 'tv', to: 'mobile' }],
    settings_mode: 'merge',
  });
  assert.match(out, /Applied/);
  assert.deepEqual(mock.store.settings['1:mobile'].settings_json.features, { mobileonly: 2, tvonly: 1 });
});

test('copy_setup: cross-profile tv -> mobile replace', async () => {
  setSettings(1, 'tv', { features: { a: 1 } });
  setSettings(2, 'mobile', { features: { b: 2 } });
  await mcp.call('nuvio_copy_setup', {
    source_profile_id: 1,
    target_profile_id: 2,
    platforms: [{ from: 'tv', to: 'mobile' }],
    settings_mode: 'replace',
  });
  assert.deepEqual(mock.store.settings['2:mobile'].settings_json.features, { a: 1 });
});

test('copy_setup: multiple mappings use the original source state', async () => {
  setSettings(1, 'tv', { features: { tvonly: 1 } });
  setSettings(1, 'mobile', { features: { mobileonly: 2 } });
  setSettings(1, 'desktop', { features: {} });
  await mcp.call('nuvio_copy_setup', {
    source_profile_id: 1,
    target_profile_id: 1,
    platforms: [
      { from: 'tv', to: 'mobile' },
      { from: 'mobile', to: 'desktop' },
    ],
    settings_mode: 'merge',
  });
  assert.deepEqual(mock.store.settings['1:desktop'].settings_json.features, { mobileonly: 2 });
  assert.equal(
    mock.store.settings['1:desktop'].settings_json.features.tvonly,
    undefined,
    'desktop must not see tv'
  );
});

test('copy_setup: identity mapping on the same profile is a no-op', async () => {
  setSettings(1, 'tv', { features: { z: 1 } });
  const out = await mcp.call('nuvio_copy_setup', {
    source_profile_id: 1,
    target_profile_id: 1,
    platforms: [{ from: 'tv', to: 'tv' }],
  });
  assert.match(out, /No changes required/);
});

test('deprecated copy_settings still works (tv -> mobile)', async () => {
  setSettings(1, 'tv', { features: { legacy: 1 } });
  const out = await mcp.call('nuvio_copy_settings', {
    from_profile_id: 1,
    from_platform: 'tv',
    to_profile_id: 1,
    to_platform: 'mobile',
  });
  assert.match(out, /Applied/);
  assert.equal(mock.store.settings['1:mobile'].settings_json.features.legacy, 1);
});

// ---------------------------------------------------------------------------
// F. Delete beyond the first page (>1000)
// ---------------------------------------------------------------------------

test('delete library item #1001', async () => {
  mock.store.library[1] = Array.from({ length: 1001 }, (_, i) => ({
    content_id: `lib-${i}`,
    content_type: 'movie',
  }));
  const out = await mcp.call('nuvio_remove_from_library', {
    profile_id: 1,
    keys: [{ content_id: 'lib-1000', content_type: 'movie' }],
    confirm: true,
  });
  assert.match(out, /Applied/);
  assert.ok(!mock.store.library[1].some((i) => i.content_id === 'lib-1000'));
  assert.equal(mock.store.library[1].length, 1000);
});

test('delete history item #1001', async () => {
  mock.store.history[1] = Array.from({ length: 1001 }, (_, i) => ({
    content_id: `h-${i}`,
    content_type: 'movie',
  }));
  await mcp.call('nuvio_delete_watch_history', {
    profile_id: 1,
    keys: [{ content_id: 'h-1000' }],
    confirm: true,
  });
  assert.ok(!mock.store.history[1].some((h) => h.content_id === 'h-1000'));
});

test('delete progress beyond the first batch', async () => {
  mock.store.progress[1] = Array.from({ length: 1001 }, (_, i) => ({
    content_id: `p-${i}`,
    content_type: 'movie',
    position: 1,
    duration: 10,
    progress_key: `p-${i}`,
  }));
  await mcp.call('nuvio_delete_watch_progress', {
    profile_id: 1,
    keys: [{ content_id: 'p-1000' }],
    confirm: true,
  });
  assert.ok(!mock.store.progress[1].some((p) => p.content_id === 'p-1000'));
});

test('delete is sent for a key the read never returned (not gated on presence)', async () => {
  mock.store.progress[1] = [
    { content_id: 'existing', content_type: 'movie', position: 1, duration: 5, progress_key: 'existing' },
  ];
  reset();
  const out = await mcp.call('nuvio_delete_watch_progress', {
    profile_id: 1,
    keys: [{ content_id: 'never-seen' }],
    confirm: true,
  });
  assert.match(out, /Applied/);
  assert.equal(calls('sync_delete_watch_progress'), 1, 'delete RPC must be sent regardless of the read');
  assert.ok(
    mock.store.progress[1].some((p) => p.content_id === 'existing'),
    'unrelated record intact'
  );
});

test('undo of a >1000 delete restores the record without touching others', async () => {
  mock.store.library[1] = Array.from({ length: 1001 }, (_, i) => ({
    content_id: `u-${i}`,
    content_type: 'movie',
  }));
  const out = await mcp.call('nuvio_remove_from_library', {
    profile_id: 1,
    keys: [{ content_id: 'u-1000', content_type: 'movie' }],
    confirm: true,
  });
  await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(out) });
  assert.ok(mock.store.library[1].some((i) => i.content_id === 'u-1000'));
  assert.equal(mock.store.library[1].length, 1001);
});

// ---------------------------------------------------------------------------
// G. Backup export is a retry-safe read
// ---------------------------------------------------------------------------

test('backup export retries a transient 503', async () => {
  reset();
  mock.failRpc('sync_export_account_backup', 1);
  const out = parse(await mcp.call('nuvio_export_backup', {}));
  assert.equal(out.version, 1);
  assert.equal(calls('sync_export_account_backup'), 2, 'the read was retried');
});

// ---------------------------------------------------------------------------
// H. prune confirmation semantics
// ---------------------------------------------------------------------------

async function makeSomeSnapshots(n) {
  const tag = Date.now();
  for (let i = 0; i < n; i += 1) {
    await mcp.call('nuvio_update_settings', {
      profile_id: 1,
      platform: 'tv',
      patch: { features: { [`s${tag}-${i}`]: i } },
    });
  }
}

test('nuvio_prune_snapshots: previews without confirm', async () => {
  await makeSomeSnapshots(4);
  const before = snapCount();
  const out = await mcp.call('nuvio_prune_snapshots', { older_than_days: 0, max_total_bytes: 1 });
  assert.match(out, /Preview|nothing was removed/);
  assert.equal(snapCount(), before);
});

test('nuvio_prune_snapshots: confirm=true deletes', async () => {
  const before = snapCount();
  const out = await mcp.call('nuvio_prune_snapshots', {
    older_than_days: 0,
    max_total_bytes: 1,
    confirm: true,
  });
  assert.match(out, /Applied/);
  assert.ok(snapCount() < before);
});

test('nuvio_prune_snapshots: dry_run=true overrides confirm', async () => {
  await makeSomeSnapshots(3);
  const before = snapCount();
  const out = await mcp.call('nuvio_prune_snapshots', {
    older_than_days: 0,
    max_total_bytes: 1,
    confirm: true,
    dry_run: true,
  });
  assert.match(out, /Preview|nothing was removed/);
  assert.equal(snapCount(), before);
});

// ---------------------------------------------------------------------------
// I. Audit for rolled_back / partially_applied
// ---------------------------------------------------------------------------

function auditEntries() {
  try {
    return readFileSync(join(mcp.dir, 'audit.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

test('audit records applied, rolled_back and partially_applied plans', async () => {
  // applied
  await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_update_settings',
        args: { profile_id: 1, platform: 'tv', patch: { features: { aud: 1 } } },
      },
    ])
  );
  // rolled_back (2nd RPC of library writer fails)
  mock.store.library[1] = [{ content_id: 'a1', content_type: 'movie' }];
  reset();
  mock.failRpc('sync_push_library_items', 1);
  await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_remove_from_library',
        args: { profile_id: 1, keys: [{ content_id: 'a1', content_type: 'movie' }] },
      },
      {
        tool: 'nuvio_add_to_library',
        args: { profile_id: 1, items: [{ content_id: 'a2', content_type: 'movie' }] },
      },
    ])
  );
  // partially_applied (rollback also fails)
  mock.store.library[1] = [{ content_id: 'b1', content_type: 'movie' }];
  reset();
  mock.failRpc('sync_push_library_items', 2);
  await mcp.call(
    'nuvio_apply_plan',
    validPlan([
      {
        tool: 'nuvio_remove_from_library',
        args: { profile_id: 1, keys: [{ content_id: 'b1', content_type: 'movie' }] },
      },
      {
        tool: 'nuvio_add_to_library',
        args: { profile_id: 1, items: [{ content_id: 'b2', content_type: 'movie' }] },
      },
    ])
  );

  const statuses = auditEntries()
    .filter((e) => e.tool === 'nuvio_apply_plan')
    .map((e) => e.status);
  assert.ok(statuses.includes('applied'), `applied missing: ${statuses}`);
  assert.ok(statuses.includes('rolled_back'), `rolled_back missing: ${statuses}`);
  assert.ok(statuses.includes('partially_applied'), `partially_applied missing: ${statuses}`);
});
