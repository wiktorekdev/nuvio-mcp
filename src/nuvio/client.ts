import type { NuvioConfig } from '../config.js';
import { AuthManager } from './auth.js';
import { callCache } from './call-context.js';
import { errorFromResponse, NuvioError } from './errors.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Extra query string (already encoded) appended after the path. */
  query?: string;
  /** Skip the automatic 401-refresh retry (used by auth endpoints). */
  noRetry?: boolean;
  /**
   * Cache the response for the duration of the current MCP call. Set by every
   * read so a mutation that snapshots a resource and then reads it again only
   * performs one backend request.
   */
  cache?: boolean;
  /**
   * Marks the request as intrinsically safe to repeat. This — and only this —
   * decides whether a failed write may be retried. Reads are idempotent by
   * default (GET/HEAD); a POST RPC must opt in. Non-idempotent writes are never
   * retried automatically.
   */
  idempotent?: boolean;
  /**
   * Optional correlation header (Idempotency-Key) for observability. The hosted
   * backend does NOT implement deduplication, so this header is informational
   * only and must never be treated as a retry guarantee.
   */
  requestId?: string;
}

/** Transient statuses worth retrying (reads, and writes that opted into idempotency). */
const RETRY_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 400;
const MAX_RETRY_DELAY_MS = 10_000;
const MAX_RETRY_AFTER_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function backoffMs(attempt: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

/**
 * Thin, typed wrapper over the Nuvio backend (Supabase: PostgREST + GoTrue).
 *
 * Retry policy:
 * - reads (and explicitly idempotent requests): retry network errors, 408, 429,
 *   500, 502, 503, 504 with exponential backoff + Retry-After;
 * - non-idempotent writes: never retried automatically (a lost response must not
 *   silently double-apply a mutation);
 * - 401: a single transparent token refresh, then one retry.
 */
export class NuvioClient {
  constructor(
    private readonly cfg: NuvioConfig,
    private readonly auth: AuthManager
  ) {}

  private async send(path: string, options: RequestOptions, token: string): Promise<Response> {
    const url = `${this.cfg.backendUrl}${path}${options.query ? `?${options.query}` : ''}`;
    const headers: Record<string, string> = {
      apikey: this.cfg.publishableKey,
      Authorization: `Bearer ${token}`,
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.requestId) headers['Idempotency-Key'] = options.requestId;
    return fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(this.cfg.backendTimeoutMs),
    });
  }

  private async sendWithRetry(path: string, options: RequestOptions, token: string): Promise<Response> {
    const method = options.method ?? 'GET';
    // Retry is driven purely by the operation's intrinsic idempotency. An
    // Idempotency-Key is never sufficient on its own: the backend does not dedupe.
    const idempotent = options.idempotent ?? method === 'GET';
    let attempt = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.send(path, options, token);
      } catch (error) {
        if (idempotent && !options.noRetry && attempt < MAX_RETRIES) {
          await sleep(backoffMs(attempt));
          attempt += 1;
          continue;
        }
        throw error;
      }
      if (idempotent && !options.noRetry && RETRY_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(res, attempt));
        attempt += 1;
        continue;
      }
      return res;
    }
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    if (!options.cache) return this.execute<T>(path, options);
    const method = options.method ?? 'GET';
    const key =
      `${method} ${path}${options.query ? `?${options.query}` : ''}` +
      `${options.body === undefined ? '' : ` ${JSON.stringify(options.body)}`}`;
    return callCache(key, () => this.execute<T>(path, options));
  }

  private async execute<T>(path: string, options: RequestOptions): Promise<T> {
    let token = await this.auth.getAccessToken();
    let res = await this.sendWithRetry(path, options, token);

    if (res.status === 401 && !options.noRetry) {
      await this.auth.forceRefresh();
      token = await this.auth.getAccessToken();
      res = await this.sendWithRetry(path, options, token);
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const json = text ? safeJson(text) : null;

    if (!res.ok) throw errorFromResponse(res.status, json ?? text);
    return json as T;
  }

  /** Call a PostgREST RPC function (a write unless the caller opts into read semantics). */
  async rpc<T>(name: string, args: Record<string, unknown> = {}, options: RequestOptions = {}): Promise<T> {
    return this.request<T>(`/rest/v1/rpc/${name}`, { method: 'POST', body: args, ...options });
  }

  /** A read-only RPC: cached per call and retried safely when transient. */
  async readRpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.rpc<T>(name, args, { cache: true, idempotent: true });
  }

  /** Query a PostgREST table. Reads are cached and retried by default. */
  async select<T>(table: string, params = 'select=*'): Promise<T> {
    return this.request<T>(`/rest/v1/${table}`, { query: params, cache: true, idempotent: true });
  }

  get backendUrl(): string {
    return this.cfg.backendUrl;
  }

  get currentUserId(): string | undefined {
    return this.auth.userId;
  }

  get currentEmail(): string | undefined {
    return this.auth.email;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export { NuvioError };
