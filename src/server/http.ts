import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createMcpHandler, type AuthInfo, type McpHttpHandler } from '@modelcontextprotocol/server';
import {
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { createServer as createMcpServer } from '../mcp.js';
import { VERSION } from '../version.js';

export interface HttpHandle {
  close(): Promise<void>;
  port: number;
}

const MCP_PATH = '/mcp';
const METADATA_PATHS = ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'];

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function allowedHostnames(cfg: NuvioConfig): string[] {
  const hosts = new Set(localhostAllowedHostnames());
  if (cfg.http.host && cfg.http.host !== '0.0.0.0' && cfg.http.host !== '::') hosts.add(cfg.http.host);
  for (const host of cfg.http.allowedHosts) hosts.add(host);
  return [...hosts];
}

function allowedOriginHostnames(cfg: NuvioConfig): string[] {
  const hosts = new Set(localhostAllowedOrigins());
  for (const origin of cfg.http.corsOrigins) {
    try {
      hosts.add(new URL(origin).hostname);
    } catch {
      /* ignore malformed origin */
    }
  }
  for (const host of cfg.http.allowedHosts) hosts.add(host);
  return [...hosts];
}

function resourceMetadataUrl(cfg: NuvioConfig): string {
  return `http://${cfg.http.host}:${cfg.http.port}/.well-known/oauth-protected-resource`;
}

function protectedResourceMetadata(cfg: NuvioConfig): unknown {
  return {
    resource: `http://${cfg.http.host}:${cfg.http.port}${MCP_PATH}`,
    authorization_servers: cfg.oauth.issuer ? [cfg.oauth.issuer] : [],
    scopes_supported: cfg.oauth.scopes.length > 0 ? cfg.oauth.scopes : ['mcp'],
    bearer_methods_supported: ['header'],
    resource_name: 'Nuvio MCP',
    issuer: cfg.oauth.issuer ?? undefined,
  };
}

const METHODS_WITHOUT_BODY = new Set(['GET', 'HEAD', 'OPTIONS']);

type BodyRead = { ok: true; value: unknown } | { ok: false; status: number; message: string };

/** Reads at most `max` bytes from the request stream, aborting any larger body. */
function readBodyCapped(req: IncomingMessage, max: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: BodyRead) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > max) {
        req.pause();
        settle({ ok: false, status: 413, message: 'Request body too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return settle({ ok: true, value: undefined });
      try {
        settle({ ok: true, value: JSON.parse(raw) });
      } catch {
        settle({ ok: false, status: 400, message: 'Invalid JSON body' });
      }
    });
    req.on('error', () => settle({ ok: false, status: 400, message: 'Request stream error' }));
  });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !value) return null;
  return value;
}

function staticTokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function introspect(cfg: NuvioConfig, token: string): Promise<AuthInfo | null> {
  if (!cfg.oauth.introspectionUrl) return null;
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (cfg.oauth.clientId) {
    const basic = Buffer.from(`${cfg.oauth.clientId}:${cfg.oauth.clientSecret ?? ''}`).toString('base64');
    headers.Authorization = `Basic ${basic}`;
  }
  const res = await fetch(cfg.oauth.introspectionUrl, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ token, token_type_hint: 'access_token' }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { active?: boolean; scope?: string; client_id?: string; exp?: number };
  if (!data.active) return null;
  const scopes = (data.scope ?? '').split(' ').filter(Boolean);
  return {
    token,
    clientId: data.client_id ?? 'unknown',
    scopes: scopes.length > 0 ? scopes : ['mcp'],
    expiresAt: data.exp ?? Math.floor(Date.now() / 1000) + 300,
  };
}

