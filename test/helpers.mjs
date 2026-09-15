import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export const text = (result) =>
  (result.content ?? []).map((c) => (c.type === 'text' ? c.text : '')).join('\n');

export async function startStdio(backendUrl, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nuvio-test-'));
  const client = new Client(
    { name: 'nuvio-test', version: '0.0.0' },
    { capabilities: {}, versionNegotiation: { mode: 'auto' } }
  );
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: {
      ...process.env,
      NUVIO_BACKEND_URL: backendUrl,
      NUVIO_PUBLISHABLE_KEY: 'test-key',
      NUVIO_EMAIL: 'mock@example.com',
      NUVIO_PASSWORD: 'mock-password',
      NUVIO_DATA_DIR: dir,
      NUVIO_TRANSPORT: 'stdio',
      ...extraEnv,
    },
  });
  await client.connect(transport);
  return {
    client,
    dir,
    call: async (name, args = {}) => text(await client.callTool({ name, arguments: args })),
    close: () => client.close(),
  };
}

export function lastSnapshotId(output) {
  return output.match(/snapshot_id "([^"]+)"/)?.[1];
}

export function confirmationToken(output) {
  return output.match(/confirmation_token: "([^"]+)"/)?.[1];
}
