import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deepMerge, applySettingsEdit } from '../dist/nuvio/ops/settings.js';
import { progressKeyOf, historyKeyFrom } from '../dist/nuvio/ops/library.js';
import { captureComposite, getSnapshot, pruneSnapshots } from '../dist/nuvio/snapshots.js';
import { withCallCache, callCache } from '../dist/nuvio/call-context.js';
import { NuvioClient } from '../dist/nuvio/client.js';

// ---------------------------------------------------------------------------
// Deep merge semantics
// ---------------------------------------------------------------------------

test('deepMerge merges nested objects and preserves siblings', () => {
  const before = { features: { a: 1, b: 2 }, theme: 'dark' };
  const after = deepMerge(before, { features: { a: 3 } });
  assert.deepEqual(after, { features: { a: 3, b: 2 }, theme: 'dark' });
  assert.deepEqual(before, { features: { a: 1, b: 2 }, theme: 'dark' }, 'input untouched');
});

test('deepMerge replaces arrays wholesale', () => {
  assert.deepEqual(deepMerge({ a: [1, 2, 3] }, { a: [9] }), { a: [9] });
});

test('deepMerge replaces scalars, mismatched types and treats null as a value', () => {
  assert.deepEqual(deepMerge({ a: 1 }, { a: 'x' }), { a: 'x' });
  assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: 5 }), { a: 5 });
  assert.deepEqual(deepMerge({ a: { b: 1 } }, { a: null }), { a: null });
  assert.deepEqual(deepMerge({ a: null }, { a: { b: 1 } }), { a: { b: 1 } });
});

test('deepMerge refuses prototype-polluting keys', () => {
  assert.throws(() => deepMerge({}, JSON.parse('{"__proto__":{"polluted":true}}')), /Unsafe path segment/);
  assert.throws(() => deepMerge({}, { constructor: { x: 1 } }), /Unsafe path segment/);
  assert.equal({}.polluted, undefined);
});

test('applySettingsEdit applies patch, then set, then unset', () => {
  const { after, diff } = applySettingsEdit(
    { features: { a: 1 } },
    {
      patch: { features: { b: 2 } },
      set: [{ path: 'features.c', value: 3 }],
      unset: ['features.a'],
    }
  );
  assert.deepEqual(after, { features: { b: 2, c: 3 } });
  assert.ok(diff.some((d) => d.includes('features.b')));
  assert.ok(diff.some((d) => d.includes('features.c')));
  assert.ok(diff.some((d) => d.includes('features.a')));
});

test('settings regression: a partial patch keeps unrelated nested keys', () => {
  const { after } = applySettingsEdit({ features: { a: 1, b: 2 } }, { patch: { features: { a: 3 } } });
  assert.deepEqual(after, { features: { a: 3, b: 2 } });
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

test('progressKeyOf builds the internal key from structured fields', () => {
  assert.equal(progressKeyOf({ content_id: 'tt1' }), 'tt1');
  assert.equal(progressKeyOf({ content_id: 'tt1', season: 2, episode: 5 }), 'tt1_s2e5');
  assert.equal(historyKeyFrom({ content_id: 'tt1', season: 2, episode: 5 }), 'tt1|2|5');
});

// ---------------------------------------------------------------------------
// Per-call resource cache
// ---------------------------------------------------------------------------

test('callCache resolves a loader once per call scope and not across scopes', async () => {
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return calls;
  };
  const value = await withCallCache(async () => {
    const a = await callCache('k', loader);
    const b = await callCache('k', loader);
    assert.equal(a, b);
    return a;
  });
  assert.equal(value, 1);
  assert.equal(calls, 1, 'loader once inside the scope');
  await callCache('k', loader);
  assert.equal(calls, 2, 'no caching outside a call scope');
});

// ---------------------------------------------------------------------------
// Snapshot retention (GC)
// ---------------------------------------------------------------------------

function snapshotDirWith(ids) {
  const dir = mkdtempSync(join(tmpdir(), 'nuvio-gc-'));
  for (const id of ids)
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, payload: 'x'.repeat(50) }));
  return dir;
}

const gcCfg = (dir, overrides = {}) => ({
  snapshotDir: dir,
  snapshotMaxAgeDays: 30,
  snapshotMaxCount: 250,
  snapshotMaxTotalBytes: 50 * 1024 * 1024,
  ...overrides,
});

function idAgo(days, seq = 1) {
  const ms = Date.now() - days * 24 * 60 * 60 * 1000;
  return `${String(ms).padStart(16, '0')}-${String(seq).padStart(8, '0')}`;
}

test('pruneSnapshots enforces the count limit while keeping the newest', () => {
  const dir = snapshotDirWith([idAgo(0, 1), idAgo(0, 2), idAgo(0, 3), idAgo(0, 4), idAgo(0, 5)]);
  const result = pruneSnapshots(
    gcCfg(dir, { snapshotMaxCount: 2, snapshotMaxAgeDays: 0, snapshotMaxTotalBytes: 0 }),
    {}
  );
  assert.equal(result.removed.length, 3);
  assert.equal(readdirSync(dir).length, 2);
});

