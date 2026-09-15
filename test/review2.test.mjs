import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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

const calls = (name) => mock.stats()[name] ?? 0;
const reset = () => {
  mock.resetStats();
  mock.clearFailures();
  mock.clearHooks();
};
const plan = (operations, dry = false) => ({ operations, dry_run: dry });

// ---------------------------------------------------------------------------
// 1. redo must preserve scope
// ---------------------------------------------------------------------------

for (const [label, seed, delOp, store] of [
  [
    'library',
    () => [{ content_id: 'R', content_type: 'movie', name: 'x' }],
    {
      tool: 'nuvio_remove_from_library',
      args: { profile_id: 1, keys: [{ content_id: 'R', content_type: 'movie' }] },
    },
    'library',
  ],
  [
    'watch progress',
    () => [{ content_id: 'R', content_type: 'movie', position: 1, duration: 9, progress_key: 'R' }],
    { tool: 'nuvio_delete_watch_progress', args: { profile_id: 1, keys: [{ content_id: 'R' }] } },
    'progress',
  ],
  [
    'watch history',
    () => [{ content_id: 'R', content_type: 'movie', title: 'x' }],
    { tool: 'nuvio_delete_watch_history', args: { profile_id: 1, keys: [{ content_id: 'R' }] } },
    'history',
  ],
]) {
  test(`redo preserves scope: ${label} delete -> undo -> redo`, async () => {
    mock.store[store][1] = seed();
    const applied = await mcp.call('nuvio_apply_plan', plan([delOp]));
    assert.equal(mock.store[store][1].length, 0, 'plan deleted the record');
    await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(applied) });
    assert.equal(mock.store[store][1].length, 1, 'undo restored the record');
    await mcp.call('nuvio_redo');
    assert.equal(mock.store[store][1].length, 0, 'redo deleted it again');
  });
}

test('redo preserves scope for a composite delete across two domains', async () => {
  mock.store.library[1] = [{ content_id: 'C', content_type: 'movie' }];
  mock.store.history[1] = [{ content_id: 'C', content_type: 'movie' }];
  const del = await mcp.call(
    'nuvio_apply_plan',
    plan([
      {
        tool: 'nuvio_remove_from_library',
        args: { profile_id: 1, keys: [{ content_id: 'C', content_type: 'movie' }] },
      },
      { tool: 'nuvio_delete_watch_history', args: { profile_id: 1, keys: [{ content_id: 'C' }] } },
    ])
  );
  await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(del) });
  assert.equal(mock.store.library[1].length, 1);
  assert.equal(mock.store.history[1].length, 1);
  await mcp.call('nuvio_redo');
  assert.equal(mock.store.library[1].length, 0, 'redo reapplied library delete');
  assert.equal(mock.store.history[1].length, 0, 'redo reapplied history delete');
});

// ---------------------------------------------------------------------------
// 2. scoped undo must not overwrite unrelated records
// ---------------------------------------------------------------------------