async function authenticate(cfg: NuvioConfig, req: Request): Promise<AuthInfo | Response> {
  const token = bearerToken(req);
  const required = cfg.oauth.scopes;
  const challenge = (): Response =>
    jsonResponse(
      401,
      { jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null },
      { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadataUrl(cfg)}"` }
    );

  if (cfg.http.token) {
    if (!token || !staticTokenMatches(cfg.http.token, token)) return challenge();
    return {
      token,
      clientId: 'static-token',
      scopes: ['mcp'],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  if (cfg.oauth.introspectionUrl) {
    if (!token) return challenge();
    const info = await introspect(cfg, token).catch(() => null);
    if (!info) return challenge();
    if (required.length > 0 && !required.every((scope) => info.scopes.includes(scope))) {
      return jsonResponse(
        403,
        { jsonrpc: '2.0', error: { code: -32003, message: 'insufficient_scope' }, id: null },
        { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${required.join(' ')}"` }
      );
    }
    return info;
  }

  // No authentication configured. index.ts refuses to start a non-loopback endpoint this way.
  return { token: '', clientId: 'anonymous', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 };
}

function withGuards(
  cfg: NuvioConfig,
  handler: McpHttpHandler
): { fetch: (req: Request) => Promise<Response> } {
  const hostnames = allowedHostnames(cfg);
  const originHostnames = allowedOriginHostnames(cfg);
  return {
    fetch: async (req: Request): Promise<Response> => {
      const hostError = hostHeaderValidationResponse(req, hostnames);
      if (hostError) return hostError;
      const originError = originValidationResponse(req, originHostnames);
      if (originError) return originError;

      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return jsonResponse(200, { status: 'ok', version: VERSION, transport: 'http' });
      }
      if (METADATA_PATHS.includes(url.pathname)) {
        return jsonResponse(200, protectedResourceMetadata(cfg));
      }
      if (url.pathname !== MCP_PATH) {
        return jsonResponse(404, { error: `Not found. MCP endpoint is ${MCP_PATH}` });
      }

      const auth = await authenticate(cfg, req);
      if (auth instanceof Response) return auth;
      return handler.fetch(req, { authInfo: auth });
    },
  };
}

export function startHttpServer(cfg: NuvioConfig, client: NuvioClient): Promise<HttpHandle> {
  const handler = createMcpHandler(() => createMcpServer(client, cfg));
  const guarded = withGuards(cfg, handler);
  const nodeHandler = toNodeHandler(guarded as unknown as McpHttpHandler);

  let inFlight = 0;
  const nodeServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (inFlight >= cfg.http.maxConcurrency) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '1' });
      res.end(JSON.stringify({ error: 'Server busy' }));
      return;
    }
    inFlight += 1;
    res.on('close', () => {
      inFlight -= 1;
    });

    const method = req.method ?? 'GET';
    if (METHODS_WITHOUT_BODY.has(method)) {
      void nodeHandler(req, res, undefined);
      return;
    }
    void readBodyCapped(req, cfg.http.maxBodyBytes).then((body) => {
      if (!body.ok) {
        res.writeHead(body.status, { 'Content-Type': 'application/json', Connection: 'close' });
        // Discard the remainder instead of destroying the socket, so the client
        // reliably receives the status without the server buffering the body.
        req.resume();
        res.end(JSON.stringify({ error: body.message }));
        return;
      }
      void nodeHandler(req, res, body.value);
    });
  });

  nodeServer.requestTimeout = cfg.http.requestTimeoutMs;
  nodeServer.headersTimeout = Math.min(cfg.http.requestTimeoutMs, 60_000);
  nodeServer.keepAliveTimeout = 5_000;

  return new Promise((resolve, reject) => {
    nodeServer.on('error', reject);
    nodeServer.listen(cfg.http.port, cfg.http.host, () => {
      const auth = cfg.http.token
        ? 'static bearer token'
        : cfg.oauth.introspectionUrl
          ? 'oauth introspection'
          : 'NONE';
      process.stderr.write(
        `nuvio-mcp ${VERSION} listening on http://${cfg.http.host}:${cfg.http.port}${MCP_PATH} ` +
          `(stateless, auth: ${auth})\n`
      );
      resolve({
        port: cfg.http.port,
        close: async () => {
          await new Promise<void>((done) => nodeServer.close(() => done()));
          await handler.close();
        },
      });
    });
  });
}
