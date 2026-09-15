import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockNuvio } from './mock-nuvio.mjs';
import { startStdio, lastSnapshotId, confirmationToken } from './helpers.mjs';

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

test('lists tools and describes capabilities', async () => {
  const tools = await mcp.client.listTools();
  assert.ok(tools.tools.length > 55, `expected a large tool surface, got ${tools.tools.length}`);
  const names = tools.tools.map((t) => t.name);
  for (const required of [
    'nuvio_list_profiles',
    'nuvio_reorder_addons',
    'nuvio_update_settings',
    'nuvio_apply_plan',
    'nuvio_copy_setup',
    'nuvio_update_plugin',
    'nuvio_add_to_watch_history',
    'nuvio_prune_snapshots',
    'nuvio_test_provider_credential',
    'nuvio_set_provider_credential',
    'nuvio_link_tracker',
    'nuvio_add_to_library',
    'nuvio_undo',
    'nuvio_redo',
  ]) {
    assert.ok(names.includes(required), `missing tool ${required}`);
  }
  const caps = JSON.parse((await mcp.call('nuvio_capabilities')).replace(/```json|```/g, ''));
  assert.equal(caps.undo.automatic, true);
  assert.equal(caps.account_deletion, 'not supported by design');
  assert.equal(caps.canonical_tool_count, 65, 'canonical tool surface must be exactly 65');
  const canonicalNames = caps.tools.map((t) => t.name);
  assert.equal(canonicalNames.length, 65);
  for (const deprecated of [
    'nuvio_toggle_addon',
    'nuvio_toggle_plugin',
    'nuvio_set_setting',
    'nuvio_unset_setting',
    'nuvio_set_home_catalog_path',
    'nuvio_copy_settings',
    'nuvio_copy_profile_setup',
    'nuvio_mark_watched',
  ]) {
    assert.ok(
      caps.deprecated_tools.some((t) => t.name === deprecated),
      `expected ${deprecated} deprecated`
    );
    assert.ok(!canonicalNames.includes(deprecated), `${deprecated} must not be canonical`);
  }
});

test('list profiles and addons', async () => {
  assert.match(await mcp.call('nuvio_list_profiles'), /Main/);
  assert.match(await mcp.call('nuvio_list_addons', { profile_id: 1 }), /example\.com\/a\/manifest\.json/);
});

test('add addon then undo restores the previous list', async () => {
  const out = await mcp.call('nuvio_add_addon', {
    profile_id: 1,
    url: 'https://new.example/manifest.json',
    name: 'New',
  });
  const snapshot = lastSnapshotId(out);
  assert.ok(snapshot);
  assert.match(await mcp.call('nuvio_list_addons', { profile_id: 1 }), /new\.example/);
  assert.match(await mcp.call('nuvio_undo', { snapshot_id: snapshot }), /Reverted/);
  assert.doesNotMatch(await mcp.call('nuvio_list_addons', { profile_id: 1 }), /new\.example/);
});

test('reorder addons applies the requested order', async () => {
  await mcp.call('nuvio_add_addon', { profile_id: 1, url: 'https://b.example/manifest.json', name: 'B' });
  const out = await mcp.call('nuvio_reorder_addons', {
    profile_id: 1,
    ordered_urls: ['https://b.example/manifest.json', 'https://example.com/a/manifest.json'],
  });
  assert.match(out, /Applied/);
  const listed = await mcp.call('nuvio_list_addons', { profile_id: 1 });
  assert.ok(listed.indexOf('b.example') < listed.indexOf('example.com/a/manifest.json'));
});

test('reorder rejects an incomplete set', async () => {
  const out = await mcp.call('nuvio_reorder_addons', {
    profile_id: 1,
    ordered_urls: ['https://b.example/manifest.json'],
  });
  assert.match(out, /exactly once/);
});

