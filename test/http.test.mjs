import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as netServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startMockNuvio } from './mock-nuvio.mjs';
import { text } from './helpers.mjs';

const TOKEN = 'test-http-token';
const PROTOCOL = '2026-07-28';
const MAX_BODY = 4096;

function freePort() {
  return new Promise((resolve) => {
    const srv = netServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function raw(method, url, { headers = {}, body, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const finalHeaders = { ...headers };
    if (body && !chunked) finalHeaders['Content-Length'] = Buffer.byteLength(body);
    const req = httpRequest(
      { method, hostname: u.hostname, port: u.port, path: u.pathname, headers: finalHeaders },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    if (body) {
      if (chunked) {
        for (let i = 0; i < body.length; i += 512) req.write(body.slice(i, i + 512));
      } else {
        req.write(body);
      }
    }
    req.end();
  });
}

async function waitForHealth(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('HTTP server did not become ready');
}

let mock;
let child;
let baseUrl;
let client;

before(async () => {
  mock = await startMockNuvio();
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn('node', ['dist/index.js'], {
    env: {
      ...process.env,
      NUVIO_BACKEND_URL: mock.url,
      NUVIO_PUBLISHABLE_KEY: 'test-key',
      NUVIO_EMAIL: 'mock@example.com',
      NUVIO_PASSWORD: 'mock-password',
      NUVIO_DATA_DIR: mkdtempSync(join(tmpdir(), 'nuvio-http-')),
      NUVIO_TRANSPORT: 'http',
      NUVIO_HTTP_HOST: '127.0.0.1',
      NUVIO_HTTP_PORT: String(port),
      NUVIO_HTTP_TOKEN: TOKEN,
      NUVIO_HTTP_ALLOWED_HOSTS: '127.0.0.1',
      NUVIO_HTTP_MAX_BODY_BYTES: String(MAX_BODY),
      NUVIO_OAUTH_ISSUER: 'https://issuer.example',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', () => {});
  await waitForHealth(baseUrl);

  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    authProvider: { token: async () => TOKEN },
  });
  client = new Client(
    { name: 'nuvio-http-test', version: '0.0.0' },
    { capabilities: {}, versionNegotiation: { mode: { pin: PROTOCOL } } }
  );
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  child?.kill('SIGTERM');
  await mock?.close();
});

test('health endpoint responds', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.match(body.version, /^\d+\.\d+\.\d+$/);
});

test('serves RFC 9728 protected resource metadata', async () => {
  const res = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.authorization_servers, ['https://issuer.example']);
});

test('negotiates the modern protocol version', async () => {
  assert.equal(client.getNegotiatedProtocolVersion?.(), PROTOCOL);
  const tools = await client.listTools();
  assert.ok(tools.tools.length > 55);
});

test('runs tools over the modern HTTP transport', async () => {
  const result = await client.callTool({ name: 'nuvio_list_profiles', arguments: {} });
  assert.match(text(result), /Main/);
});

test('rejects unauthenticated requests with 401', async () => {
  const res = await raw('POST', `${baseUrl}/mcp`, {
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': PROTOCOL,
      'Mcp-Method': 'tools/list',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 401);
  assert.match(String(res.headers['www-authenticate']), /Bearer/);
});

test('rejects a disallowed Host header (DNS rebinding)', async () => {
  const res = await raw('POST', `${baseUrl}/mcp`, {
    headers: {
      Host: 'evil.example',
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': PROTOCOL,
      'Mcp-Method': 'tools/list',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 403);
});

test('rejects a disallowed Origin header', async () => {
  const res = await raw('POST', `${baseUrl}/mcp`, {
    headers: {
      Origin: 'http://evil.example',
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': PROTOCOL,
      'Mcp-Method': 'tools/list',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(res.status, 403);
});

test('rejects GET on the MCP endpoint', async () => {
  const res = await raw('GET', `${baseUrl}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 405);
});

test('rejects oversized request bodies with 413', async () => {
  const res = await raw('POST', `${baseUrl}/mcp`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': PROTOCOL,
      'Mcp-Method': 'tools/call',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'x', arguments: { pad: 'a'.repeat(MAX_BODY * 2) } },
    }),
  });
  assert.equal(res.status, 413);
});

test('rejects an oversized chunked body without a Content-Length', async () => {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'x', arguments: { pad: 'a'.repeat(MAX_BODY * 2) } },
  });
  const res = await raw('POST', `${baseUrl}/mcp`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
      'Mcp-Method': 'tools/call',
    },
    body: payload,
    chunked: true,
  });
  assert.equal(res.status, 413);
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200, 'server stays responsive after aborting an oversized chunked body');
});

test('accepts a chunked body within the limit', async () => {
  const res = await raw('POST', `${baseUrl}/mcp`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
      'Mcp-Method': 'tools/list',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL,
          'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
    chunked: true,
  });
  assert.equal(res.status, 200);
});

test('rejects invalid JSON with 400', async () => {
  const res = await raw('POST', `${baseUrl}/mcp`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL,
      'Mcp-Method': 'tools/list',
    },
    body: '{ this is not valid json',
  });
  assert.equal(res.status, 400);
});

test('rejects an unsupported protocol version with 400', async () => {
  const res = await raw('POST', `${baseUrl}/mcp`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '1999-01-01',
      'Mcp-Method': 'tools/list',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1999-01-01' } },
    }),
  });
  assert.equal(res.status, 400);
  assert.match(res.body, /UnsupportedProtocolVersion|protocol/i);
});