for (const [label, store, key, mutateA] of [
  ['library', 'library', (r) => r.content_id, () => [{ content_id: 'A', content_type: 'movie', name: 'A0' }]],
  [
    'watch progress',
    'progress',
    (r) => r.content_id,
    () => [{ content_id: 'A', content_type: 'movie', position: 1, duration: 9, progress_key: 'A' }],
  ],
  [
    'watch history',
    'history',
    (r) => r.content_id,
    () => [{ content_id: 'A', content_type: 'movie', title: 'A0' }],
  ],
]) {
  test(`scoped undo does not overwrite a later change to an unrelated record: ${label}`, async () => {
    // Snapshot A (add), then an independent change to B, then undo A.
    mock.store[store][1] = [];
    const addA =
      store === 'library'
        ? { tool: 'nuvio_add_to_library', args: { profile_id: 1, items: mutateA() } }
        : store === 'progress'
          ? { tool: 'nuvio_set_watch_progress', args: { profile_id: 1, entries: mutateA() } }
          : { tool: 'nuvio_add_to_watch_history', args: { profile_id: 1, items: mutateA() } };
    const snap = await mcp.call('nuvio_apply_plan', plan([addA]));
    // Independent change to B.
    if (store === 'library') {
      await mcp.call('nuvio_add_to_library', {
        profile_id: 1,
        items: [{ content_id: 'B', content_type: 'movie', name: 'B-new' }],
      });
    } else if (store === 'progress') {
      await mcp.call('nuvio_set_watch_progress', {
        profile_id: 1,
        entries: [{ content_id: 'B', content_type: 'movie', position: 7, duration: 9, progress_key: 'B' }],
      });
    } else {
      await mcp.call('nuvio_add_to_watch_history', {
        profile_id: 1,
        items: [{ content_id: 'B', content_type: 'movie', title: 'B-new' }],
      });
    }
    await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(snap) });
    assert.ok(!mock.store[store][1].some((r) => key(r) === 'A'), 'A removed by undo');
    const b = mock.store[store][1].find((r) => key(r) === 'B');
    assert.ok(b, 'B still present');
    const bValue = b.name ?? b.title ?? b.position;
    assert.ok(bValue === 'B-new' || bValue === 7, `B kept its new value, got ${bValue}`);
  });
}

// ---------------------------------------------------------------------------
// 3. ambiguous writes (applied, then response fails)
// ---------------------------------------------------------------------------

test('single RPC applies then fails: not failed_before_apply, rollback attempted', async () => {
  mock.store.settings['1:tv'] = {
    settings_json: { features: { amb: 'orig' } },
    updated_at: new Date().toISOString(),
  };
  reset();
  mock.failAfterApply('sync_push_profile_settings_blob_guarded', 1);
  const out = await mcp.call(
    'nuvio_apply_plan',
    plan([
      {
        tool: 'nuvio_update_settings',
        args: { profile_id: 1, platform: 'tv', patch: { features: { amb: 'plan' } } },
      },
    ])
  );
  assert.doesNotMatch(out, /rejected before any write/);
  assert.match(out, /rolled back|partially applied/);
  assert.equal(mock.store.settings['1:tv'].settings_json.features.amb, 'orig', 'ambiguous write rolled back');
});

test('first RPC applies-then-fails inside a multi-RPC writer', async () => {
  mock.store.library[1] = [{ content_id: 'M', content_type: 'movie' }];
  reset();
  mock.failAfterApply('sync_delete_library_items', 1);
  const out = await mcp.call(
    'nuvio_apply_plan',
    plan([
      {
        tool: 'nuvio_remove_from_library',
        args: { profile_id: 1, keys: [{ content_id: 'M', content_type: 'movie' }] },
      },
      {
        tool: 'nuvio_add_to_library',
        args: { profile_id: 1, items: [{ content_id: 'M2', content_type: 'movie' }] },
      },
    ])
  );
  assert.doesNotMatch(out, /rejected before any write/);
  assert.ok(
    mock.store.library[1].some((i) => i.content_id === 'M'),
    'rollback restored M'
  );
});

test('second RPC applies-then-fails inside a multi-RPC writer', async () => {
  mock.store.library[1] = [{ content_id: 'N', content_type: 'movie' }];
  reset();
  mock.failAfterApply('sync_push_library_items', 1);
  const out = await mcp.call(
    'nuvio_apply_plan',
    plan([
      {
        tool: 'nuvio_remove_from_library',
        args: { profile_id: 1, keys: [{ content_id: 'N', content_type: 'movie' }] },
      },
      {
        tool: 'nuvio_add_to_library',
        args: { profile_id: 1, items: [{ content_id: 'N2', content_type: 'movie' }] },
      },
    ])
  );
  assert.doesNotMatch(out, /rejected before any write/);
  assert.ok(
    mock.store.library[1].some((i) => i.content_id === 'N'),
    'delete rolled back'
  );
  assert.ok(!mock.store.library[1].some((i) => i.content_id === 'N2'), 'failed upsert removed');
});