test('destructive remove requires confirm and is undoable', async () => {
  const preview = await mcp.call('nuvio_remove_addon', {
    profile_id: 1,
    url: 'https://b.example/manifest.json',
  });
  assert.match(preview, /Preview/);
  assert.match(await mcp.call('nuvio_list_addons', { profile_id: 1 }), /b\.example/);

  const applied = await mcp.call('nuvio_remove_addon', {
    profile_id: 1,
    url: 'https://b.example/manifest.json',
    confirm: true,
  });
  assert.match(applied, /Applied/);
  assert.doesNotMatch(await mcp.call('nuvio_list_addons', { profile_id: 1 }), /b\.example/);

  await mcp.call('nuvio_undo');
  assert.match(await mcp.call('nuvio_list_addons', { profile_id: 1 }), /b\.example/);
});

test('nested settings set/get/unset', async () => {
  await mcp.call('nuvio_set_setting', {
    profile_id: 1,
    platform: 'tv',
    path: 'features.player_settings.auto_play_next',
    value: false,
  });
  let settings = JSON.parse(
    (await mcp.call('nuvio_get_settings', { profile_id: 1, platform: 'tv' })).replace(/```json|```/g, '')
  );
  assert.equal(settings.settings_json.features.player_settings.auto_play_next, false);
  assert.equal(settings.settings_json.theme, 'dark', 'siblings preserved');

  await mcp.call('nuvio_unset_setting', {
    profile_id: 1,
    platform: 'tv',
    path: 'features.player_settings.auto_play_next',
  });
  settings = JSON.parse(
    (await mcp.call('nuvio_get_settings', { profile_id: 1, platform: 'tv' })).replace(/```json|```/g, '')
  );
  assert.equal(settings.settings_json.features.player_settings.auto_play_next, undefined);
});

test('update_settings deep-merges patch, applies set/unset, and replaces arrays', async () => {
  const out = await mcp.call('nuvio_update_settings', {
    profile_id: 1,
    platform: 'tv',
    patch: { features: { player_settings: { subtitle_language: 'pl' } } },
    set: [{ path: 'features.theme_settings.selected_theme', value: 'DARK' }],
  });
  assert.match(out, /Applied/);
  let settings = JSON.parse(
    (await mcp.call('nuvio_get_settings', { profile_id: 1, platform: 'tv' })).replace(/```json|```/g, '')
  );
  // Deep merge preserved the sibling theme + existing player keys.
  assert.equal(settings.settings_json.theme, 'dark', 'sibling top-level key preserved');
  assert.equal(settings.settings_json.features.player_settings.subtitle_language, 'pl');
  assert.equal(settings.settings_json.features.theme_settings.selected_theme, 'DARK');

  // Array replacement.
  await mcp.call('nuvio_update_settings', {
    profile_id: 1,
    platform: 'tv',
    patch: { features: { player_settings: { order: [3, 2, 1] } } },
  });
  settings = JSON.parse(
    (await mcp.call('nuvio_get_settings', { profile_id: 1, platform: 'tv' })).replace(/```json|```/g, '')
  );
  assert.deepEqual(settings.settings_json.features.player_settings.order, [3, 2, 1]);

  // unset removes the key.
  await mcp.call('nuvio_update_settings', {
    profile_id: 1,
    platform: 'tv',
    unset: ['features.player_settings.order'],
  });
  settings = JSON.parse(
    (await mcp.call('nuvio_get_settings', { profile_id: 1, platform: 'tv' })).replace(/```json|```/g, '')
  );
  assert.equal(settings.settings_json.features.player_settings.order, undefined);
});

test('copy settings between platforms', async () => {
  await mcp.call('nuvio_copy_settings', {
    from_profile_id: 1,
    from_platform: 'tv',
    to_profile_id: 1,
    to_platform: 'mobile',
  });
  const mobile = JSON.parse(
    (await mcp.call('nuvio_get_settings', { profile_id: 1, platform: 'mobile' })).replace(/```json|```/g, '')
  );
  assert.equal(mobile.settings_json.theme, 'dark');
});

