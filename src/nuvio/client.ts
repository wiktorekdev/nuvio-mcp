import type { NuvioConfig } from '../config.js';
import { AuthManager } from './auth.js';
import { errorFromResponse, NuvioError } from './errors.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Extra query string (already encoded) appended after the path. */
  query?: string;
  /** Skip the automatic 401-refresh retry (used by auth endpoints). */
  noRetry?: boolean;
}

/**
 * Thin, typed wrapper over the Nuvio backend (Supabase: PostgREST + GoTrue).
 * Handles auth headers and a single transparent token-refresh retry on 401.
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
    return fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    let token = await this.auth.getAccessToken();
    let res = await this.send(path, options, token);

    if (res.status === 401 && !options.noRetry) {
      await this.auth.forceRefresh();
      token = await this.auth.getAccessToken();
      res = await this.send(path, options, token);
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    const json = text ? safeJson(text) : null;

    if (!res.ok) throw errorFromResponse(res.status, json ?? text);
    return json as T;
  }

  /** Call a PostgREST RPC function. */
  async rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.request<T>(`/rest/v1/rpc/${name}`, { method: 'POST', body: args });
  }

  /** Query a PostgREST table. `params` is the raw PostgREST query string. */
  async select<T>(table: string, params = 'select=*'): Promise<T> {
    return this.request<T>(`/rest/v1/${table}`, { query: params });
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
