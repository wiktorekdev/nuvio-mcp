import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setPath, unsetPath, getPath } from '../dist/nuvio/paths.js';
import { maskDeep, maskSecret } from '../dist/mask.js';
import { VERSION } from '../dist/version.js';
import { ConfirmationGate } from '../dist/nuvio/confirm.js';
import { getSnapshot, removeSnapshot } from '../dist/nuvio/snapshots.js';
import { fetchJsonFromPublicUrl, isPrivateAddress } from '../dist/nuvio/safe-fetch.js';

test('server version comes from package.json (single source of truth)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('setPath creates nested objects', () => {
  const out = setPath({}, 'a.b.c', 1);
  assert.deepEqual(out, { a: { b: { c: 1 } } });
});

test('setPath creates arrays for numeric segments', () => {
  const out = setPath({}, 'rows.0.height', 42);
  assert.deepEqual(out, { rows: [{ height: 42 }] });
});

test('setPath updates existing nested values without touching siblings', () => {
  const before = { features: { player: { next: true, other: 'keep' } }, theme: 'dark' };
  const out = setPath(before, 'features.player.next', false);
  assert.equal(getPath(out, 'features.player.next'), false);
  assert.equal(getPath(out, 'features.player.other'), 'keep');
  assert.equal(out.theme, 'dark');
  assert.equal(before.features.player.next, true, 'input must not be mutated');
});

test('unsetPath removes a nested key', () => {
  const out = unsetPath({ a: { b: 1, c: 2 } }, 'a.b');
  assert.deepEqual(out, { a: { c: 2 } });
});

test('unsetPath on a missing path is a no-op', () => {
  const out = unsetPath({ a: 1 }, 'x.y.z');
  assert.deepEqual(out, { a: 1 });
});

test('maskSecret keeps a short suffix', () => {
  assert.equal(maskSecret('abcdef1234'), '****1234');
  assert.equal(maskSecret('ab'), '****');
});

test('maskDeep masks sensitive keys only', () => {
  const masked = maskDeep({
    provider: 'tmdb',
    credential_json: { api_key: 'super-secret-value' },
    access_token: 'oauth-token-value',
    name: 'Main',
    nested: { refresh_token: 'r' },
    pinToTop: true,
    pin_enabled: false,
    origin_client_id: 'nuvio-mcp',
  });
  assert.equal(masked.provider, 'tmdb');
  assert.equal(masked.name, 'Main');
  assert.equal(masked.credential_json, '****');
  assert.equal(masked.access_token, '****alue');
  assert.equal(masked.nested.refresh_token, '****');
  assert.equal(masked.pinToTop, true, 'non-secret pinToTop must not be masked');
  assert.equal(masked.pin_enabled, false);
  assert.equal(masked.origin_client_id, 'nuvio-mcp');
  assert.ok(!JSON.stringify(masked).includes('super-secret-value'));
  assert.ok(!JSON.stringify(masked).includes('oauth-token-value'));
});

test('setPath rejects prototype-polluting segments', () => {
  assert.throws(() => setPath({}, '__proto__.polluted', 1), /Unsafe path segment/);
  assert.throws(() => setPath({}, 'a.constructor.prototype.x', 1), /Unsafe path segment/);
  assert.throws(() => setPath({}, 'prototype.x', 1), /Unsafe path segment/);
  assert.equal({}.polluted, undefined, 'Object.prototype must stay clean');
});

test('unsetPath rejects prototype-polluting segments', () => {
  assert.throws(() => unsetPath({}, '__proto__.x'), /Unsafe path segment/);
});

test('getPath ignores prototype-polluting segments', () => {
  assert.equal(getPath({ a: 1 }, '__proto__.toString'), undefined);
  assert.equal(getPath({ a: 1 }, 'a'), 1);
});

test('maskDeep masks PIN keys but keeps unrelated pin fields', () => {
  const masked = maskDeep({
    pin: '4321',
    current_pin: '0000',
    new_pin: '1111',
    pincode: '9999',
    passcode: 'ABCD',
    pinToTop: true,
    pin_enabled: false,
    pin_locked_until: null,
  });
  assert.equal(masked.pin, '****');
  assert.equal(masked.current_pin, '****');
  assert.equal(masked.new_pin, '****');
  assert.equal(masked.pincode, '****');
  assert.equal(masked.passcode, '****');
  assert.equal(masked.pinToTop, true);
  assert.equal(masked.pin_enabled, false);
  assert.equal(masked.pin_locked_until, null);
});