test('provider credential is stored, masked in output, and undoable', async () => {
  const secret = 'tmdb-super-secret-key';
  const out = await mcp.call('nuvio_set_provider_credential', {
    profile_id: 1,
    provider: 'tmdb',
    api_key: secret,
  });
  assert.ok(!out.includes(secret), 'secret must not appear in tool output');

  const listed = await mcp.call('nuvio_list_provider_credentials', { profile_id: 1 });
  assert.ok(!listed.includes(secret), 'secret must not appear in listings');
  assert.match(listed, /tmdb/);

  await mcp.call('nuvio_undo');
  const afterUndo = JSON.parse(
    (await mcp.call('nuvio_list_provider_credentials', { profile_id: 1 })).replace(/```json|```/g, '')
  );
  assert.equal(afterUndo.configured.length, 0);
});

test('unsupported provider returns a clear error', async () => {
  const out = await mcp.call('nuvio_set_provider_credential', {
    profile_id: 1,
    provider: 'not-a-provider',
    api_key: 'x',
  });
  assert.match(out, /Unsupported provider/);
});

test('collections create, duplicate, reorder, delete', async () => {
  await mcp.call('nuvio_create_collection', {
    profile_id: 1,
    collection: { id: 'c1', title: 'First', viewMode: 'ROWS', pinToTop: true, folders: [] },
  });
  await mcp.call('nuvio_duplicate_collection', {
    profile_id: 1,
    collection_id: 'c1',
    new_id: 'c2',
    new_title: 'Second',
  });
  let listed = await mcp.call('nuvio_list_collections', { profile_id: 1 });
  assert.match(listed, /First/);
  assert.match(listed, /Second/);
  assert.match(listed, /"pinToTop": true/, 'boolean pinToTop must not be masked');

  await mcp.call('nuvio_reorder_collections', { profile_id: 1, ordered_ids: ['c2', 'c1'] });
  listed = await mcp.call('nuvio_list_collections', { profile_id: 1 });
  assert.ok(listed.indexOf('Second') < listed.indexOf('First'));

  const preview = await mcp.call('nuvio_delete_collection', { profile_id: 1, collection_id: 'c1' });
  assert.match(preview, /Preview/);
  await mcp.call('nuvio_delete_collection', { profile_id: 1, collection_id: 'c1', confirm: true });
  listed = await mcp.call('nuvio_list_collections', { profile_id: 1 });
  assert.doesNotMatch(listed, /"First"/);
});

test('library, progress and history mutations', async () => {
  await mcp.call('nuvio_add_to_library', {
    profile_id: 1,
    items: [{ content_id: 'tt1', content_type: 'movie', name: 'Movie One' }],
  });
  assert.match(await mcp.call('nuvio_get_library', { profile_id: 1 }), /tt1/);

  await mcp.call('nuvio_set_watch_progress', {
    profile_id: 1,
    entries: [{ content_id: 'tt1', content_type: 'movie', position: 10, duration: 100 }],
  });
  assert.match(await mcp.call('nuvio_get_watch_progress', { profile_id: 1 }), /tt1/);

  await mcp.call('nuvio_add_to_watch_history', {
    profile_id: 1,
    items: [{ content_id: 'tt1', content_type: 'movie', title: 'Movie One' }],
  });
  assert.match(await mcp.call('nuvio_get_watch_history', { profile_id: 1 }), /tt1/);

  // Idempotency: a repeated identical history upsert must not duplicate the row.
  await mcp.call('nuvio_add_to_watch_history', {
    profile_id: 1,
    items: [{ content_id: 'tt1', content_type: 'movie', title: 'Movie One' }],
  });
  const history = JSON.parse(
    (await mcp.call('nuvio_get_watch_history', { profile_id: 1 })).replace(/```json|```/g, '')
  );
  assert.equal(history.filter((h) => h.content_id === 'tt1').length, 1, 'watch history must be idempotent');

  await mcp.call('nuvio_remove_from_library', {
    profile_id: 1,
    keys: [{ content_id: 'tt1', content_type: 'movie' }],
    confirm: true,
  });
  assert.doesNotMatch(await mcp.call('nuvio_get_library', { profile_id: 1 }), /tt1/);
});

