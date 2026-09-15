export interface NuvioErrorOptions {
  status?: number;
  code?: string;
  details?: unknown;
  hint?: string | null;
}

/** Error thrown for any non-2xx response from the Nuvio / Supabase API. */
export class NuvioError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly hint?: string | null;

  constructor(message: string, options: NuvioErrorOptions = {}) {
    super(message);
    this.name = 'NuvioError';
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.hint = options.hint;
  }

  toHuman(): string {
    const parts = [this.message];
    if (this.code) parts.push(`(code: ${this.code})`);
    if (this.status) parts.push(`[http ${this.status}]`);
    if (this.hint) parts.push(`hint: ${this.hint}`);
    return parts.join(' ');
  }
}

/** Parse an error body from PostgREST / GoTrue. */
export function errorFromResponse(status: number, body: unknown): NuvioError {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const message =
      (typeof b.message === 'string' && b.message) ||
      (typeof b.msg === 'string' && b.msg) ||
      (typeof b.error_description === 'string' && b.error_description) ||
      (typeof b.error === 'string' && b.error) ||
      `Request failed with status ${status}`;
    return new NuvioError(message, {
      status,
      code: typeof b.code === 'string' ? b.code : typeof b.error === 'string' ? b.error : undefined,
      details: b.details,
      hint: typeof b.hint === 'string' ? b.hint : null,
    });
  }
  return new NuvioError(`Request failed with status ${status}`, { status });
}