test('pruneSnapshots enforces the age limit', () => {
  const dir = snapshotDirWith([idAgo(40, 1), idAgo(0, 2)]);
  const result = pruneSnapshots(gcCfg(dir), { keepLast: 1, maxCount: 0 });
  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].reason, 'age');
});

test('pruneSnapshots dry-run removes nothing', () => {
  const dir = snapshotDirWith([idAgo(0, 1), idAgo(0, 2), idAgo(0, 3)]);
  const result = pruneSnapshots(
    gcCfg(dir, { snapshotMaxCount: 1, snapshotMaxAgeDays: 0, snapshotMaxTotalBytes: 0 }),
    {
      dryRun: true,
    }
  );
  assert.equal(result.removed.length, 2);
  assert.equal(readdirSync(dir).length, 3);
});

// ---------------------------------------------------------------------------
// Composite snapshot serialisation
// ---------------------------------------------------------------------------

test('composite snapshots round-trip through disk with all resources', () => {
  const dir = snapshotDirWith([]);
  const cfg = gcCfg(dir);
  const client = { currentEmail: 'a@b.c', currentUserId: 'u1' };
  const snap = captureComposite(cfg, client, {
    tool: 'nuvio_apply_plan',
    entries: [
      { resource: { kind: 'settings', profile_id: 1, platform: 'tv' }, before: { a: 1 } },
      { resource: { kind: 'addons', profile_id: 1 }, before: [{ url: 'u' }] },
    ],
  });
  const loaded = getSnapshot(cfg, snap.id);
  assert.equal(loaded.composite, true);
  assert.equal(loaded.resources.length, 2);
  assert.deepEqual(loaded.resources[0].before, { a: 1 });
  assert.equal(loaded.sensitive, false);
});

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

function makeClient(fetchImpl) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const auth = {
    getAccessToken: async () => 'token',
    forceRefresh: async () => {
      auth.refreshed = (auth.refreshed ?? 0) + 1;
    },
  };
  const client = new NuvioClient(
    { backendUrl: 'https://api.example', publishableKey: 'k', backendTimeoutMs: 1000 },
    auth
  );
  return { client, auth, restore: () => (globalThis.fetch = original) };
}

test('GET retries a 500 then succeeds', async () => {
  let calls = 0;
  const { client, restore } = makeClient(async () => {
    calls += 1;
    return calls === 1
      ? new Response('x', { status: 500 })
      : new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  });
  try {
    assert.deepEqual(await client.request('/x'), { ok: 1 });
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test('GET retries a network failure then succeeds', async () => {
  let calls = 0;
  const { client, restore } = makeClient(async () => {
    calls += 1;
    if (calls === 1) throw new Error('ECONNRESET');
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  });
  try {
    assert.deepEqual(await client.request('/x'), { ok: 1 });
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test('non-idempotent POST does not retry a timeout', async () => {
  let calls = 0;
  const { client, restore } = makeClient(async () => {
    calls += 1;
    throw new Error('The operation was aborted due to timeout');
  });
  try {
    await assert.rejects(() => client.rpc('sync_push_addons', { a: 1 }));
    assert.equal(calls, 1, 'a write must never be retried on timeout');
  } finally {
    restore();
  }
});

test('non-idempotent POST does not retry a 503', async () => {
  let calls = 0;
  const { client, restore } = makeClient(async () => {
    calls += 1;
    return new Response('x', { status: 503 });
  });
  try {
    await assert.rejects(() => client.rpc('sync_push_addons', { a: 1 }));
    assert.equal(calls, 1);
  } finally {
    restore();
  }
});

test('idempotent write retries a 503 then succeeds', async () => {
  let calls = 0;
  const { client, restore } = makeClient(async () => {
    calls += 1;
    return calls === 1
      ? new Response('x', { status: 503 })
      : new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  });
  try {
    assert.deepEqual(await client.rpc('sync_push_watch_progress', { a: 1 }, { idempotent: true }), { ok: 1 });
    assert.equal(calls, 2);
  } finally {
    restore();
  }
});

test('401 triggers a single refresh and retry', async () => {
  let calls = 0;
  const { client, auth, restore } = makeClient(async () => {
    calls += 1;
    return calls === 1
      ? new Response('unauthorized', { status: 401 })
      : new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  });
  try {
    assert.deepEqual(await client.request('/x'), { ok: 1 });
    assert.equal(calls, 2);
    assert.equal(auth.refreshed, 1);
  } finally {
    restore();
  }
});

test('idempotency metadata is sent as the Idempotency-Key header', async () => {
  let seen = null;
  const { client, restore } = makeClient(async (_url, init) => {
    seen = init.headers['Idempotency-Key'];
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  });
  try {
    await client.rpc('sync_push_watch_progress', { a: 1 }, { requestId: 'req-123', idempotent: true });
    assert.equal(seen, 'req-123');
  } finally {
    restore();
  }
});