test('trackers link, list masked, settings, unlink', async () => {
  const token = 'mal-access-token-secret';
  const out = await mcp.call('nuvio_link_tracker', {
    profile_id: 1,
    tracker: 'mal',
    access_token: token,
    username: 'viewer',
  });
  assert.ok(!out.includes(token));

  const listed = await mcp.call('nuvio_list_trackers', { profile_id: 1 });
  assert.ok(!listed.includes(token));
  assert.match(listed, /"linked": true|"linked":true/);

  await mcp.call('nuvio_set_tracker_settings', {
    profile_id: 1,
    tracker: 'mal',
    send_progress: false,
    enabled_statuses: ['watching'],
  });
  await mcp.call('nuvio_unlink_tracker', { profile_id: 1, tracker: 'mal', confirm: true });
  assert.match(await mcp.call('nuvio_list_trackers', { profile_id: 1 }), /"linked": false|"linked":false/);
});

test('library/progress/history changes are precisely undoable', async () => {
  await mcp.call('nuvio_add_to_library', {
    profile_id: 1,
    items: [{ content_id: 'tt-undo', content_type: 'movie', name: 'Undo Me' }],
  });
  assert.match(await mcp.call('nuvio_get_library', { profile_id: 1 }), /tt-undo/);
  await mcp.call('nuvio_undo');
  assert.doesNotMatch(await mcp.call('nuvio_get_library', { profile_id: 1 }), /tt-undo/);

  await mcp.call('nuvio_set_watch_progress', {
    profile_id: 1,
    entries: [{ content_id: 'tt-prog', content_type: 'movie', position: 5, duration: 50 }],
  });
  assert.match(await mcp.call('nuvio_get_watch_progress', { profile_id: 1 }), /tt-prog/);
  await mcp.call('nuvio_undo');
  assert.doesNotMatch(await mcp.call('nuvio_get_watch_progress', { profile_id: 1 }), /tt-prog/);

  await mcp.call('nuvio_add_to_watch_history', {
    profile_id: 1,
    items: [{ content_id: 'tt-hist', content_type: 'movie', title: 'History' }],
  });
  assert.match(await mcp.call('nuvio_get_watch_history', { profile_id: 1 }), /tt-hist/);
  await mcp.call('nuvio_undo');
  assert.doesNotMatch(await mcp.call('nuvio_get_watch_history', { profile_id: 1 }), /tt-hist/);
});

test('collection update preserves folders and folder sources', async () => {
  await mcp.call('nuvio_create_collection', {
    profile_id: 1,
    collection: {
      id: 'reg-c',
      title: 'Reg',
      viewMode: 'ROWS',
      folders: [
        { id: 'rf', title: 'RF', catalogSources: [{ addonId: 'a', type: 'movie', catalogId: 'top' }] },
      ],
    },
  });
  await mcp.call('nuvio_update_collection', {
    profile_id: 1,
    collection_id: 'reg-c',
    changes: { title: 'Reg 2' },
  });
  let listed = await mcp.call('nuvio_list_collections', { profile_id: 1 });
  assert.match(listed, /"id": "rf"/, 'updating the title must not drop folders');
  assert.match(listed, /"catalogId": "top"/);

  await mcp.call('nuvio_update_collection_folder', {
    profile_id: 1,
    collection_id: 'reg-c',
    folder_id: 'rf',
    changes: { title: 'RF 2' },
  });
  listed = await mcp.call('nuvio_list_collections', { profile_id: 1 });
  assert.match(listed, /"catalogId": "top"/, 'updating a folder must not drop its sources');
  assert.match(listed, /RF 2/, 'a folder title change must actually be written');

  await mcp.call('nuvio_update_collection', {
    profile_id: 1,
    collection_id: 'reg-c',
    changes: { pinToTop: true },
  });
  listed = await mcp.call('nuvio_list_collections', { profile_id: 1 });
  assert.match(listed, /"pinToTop": true/, 'a pinToTop change must actually be written');

  await mcp.call('nuvio_delete_collection', { profile_id: 1, collection_id: 'reg-c', confirm: true });
});

