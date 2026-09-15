import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setPath, unsetPath, getPath } from '../dist/nuvio/paths.js';
import { maskDeep, maskSecret } from '../dist/mask.js';
import { VERSION } from '../dist/version.js';
import { readFileSync } from 'node:fs';

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
