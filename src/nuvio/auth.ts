import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NuvioError, errorFromResponse } from './errors.js';

export interface AuthConfig {
  backendUrl: string;
  publishableKey: string;
  email?: string;
  password?: string;
  refreshToken?: string;
  sessionFile: string;
  timeoutMs?: number;
}

interface SessionFile {
  backendUrl: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  userId?: string;
  email?: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  user?: { id?: string; email?: string };
}

const REFRESH_SKEW_SECONDS = 60;

/**
 * Owns the Nuvio session: signs in, persists the refresh token, and transparently
 * refreshes the short-lived access token.
 */
export class AuthManager {
  private session: SessionFile;

  constructor(private readonly cfg: AuthConfig) {
    this.session = { backendUrl: cfg.backendUrl };
    this.load();
  }

  private load(): void {
    if (!existsSync(this.cfg.sessionFile)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.cfg.sessionFile, 'utf8')) as SessionFile;
      if (parsed.backendUrl !== this.cfg.backendUrl) return; // session belongs to a different backend
      this.session = parsed;
    } catch {
      /* ignore corrupt session file */
    }
  }

  private persist(): void {
    const target = this.cfg.sessionFile;
    const tmp = `${target}.tmp`;
    try {
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, JSON.stringify(this.session, null, 2), { mode: 0o600 });
      renameSync(tmp, target);
    } catch {
      /* session persistence is best-effort; the in-memory session still works */
    }
  }

  get userId(): string | undefined {
    return this.session.userId;
  }

  get email(): string | undefined {
    return this.session.email ?? this.cfg.email;
  }

  clear(): void {
    this.session = { backendUrl: this.cfg.backendUrl };
    this.persist();
  }

  private capture(token: TokenResponse): void {
    this.session.accessToken = token.access_token;
    if (token.refresh_token) this.session.refreshToken = token.refresh_token;
    const expiresAt =
      token.expires_at ?? (token.expires_in ? Math.floor(Date.now() / 1000) + token.expires_in : undefined);
    this.session.expiresAt = expiresAt;
    if (token.user?.id) this.session.userId = token.user.id;
    if (token.user?.email) this.session.email = token.user.email;
    this.persist();
  }

  private async postToken(query: string, body: Record<string, unknown>): Promise<TokenResponse> {
    const res = await fetch(`${this.cfg.backendUrl}/auth/v1/token?grant_type=${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: this.cfg.publishableKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw errorFromResponse(res.status, json);
    return json as TokenResponse;
  }

  async signInWithPassword(): Promise<void> {
    if (!this.cfg.email || !this.cfg.password) {
      throw new NuvioError(
        'No session available and NUVIO_EMAIL / NUVIO_PASSWORD (or NUVIO_REFRESH_TOKEN) are not set.'
      );
    }
    const token = await this.postToken('password', {
      email: this.cfg.email,
      password: this.cfg.password,
    });
    this.capture(token);
  }

  private async refresh(): Promise<void> {
    const refreshToken = this.session.refreshToken ?? this.cfg.refreshToken;
    if (!refreshToken) throw new NuvioError('Session expired and no refresh token is available.');
    const token = await this.postToken('refresh_token', { refresh_token: refreshToken });
    this.capture(token);
  }

  /** Force a refresh (used after a 401 from the API). */
  async forceRefresh(): Promise<void> {
    await this.refresh();
  }

  /** Returns a valid bearer token, signing in or refreshing as needed. */
  async getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const token = this.session.accessToken;
    const expiring = !this.session.expiresAt || this.session.expiresAt - REFRESH_SKEW_SECONDS <= now;

    if (token && !expiring) return token;

    if (this.session.refreshToken || this.cfg.refreshToken) {
      try {
        await this.refresh();
      } catch (error) {
        // A rotated/expired refresh token falls back to password auth if we have it.
        if (!this.cfg.email || !this.cfg.password) throw error;
        await this.signInWithPassword();
      }
    } else {
      await this.signInWithPassword();
    }
    return this.session.accessToken!;
  }
}