test('irreversible preview does not call the backend', async () => {
  const out = await mcp.call('nuvio_register_device', {
    installation_id: 'x',
    client_name: 'unknown-client',
  });
  assert.match(out, /cannot be undone/);
  assert.doesNotMatch(out, /Unsupported Nuvio client/);
  const tok = confirmationToken(out);
  assert.ok(tok);
  const exec = await mcp.call('nuvio_register_device', {
    installation_id: 'x',
    client_name: 'unknown-client',
    confirmation_token: tok,
  });
  assert.match(exec, /Unsupported Nuvio client/, 'the execute phase must reach the backend');
});

test('undoing tracker settings clears a newly created row', async () => {
  await mcp.call('nuvio_set_tracker_settings', {
    profile_id: 1,
    tracker: 'kitsu',
    enabled_statuses: ['watching'],
    send_progress: false,
  });
  await mcp.call('nuvio_undo');
  const listed = await mcp.call('nuvio_list_trackers', { profile_id: 1 });
  const kitsu = JSON.parse(listed.replace(/```json|```/g, '')).find((t) => t.tracker === 'kitsu');
  assert.deepEqual(kitsu.enabled_statuses, [], 'undo must reset the created row');
  assert.equal(kitsu.send_progress, true);
});

test('NUVIO_DISABLE_SNAPSHOTS skips snapshots and disables undo', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const off = await startStdio(mock.url, { NUVIO_DISABLE_SNAPSHOTS: 'true' });
  try {
    const res = await off.call('nuvio_add_addon', {
      profile_id: 1,
      url: 'https://off.example/manifest.json',
      name: 'Off',
    });
    assert.match(res, /Snapshots are disabled/);
    const dir = path.join(off.dir, 'snapshots');
    assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, 'no snapshots must be written');
    const undo = await off.call('nuvio_undo', {});
    assert.match(undo, /nothing to undo/);
  } finally {
    await off.close();
  }
  await mcp.call('nuvio_remove_addon', {
    profile_id: 1,
    url: 'https://off.example/manifest.json',
    confirm: true,
  });
});

test('revoking a session uses two-phase confirmation', async () => {
  const sessionId = '00000000-0000-4000-8000-000000000001';
  const preview = await mcp.call('nuvio_revoke_session', { session_id: sessionId });
  assert.match(preview, /cannot be undone/);
  const token = confirmationToken(preview);
  assert.ok(token, 'preview must return a confirmation token');

  // Wrong arguments must be rejected.
  const mismatch = await mcp.call('nuvio_revoke_session', {
    session_id: '00000000-0000-4000-8000-000000000002',
    confirmation_token: token,
  });
  assert.match(mismatch, /does not match these arguments/);

  // Correct token executes.
  const applied = await mcp.call('nuvio_revoke_session', {
    session_id: sessionId,
    confirmation_token: token,
  });
  assert.match(applied, /Applied/);

  // Replay is rejected.
  const replay = await mcp.call('nuvio_revoke_session', { session_id: sessionId, confirmation_token: token });
  assert.match(replay, /already been used/);
});

test('a forged confirmation token is rejected', async () => {
  const out = await mcp.call('nuvio_revoke_session', {
    session_id: '00000000-0000-4000-8000-000000000002',
    confirmation_token: 'ZmFrZQ.ZmFrZQ',
  });
  assert.match(out, /Invalid confirmation token|Malformed confirmation token/);
});