test('failed rollback after ambiguous write → partially_applied', async () => {
  mock.store.library[1] = [{ content_id: 'O', content_type: 'movie' }];
  reset();
  mock.failAfterApply('sync_push_library_items', 2);
  const out = await mcp.call(
    'nuvio_apply_plan',
    plan([
      {
        tool: 'nuvio_remove_from_library',
        args: { profile_id: 1, keys: [{ content_id: 'O', content_type: 'movie' }] },
      },
      {
        tool: 'nuvio_add_to_library',
        args: { profile_id: 1, items: [{ content_id: 'O2', content_type: 'movie' }] },
      },
    ])
  );
  assert.match(out, /partially applied/);
});

test('snapshots disabled + ambiguous write is not failed_before_apply', async () => {
  mock.store.library[1] = [{ content_id: 'P', content_type: 'movie' }];
  reset();
  mock.failAfterApply('sync_push_library_items', 1);
  const out = await mcpNoSnap.call(
    'nuvio_apply_plan',
    plan([
      {
        tool: 'nuvio_remove_from_library',
        args: { profile_id: 1, keys: [{ content_id: 'P', content_type: 'movie' }] },
      },
      {
        tool: 'nuvio_add_to_library',
        args: { profile_id: 1, items: [{ content_id: 'P2', content_type: 'movie' }] },
      },
    ])
  );
  assert.doesNotMatch(out, /rejected before any write/);
  assert.match(out, /partially applied/);
});

test('dropped response after apply is treated as ambiguous', async () => {
  mock.store.settings['1:tv'] = {
    settings_json: { features: { drop: 'orig' } },
    updated_at: new Date().toISOString(),
  };
  reset();
  mock.dropResponseAfterApply('sync_push_profile_settings_blob_guarded', 1);
  const out = await mcp.call(
    'nuvio_apply_plan',
    plan([
      {
        tool: 'nuvio_update_settings',
        args: { profile_id: 1, platform: 'tv', patch: { features: { drop: 'plan' } } },
      },
    ])
  );
  assert.doesNotMatch(out, /rejected before any write/);
});

// ---------------------------------------------------------------------------
// 4. settings rollback must not clobber a later concurrent change
// ---------------------------------------------------------------------------

test('settings rollback conflict preserves the external concurrent version', async () => {
  mock.store.settings['1:tv'] = {
    settings_json: { features: { race: 'A' } },
    updated_at: new Date().toISOString(),
  };
  mock.store.home['1:tv'] = { settings_json: { row: 0 }, updated_at: new Date().toISOString() };
  reset();
  // While the plan writes home (which then fails), an external client updates settings.
  mock.once('sync_push_home_catalog_settings', () => {
    mock.store.settings['1:tv'] = {
      settings_json: { features: { race: 'A', external: 'C' } },
      updated_at: new Date(Date.now() + 120000).toISOString(),
    };
  });
  mock.failRpc('sync_push_home_catalog_settings', 1);
  const out = await mcp.call(
    'nuvio_apply_plan',
    plan([
      {
        tool: 'nuvio_update_settings',
        args: { profile_id: 1, platform: 'tv', patch: { features: { race: 'plan' } } },
      },
      {
        tool: 'nuvio_update_home_catalog_settings',
        args: { profile_id: 1, platform: 'tv', patch: { row: 5 } },
      },
    ])
  );
  assert.match(out, /partially applied/);
  const stored = mock.store.settings['1:tv'].settings_json.features;
  assert.equal(stored.external, 'C', 'external change preserved');
  assert.equal(stored.race, 'A', 'plan change not left applied');
});

// ---------------------------------------------------------------------------
// 5. direct vs plan equivalence
// ---------------------------------------------------------------------------

function clearDomain(store) {
  mock.store[store][1] = [];
  mock.store[store][2] = [];
}

