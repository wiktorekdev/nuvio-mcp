#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config.js';
import { AuthManager } from './nuvio/auth.js';
import { NuvioClient } from './nuvio/client.js';
import { createServer } from './mcp.js';
import { startHttpServer } from './server/http.js';
import { VERSION } from './version.js';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
  const cfg = loadConfig();

  const auth = new AuthManager({
    backendUrl: cfg.backendUrl,
    publishableKey: cfg.publishableKey,
    email: cfg.email,
    password: cfg.password,
    refreshToken: cfg.refreshToken,
    sessionFile: cfg.sessionFile,
    timeoutMs: Math.min(cfg.backendTimeoutMs, 15_000),
  });
  const client = new NuvioClient(cfg, auth);

  const shutdown = async (close: () => Promise<void>): Promise<void> => {
    try {
      await close();
    } finally {
      process.exit(0);
    }
  };

  if (cfg.transport === 'http') {
    const authenticated = Boolean(cfg.http.token || cfg.oauth.introspectionUrl);
    if (!LOOPBACK.has(cfg.http.host) && !authenticated && !cfg.http.allowUnauthenticated) {
      log(
        `refusing to start: binding ${cfg.http.host} without authentication. ` +
          'Set NUVIO_HTTP_TOKEN (or NUVIO_OAUTH_INTROSPECTION_URL), or set ' +
          'NUVIO_HTTP_ALLOW_UNAUTHENTICATED=true to override (unsafe).'
      );
      process.exit(1);
    }
    if (!authenticated) {
      log(
        'WARNING: HTTP endpoint is unauthenticated (loopback bind). Set NUVIO_HTTP_TOKEN for any shared use.'
      );
    }
    const handle = await startHttpServer(cfg, client);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => void shutdown(handle.close));
    }
    return;
  }

  const handle = serveStdio(() => createServer(client, cfg));
  log(
    `nuvio-mcp ${VERSION} ready — backend=${cfg.backendUrl} transport=stdio undo=${cfg.snapshotDir}` +
      `${cfg.email ? ` user=${cfg.email}` : ''}`
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(() => handle.close()));
  }
}

main().catch((error) => {
  log(`nuvio-mcp failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