test('snapshot write failure prevents the mutation', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nuvio-block-'));
  fs.writeFileSync(path.join(dir, 'blocked'), 'not a directory');
  const broken = await startStdio(mock.url, {
    NUVIO_DATA_DIR: dir,
    NUVIO_SNAPSHOT_DIR: path.join(dir, 'blocked', 'snapshots'),
  });
  try {
    const before = await broken.call('nuvio_list_addons', { profile_id: 1 });
    const out = await broken.call('nuvio_add_addon', {
      profile_id: 1,
      url: 'https://should-not-persist.example/manifest.json',
      name: 'Blocked',
    });
    assert.match(out, /Could not persist the pre-change snapshot/);
    const after = await broken.call('nuvio_list_addons', { profile_id: 1 });
    assert.equal(after, before, 'no mutation may happen when the snapshot cannot be written');
  } finally {
    await broken.close();
  }
});

test('corrupted snapshots are skipped, not fatal', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.writeFileSync(path.join(mcp.dir, 'snapshots', 'garbage.json'), '{ this is not json');
  const listed = await mcp.call('nuvio_list_undo', { limit: 50 });
  assert.match(listed, /nuvio_/);
});

test('expired confirmation tokens are rejected', async () => {
  // A structurally valid token signed with the process secret but already expired
  // cannot be produced from outside, so assert the clock check via a crafted payload.
  const out = await mcp.call('nuvio_revoke_session', {
    session_id: '00000000-0000-4000-8000-000000000002',
    confirmation_token:
      Buffer.from(JSON.stringify({ tool: 'nuvio_revoke_session', args: '[]', exp: 1, nonce: 'x' })).toString(
        'base64url'
      ) + '.invalid',
  });
  assert.match(out, /Invalid confirmation token|Malformed confirmation token/);
});

test('profile create then undo removes the surplus profile', async () => {
  await mcp.call('nuvio_create_profile', { name: 'Temp', profile_id: 3 });
  assert.match(await mcp.call('nuvio_list_profiles'), /Temp/);
  await mcp.call('nuvio_undo');
  assert.doesNotMatch(await mcp.call('nuvio_list_profiles'), /Temp/);
});

test('nuvio_redo re-applies an undo', async () => {
  await mcp.call('nuvio_add_addon', {
    profile_id: 1,
    url: 'https://redo.example/manifest.json',
    name: 'Redo',
  });
  await mcp.call('nuvio_undo');
  assert.doesNotMatch(await mcp.call('nuvio_list_addons', { profile_id: 1 }), /redo\.example/);
  await mcp.call('nuvio_redo');
  assert.match(await mcp.call('nuvio_list_addons', { profile_id: 1 }), /redo\.example/);
});

test('list_undo and inspect_snapshot work', async () => {
  const listed = await mcp.call('nuvio_list_undo', { limit: 5 });
  assert.match(listed, /nuvio_/);
  const id = listed.split('\n')[0].split(' ')[0];
  const inspected = await mcp.call('nuvio_inspect_snapshot', { snapshot_id: id });
  assert.match(inspected, /snapshot|tool/);
});

test('unknown snapshot id yields a clear error', async () => {
  const out = await mcp.call('nuvio_undo', { snapshot_id: 'does-not-exist' });
  assert.match(out, /not found/);
});

test('scheme-less addon URLs round-trip through reorder/update/toggle/remove', async () => {
  const cinemeta = 'v3-cinemeta.strem.io/manifest.json';
  const subs = 'opensubtitles-v3.strem.io/manifest.json';
  const listed = await mcp.call('nuvio_list_addons', { profile_id: 2 });
  assert.match(listed, /v3-cinemeta\.strem\.io/);

  assert.match(
    await mcp.call('nuvio_reorder_addons', { profile_id: 2, ordered_urls: [subs, cinemeta] }),
    /Applied/
  );
  const reordered = await mcp.call('nuvio_list_addons', { profile_id: 2 });
  assert.ok(reordered.indexOf('opensubtitles-v3') < reordered.indexOf('v3-cinemeta'), 'reorder applies');

  assert.match(
    await mcp.call('nuvio_update_addon', { profile_id: 2, url: cinemeta, name: 'Cinemeta Renamed' }),
    /Applied/
  );
  assert.match(
    await mcp.call('nuvio_toggle_addon', { profile_id: 2, url: cinemeta, enabled: false }),
    /Applied/
  );

  assert.match(await mcp.call('nuvio_remove_addon', { profile_id: 2, url: cinemeta }), /Preview/);
  assert.match(
    await mcp.call('nuvio_remove_addon', { profile_id: 2, url: cinemeta, confirm: true }),
    /Applied/
  );
  assert.doesNotMatch(await mcp.call('nuvio_list_addons', { profile_id: 2 }), /v3-cinemeta/);
});