async function equivalence(directTool, baseArgs, storeKey, getter) {
  await mcp.call(directTool, { ...baseArgs, profile_id: 1, confirm: true });
  await mcp.call('nuvio_apply_plan', plan([{ tool: directTool, args: { ...baseArgs, profile_id: 2 } }]));
  assert.deepEqual(
    getter(mock.store[storeKey][1]),
    getter(mock.store[storeKey][2]),
    `${directTool} equivalence`
  );
}

test('equivalence: settings patch / set / unset', async () => {
  for (const edit of [
    { patch: { features: { a: 1, b: 2 } } },
    { set: [{ path: 'features.c', value: 3 }] },
    { unset: ['features.a'] },
  ]) {
    mock.store.settings['1:tv'] = { settings_json: { features: { a: 9, b: 9 } }, updated_at: null };
    mock.store.settings['2:tv'] = { settings_json: { features: { a: 9, b: 9 } }, updated_at: null };
    await mcp.call('nuvio_update_settings', { profile_id: 1, platform: 'tv', ...edit });
    await mcp.call(
      'nuvio_apply_plan',
      plan([{ tool: 'nuvio_update_settings', args: { profile_id: 2, platform: 'tv', ...edit } }])
    );
    assert.deepEqual(mock.store.settings['1:tv'].settings_json, mock.store.settings['2:tv'].settings_json);
  }
});

test('equivalence: addons add / update / reorder / remove', async () => {
  const seed = () => [{ url: 'https://a.example/m.json', name: 'A', enabled: true, sort_order: 0 }];
  mock.store.addons[1] = seed();
  mock.store.addons[2] = seed();
  await mcp.call('nuvio_add_addon', { profile_id: 1, url: 'https://b.example/m.json', name: 'B' });
  await mcp.call(
    'nuvio_apply_plan',
    plan([{ tool: 'nuvio_add_addon', args: { profile_id: 2, url: 'https://b.example/m.json', name: 'B' } }])
  );
  assert.deepEqual(mock.store.addons[1], mock.store.addons[2]);

  await mcp.call('nuvio_update_addon', { profile_id: 1, url: 'https://b.example/m.json', enabled: false });
  await mcp.call(
    'nuvio_apply_plan',
    plan([
      {
        tool: 'nuvio_update_addon',
        args: { profile_id: 2, url: 'https://b.example/m.json', enabled: false },
      },
    ])
  );
  assert.deepEqual(mock.store.addons[1], mock.store.addons[2]);

  const order = ['https://b.example/m.json', 'https://a.example/m.json'];
  await mcp.call('nuvio_reorder_addons', { profile_id: 1, ordered_urls: order });
  await mcp.call(
    'nuvio_apply_plan',
    plan([{ tool: 'nuvio_reorder_addons', args: { profile_id: 2, ordered_urls: order } }])
  );
  assert.deepEqual(mock.store.addons[1], mock.store.addons[2]);

  await mcp.call('nuvio_remove_addon', { profile_id: 1, url: 'https://b.example/m.json', confirm: true });
  await mcp.call(
    'nuvio_apply_plan',
    plan([{ tool: 'nuvio_remove_addon', args: { profile_id: 2, url: 'https://b.example/m.json' } }])
  );
  assert.deepEqual(mock.store.addons[1], mock.store.addons[2]);
});

test('equivalence: providers set / delete', async () => {
  mock.store.providers[1] = [];
  mock.store.providers[2] = [];
  await mcp.call('nuvio_set_provider_credential', { profile_id: 1, provider: 'tmdb', api_key: 'abcdef1234' });
  await mcp.call(
    'nuvio_apply_plan',
    plan([
      {
        tool: 'nuvio_set_provider_credential',
        args: { profile_id: 2, provider: 'tmdb', api_key: 'abcdef1234' },
      },
    ])
  );
  assert.deepEqual(
    mock.store.providers[1].map((p) => [p.provider, p.credential_json]),
    mock.store.providers[2].map((p) => [p.provider, p.credential_json])
  );
});