test('confirmation tokens bind arguments without embedding them', () => {
  const gate = new ConfirmationGate(Buffer.from('test-secret-test-secret-1234'));
  const args = { profile_index: 1, pin: '4321', current_pin: '0000' };
  const { token } = gate.prepare('nuvio_set_profile_pin', args);
  const body = Buffer.from(token.split('.')[0], 'base64url').toString('utf8');
  assert.ok(!body.includes('4321'), 'raw PIN must not be embedded in the token');
  assert.ok(!body.includes('current_pin'), 'raw argument names must not be embedded in the token');

  gate.verify('nuvio_set_profile_pin', args, token);
  assert.throws(() => gate.verify('nuvio_set_profile_pin', args, token), /already been used/);

  const other = gate.prepare('nuvio_set_profile_pin', args);
  assert.throws(
    () => gate.verify('nuvio_set_profile_pin', { ...args, pin: '9999' }, other.token),
    /does not match/
  );
  assert.throws(() => gate.verify('nuvio_clear_profile_pin', args, other.token), /different operation/);
});

test('snapshot ids cannot escape the snapshot directory', () => {
  const base = mkdtempSync(join(tmpdir(), 'nuvio-snap-'));
  const snapshotDir = join(base, 'snapshots');
  mkdirSync(snapshotDir, { recursive: true });
  writeFileSync(join(base, 'secret.json'), JSON.stringify({ before: 'leak' }));
  const cfg = { snapshotDir };

  assert.equal(getSnapshot(cfg, '../secret'), null);
  assert.equal(getSnapshot(cfg, '..%2fsecret'), null);
  assert.doesNotThrow(() => removeSnapshot(cfg, '../secret'));

  const id = '0000000000000001-abcdef01';
  writeFileSync(join(snapshotDir, `${id}.json`), JSON.stringify({ id }));
  assert.equal(getSnapshot(cfg, id)?.id, id);
});

test('isPrivateAddress classifies loopback, private and public addresses', () => {
  for (const ip of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.5.4',
    '192.168.1.1',
    '169.254.169.254',
    '::1',
    'fd00::1',
    'fe80::1',
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test('fetchJsonFromPublicUrl refuses loopback, private and non-http targets', async () => {
  await assert.rejects(() => fetchJsonFromPublicUrl('http://127.0.0.1:1/x'), /private\/loopback/);
  await assert.rejects(
    () => fetchJsonFromPublicUrl('http://169.254.169.254/latest/meta-data/'),
    /private\/loopback/
  );
  await assert.rejects(() => fetchJsonFromPublicUrl('file:///etc/passwd'), /http\(s\)/);
});

test('NuvioClient retries a 429 and then succeeds', async () => {
  const { NuvioClient } = await import('../dist/nuvio/client.js');
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const client = new NuvioClient(
      { backendUrl: 'https://api.example', publishableKey: 'k', backendTimeoutMs: 1000 },
      { getAccessToken: async () => 'token', forceRefresh: async () => {} }
    );
    assert.deepEqual(await client.request('/rest/v1/rpc/x'), { ok: true });
    assert.equal(calls, 2, 'should retry the rate-limited request once');
  } finally {
    globalThis.fetch = original;
  }
});

test('NuvioClient surfaces a persistent 429 after bounded retries', async () => {
  const { NuvioClient } = await import('../dist/nuvio/client.js');
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } });
  };
  try {
    const client = new NuvioClient(
      { backendUrl: 'https://api.example', publishableKey: 'k', backendTimeoutMs: 1000 },
      { getAccessToken: async () => 'token', forceRefresh: async () => {} }
    );
    await assert.rejects(() => client.request('/rest/v1/rpc/x'), /429/);
    assert.ok(calls > 1, 'should have retried before giving up');
  } finally {
    globalThis.fetch = original;
  }
});

test('fetchJsonFromPublicUrl re-validates every redirect hop', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9/x' } });
  try {
    await assert.rejects(() => fetchJsonFromPublicUrl('http://8.8.8.8/manifest.json'), /private\/loopback/);
  } finally {
    globalThis.fetch = original;
  }
});