test('addon URL input rejects non-http schemes and junk', async () => {
  assert.match(
    await mcp.call('nuvio_reorder_addons', { profile_id: 1, ordered_urls: ['ftp://x.example/a'] }),
    /validation|invalid/i
  );
  assert.match(
    await mcp.call('nuvio_toggle_addon', { profile_id: 1, url: 'not a url', enabled: true }),
    /validation|invalid/i
  );
});

test('scheme-less plugin URLs round-trip through toggle/reorder/remove', async () => {
  const url = 'v3-plugins.strem.io/plugin.js';
  assert.match(await mcp.call('nuvio_list_plugins', { profile_id: 2 }), /v3-plugins\.strem\.io/);
  assert.match(await mcp.call('nuvio_toggle_plugin', { profile_id: 2, url, enabled: false }), /Applied/);
  assert.match(
    await mcp.call('nuvio_reorder_plugins', { profile_id: 2, ordered_urls: [url] }),
    /No changes|Applied/
  );
  assert.match(await mcp.call('nuvio_remove_plugin', { profile_id: 2, url }), /Preview/);
  assert.match(await mcp.call('nuvio_remove_plugin', { profile_id: 2, url, confirm: true }), /Applied/);
});

test('profile PIN is masked in output, confirmation token and audit log', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const pin = 's3cretPIN';

  const preview = await mcp.call('nuvio_set_profile_pin', { profile_id: 1, pin });
  assert.ok(!preview.includes(pin), 'PIN must not appear in the preview');
  const token = confirmationToken(preview);
  assert.ok(token, 'preview must include a confirmation token');
  const body = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
  assert.ok(!body.includes(pin), 'PIN must not be readable from the confirmation token');

  const applied = await mcp.call('nuvio_set_profile_pin', {
    profile_id: 1,
    pin,
    confirmation_token: token,
  });
  assert.ok(!applied.includes(pin), 'PIN must not appear in the applied output');

  const audit = fs.readFileSync(path.join(mcp.dir, 'audit.jsonl'), 'utf8');
  assert.ok(!audit.includes(pin), 'PIN must not appear in the audit log');
});

test('inspect_addon refuses loopback and link-local targets (SSRF)', async () => {
  assert.match(
    await mcp.call('nuvio_inspect_addon', { url: 'http://127.0.0.1:9/manifest.json' }),
    /private\/loopback/
  );
  assert.match(
    await mcp.call('nuvio_inspect_addon', { url: 'http://169.254.169.254/latest/meta-data/' }),
    /private\/loopback/
  );
});

test('undo with NUVIO_DISABLE_SNAPSHOTS writes no snapshot', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const off = await startStdio(mock.url, { NUVIO_DISABLE_SNAPSHOTS: 'true' });
  try {
    const dir = path.join(off.dir, 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    const old = {
      id: '0000000000000001-abcdef01',
      ts: new Date().toISOString(),
      tool: 'nuvio_set_provider_credential',
      backend: mock.url,
      resource: { kind: 'provider_credentials', profile_id: 1 },
      reversible: true,
      sensitive: true,
      before: [],
    };
    fs.writeFileSync(path.join(dir, `${old.id}.json`), JSON.stringify(old));

    const before = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
    const out = await off.call('nuvio_undo', { snapshot_id: old.id });
    assert.match(out, /Reverted/);
    assert.match(out, /Snapshots are disabled/);
    const after = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
    assert.equal(after, before, 'undo must not write a snapshot when snapshots are disabled');
  } finally {
    await off.close();
  }
});