test('equivalence: library add / remove', async () => {
  clearDomain('library');
  await equivalence(
    'nuvio_add_to_library',
    { items: [{ content_id: 'L', content_type: 'movie', name: 'n', added_at: 5 }] },
    'library',
    (r) => r
  );
  await equivalence(
    'nuvio_remove_from_library',
    { keys: [{ content_id: 'L', content_type: 'movie' }] },
    'library',
    (r) => r
  );
});

test('equivalence: progress set / delete', async () => {
  clearDomain('progress');
  await equivalence(
    'nuvio_set_watch_progress',
    { entries: [{ content_id: 'P', content_type: 'movie', position: 3, duration: 30, last_watched: 7 }] },
    'progress',
    (r) => r
  );
  await equivalence('nuvio_delete_watch_progress', { keys: [{ content_id: 'P' }] }, 'progress', (r) => r);
});

test('equivalence: history add / delete', async () => {
  clearDomain('history');
  await equivalence(
    'nuvio_add_to_watch_history',
    { items: [{ content_id: 'H', content_type: 'movie', title: 't', watched_at: 7 }] },
    'history',
    (r) => r
  );
  await equivalence('nuvio_delete_watch_history', { keys: [{ content_id: 'H' }] }, 'history', (r) => r);
});

test('equivalence: progress season-without-episode shares the same key', async () => {
  clearDomain('progress');
  const entry = {
    content_id: 'S',
    content_type: 'movie',
    season: 2,
    position: 1,
    duration: 2,
    last_watched: 1,
  };
  await mcp.call('nuvio_set_watch_progress', { profile_id: 1, entries: [entry] });
  await mcp.call(
    'nuvio_apply_plan',
    plan([{ tool: 'nuvio_set_watch_progress', args: { profile_id: 2, entries: [entry] } }])
  );
  assert.equal(mock.store.progress[1][0].progress_key, 'S_s2e0');
  assert.deepEqual(mock.store.progress[1], mock.store.progress[2]);
  await mcp.call('nuvio_delete_watch_progress', {
    profile_id: 1,
    keys: [{ content_id: 'S', season: 2 }],
    confirm: true,
  });
  assert.equal(mock.store.progress[1].length, 0);
});

test('empty settings edit is rejected by direct and plan', async () => {
  const direct = await mcp.call('nuvio_update_settings', { profile_id: 1, platform: 'tv' });
  assert.match(direct, /patch|set|unset|Provide at least one/i);
  const planned = await mcp.call(
    'nuvio_apply_plan',
    plan([{ tool: 'nuvio_update_settings', args: { profile_id: 1, platform: 'tv' } }])
  );
  assert.match(planned, /rejected before any write/);
});

test('empty content_id / content_type are rejected by direct and plan', async () => {
  for (const [tool, args] of [
    ['nuvio_add_to_library', { profile_id: 1, items: [{ content_id: '', content_type: 'movie' }] }],
    ['nuvio_add_to_library', { profile_id: 1, items: [{ content_id: 'x', content_type: '' }] }],
  ]) {
    const direct = await mcp.call(tool, args);
    assert.match(direct, /Invalid|expected|too_small|at least/i);
    const planned = await mcp.call('nuvio_apply_plan', plan([{ tool, args: { ...args, profile_id: 1 } }]));
    assert.match(planned, /rejected before any write/);
  }
});

// ---------------------------------------------------------------------------
// M1: addon update/remove by id is equivalent in direct and plan
// ---------------------------------------------------------------------------

test('equivalence: addon update/remove by table id', async () => {
  mock.store.addons[1] = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      url: 'https://a.example/m.json',
      name: 'A',
      enabled: true,
      sort_order: 0,
    },
  ];
  mock.store.addons[2] = [
    {
      id: '22222222-2222-4222-8222-222222222222',
      url: 'https://a.example/m.json',
      name: 'A',
      enabled: true,
      sort_order: 0,
    },
  ];
  await mcp.call('nuvio_update_addon', {
    profile_id: 1,
    id: '11111111-1111-4111-8111-111111111111',
    name: 'A2',
    enabled: false,
  });
  const planned = await mcp.call(
    'nuvio_apply_plan',
    plan([
      {
        tool: 'nuvio_update_addon',
        args: { profile_id: 2, id: '22222222-2222-4222-8222-222222222222', name: 'A2', enabled: false },
      },
    ])
  );
  assert.match(planned, /Plan applied/);
  assert.deepEqual(
    mock.store.addons[1].map((a) => [a.url, a.name, a.enabled]),
    mock.store.addons[2].map((a) => [a.url, a.name, a.enabled])
  );

  await mcp.call('nuvio_remove_addon', {
    profile_id: 1,
    id: '11111111-1111-4111-8111-111111111111',
    confirm: true,
  });
  const plannedRemove = await mcp.call(
    'nuvio_apply_plan',
    plan([
      { tool: 'nuvio_remove_addon', args: { profile_id: 2, id: '22222222-2222-4222-8222-222222222222' } },
    ])
  );
  assert.match(plannedRemove, /Plan applied/);
  assert.equal(mock.store.addons[1].length, 0);
  assert.equal(mock.store.addons[2].length, 0);
});

// ---------------------------------------------------------------------------
// M2/M3: rollback must not clobber a concurrent change to a completed resource
// ---------------------------------------------------------------------------

test('rollback skips a resource changed concurrently after the plan wrote it', async () => {
  mock.store.addons[1] = [];
  mock.store.home['1:tv'] = { settings_json: { row: 0 }, updated_at: new Date().toISOString() };
  reset();
  // While the home write is attempted, an external client changes addons.
  mock.once('sync_push_home_catalog_settings', () => {
    mock.store.addons[1].push({
      url: 'https://foreign.example/m.json',
      name: 'Foreign',
      enabled: true,
      sort_order: 99,
    });
  });
  mock.failRpc('sync_push_home_catalog_settings', 1);
  const out = await mcp.call(
    'nuvio_apply_plan',
    plan([
      { tool: 'nuvio_add_addon', args: { profile_id: 1, url: 'https://plan.example/m.json', name: 'Plan' } },
      {
        tool: 'nuvio_update_home_catalog_settings',
        args: { profile_id: 1, platform: 'tv', patch: { row: 5 } },
      },
    ])
  );
  assert.match(out, /partially applied/);
  assert.ok(
    mock.store.addons[1].some((a) => a.url === 'https://foreign.example/m.json'),
    'concurrent addon change preserved'
  );
});

// ---------------------------------------------------------------------------
// 6. pagination completeness + safety limit
// ---------------------------------------------------------------------------

test('history 2500 rows: every page is read; delete #2001 + undo', async () => {
  mock.store.history[1] = Array.from({ length: 2500 }, (_, i) => ({
    content_id: `h${i}`,
    content_type: 'movie',
  }));
  const out = await mcp.call('nuvio_delete_watch_history', {
    profile_id: 1,
    keys: [{ content_id: 'h2000' }],
    confirm: true,
  });
  assert.match(out, /Applied/);
  assert.ok(!mock.store.history[1].some((h) => h.content_id === 'h2000'));
  await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(out) });
  assert.ok(mock.store.history[1].some((h) => h.content_id === 'h2000'));
  assert.equal(mock.store.history[1].length, 2500);
});

test('library 2500 rows: every page is read; delete #2001 + undo', async () => {
  mock.store.library[1] = Array.from({ length: 2500 }, (_, i) => ({
    content_id: `l${i}`,
    content_type: 'movie',
  }));
  const out = await mcp.call('nuvio_remove_from_library', {
    profile_id: 1,
    keys: [{ content_id: 'l2000', content_type: 'movie' }],
    confirm: true,
  });
  assert.ok(!mock.store.library[1].some((i) => i.content_id === 'l2000'));
  await mcp.call('nuvio_undo', { snapshot_id: lastSnapshotId(out) });
  assert.equal(mock.store.library[1].length, 2500);
});

test('progress at the safety limit refuses a reversible mutation before writing', async () => {
  mock.store.progress[1] = Array.from({ length: 20000 }, (_, i) => ({
    content_id: `p${i}`,
    content_type: 'movie',
    position: 1,
    duration: 2,
    progress_key: `p${i}`,
  }));
  reset();
  const out = await mcp.call('nuvio_set_watch_progress', {
    profile_id: 1,
    entries: [{ content_id: 'new', content_type: 'movie', position: 1, duration: 2 }],
  });
  assert.match(out, /complete reversible snapshot|truncated|safety/i);
  assert.equal(calls('sync_push_watch_progress'), 0, 'no write before refusing');
});

// ---------------------------------------------------------------------------
// 7. copy_setup transactional rollback
// ---------------------------------------------------------------------------

test('copy_setup rolls back when a later platform write fails', async () => {
  mock.store.settings['1:tv'] = { settings_json: { features: { src: 1 } }, updated_at: null };
  mock.store.settings['2:mobile'] = {
    settings_json: { features: { keep: 1 } },
    updated_at: new Date().toISOString(),
  };
  mock.store.settings['2:desktop'] = {
    settings_json: { features: { keep: 2 } },
    updated_at: new Date().toISOString(),
  };
  reset();
  mock.failRpc('sync_push_profile_settings_blob_guarded', 1); // second platform write fails
  const out = await mcp.call('nuvio_copy_setup', {
    source_profile_id: 1,
    target_profile_id: 2,
    platforms: [
      { from: 'tv', to: 'mobile' },
      { from: 'tv', to: 'desktop' },
    ],
    settings_mode: 'merge',
  });
  assert.match(out, /rolled back|partially/i);
  assert.deepEqual(mock.store.settings['2:mobile'].settings_json.features, { keep: 1 }, 'mobile rolled back');
  assert.deepEqual(mock.store.settings['2:desktop'].settings_json.features, { keep: 2 }, 'desktop untouched');
});

test('copy_setup rolls back credentials when the credential push fails', async () => {
  mock.store.settings['1:tv'] = { settings_json: { features: { s: 1 } }, updated_at: null };
  mock.store.settings['2:tv'] = { settings_json: { features: {} }, updated_at: new Date().toISOString() };
  mock.store.providers[1] = [{ provider: 'tmdb', credential_json: { api_key: 'src' } }];
  mock.store.providers[2] = [];
  reset();
  mock.failRpc('sync_push_provider_credentials', 1);
  const out = await mcp.call('nuvio_copy_setup', {
    source_profile_id: 1,
    target_profile_id: 2,
    platforms: [{ from: 'tv', to: 'tv' }],
    provider_credentials: 'merge',
  });
  assert.match(out, /rolled back|partially/i);
  assert.equal(mock.store.providers[2].length, 0, 'credential push rolled back');
});

test('copy_setup failed rollback is reported as partially applied', async () => {
  mock.store.settings['1:tv'] = { settings_json: { features: { s: 1 } }, updated_at: null };
  mock.store.settings['2:mobile'] = {
    settings_json: { features: { keep: 1 } },
    updated_at: new Date().toISOString(),
  };
  mock.store.settings['2:desktop'] = {
    settings_json: { features: { keep: 2 } },
    updated_at: new Date().toISOString(),
  };
  reset();
  // Call #1 (mobile) succeeds; before call #2 (desktop) an external client changes
  // mobile, so the mobile rollback (call #3) conflicts. Desktop write fails.
  mock.onCall('sync_push_profile_settings_blob_guarded', 2, () => {
    mock.store.settings['2:mobile'].updated_at = new Date(Date.now() + 120000).toISOString();
  });
  mock.failOnCall('sync_push_profile_settings_blob_guarded', 2);
  const out = await mcp.call('nuvio_copy_setup', {
    source_profile_id: 1,
    target_profile_id: 2,
    platforms: [
      { from: 'tv', to: 'mobile' },
      { from: 'tv', to: 'desktop' },
    ],
  });
  assert.match(out, /partially applied|rollback was incomplete/i);
});
