import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Two-phase confirmation for operations a snapshot cannot truly reverse
 * (delete profile, restore backup, revoke session, PIN changes, device registration).
 *
 * `prepare` returns a short-lived token bound to the exact tool name and arguments.
 * `execute` verifies the token (signature, tool, arguments, expiry, single use).
 *
 * The arguments are committed to the token as a SHA-256 hash, never in the clear:
 * confirmation tokens are returned to the caller, so embedding raw arguments would
 * leak secrets (e.g. a profile PIN) and could inflate the token with large backups.
 */
const TTL_MS = 5 * 60 * 1000;

interface TokenPayload {
  tool: string;
  argsHash: string;
  exp: number;
  nonce: string;
}

export class ConfirmationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmationError';
  }
}

export class ConfirmationGate {
  private readonly consumed = new Map<string, number>();

  constructor(private readonly secret: Buffer = defaultSecret()) {}

  private sign(data: string): string {
    return createHmac('sha256', this.secret).update(data).digest('base64url');
  }

  private prune(): void {
    const now = Date.now();
    for (const [nonce, exp] of this.consumed) if (exp <= now) this.consumed.delete(nonce);
  }

  /** Canonical, order-independent representation of the arguments a token is bound to. */
  static fingerprint(args: Record<string, unknown>): string {
    const relevant: Record<string, unknown> = {};
    for (const key of Object.keys(args).sort()) {
      if (key === 'confirm' || key === 'confirmation_token') continue;
      relevant[key] = args[key];
    }
    return JSON.stringify(relevant);
  }

  private hashArgs(args: Record<string, unknown>): string {
    return createHash('sha256').update(ConfirmationGate.fingerprint(args)).digest('hex');
  }

  prepare(tool: string, args: Record<string, unknown>): { token: string; expires_at: string } {
    this.prune();
    const payload: TokenPayload = {
      tool,
      argsHash: this.hashArgs(args),
      exp: Date.now() + TTL_MS,
      nonce: randomBytes(9).toString('base64url'),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return {
      token: `${body}.${this.sign(body)}`,
      expires_at: new Date(payload.exp).toISOString(),
    };
  }

  verify(tool: string, args: Record<string, unknown>, token: unknown): void {
    if (typeof token !== 'string' || !token.includes('.')) {
      throw new ConfirmationError('Missing confirmation_token. Call the tool without confirm to obtain one.');
    }
    const [body, signature] = token.split('.', 2);
    const expected = this.sign(body);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new ConfirmationError('Invalid confirmation token.');
    }
    let payload: TokenPayload;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    } catch {
      throw new ConfirmationError('Malformed confirmation token.');
    }
    if (payload.tool !== tool)
      throw new ConfirmationError('Confirmation token was issued for a different operation.');
    if (payload.argsHash !== this.hashArgs(args)) {
      throw new ConfirmationError('Confirmation token does not match these arguments.');
    }
    if (payload.exp <= Date.now())
      throw new ConfirmationError('Confirmation token has expired. Prepare the operation again.');
    this.prune();
    if (this.consumed.has(payload.nonce)) {
      throw new ConfirmationError('Confirmation token has already been used. Prepare the operation again.');
    }
    this.consumed.set(payload.nonce, payload.exp);
  }
}

function defaultSecret(): Buffer {
  const configured = process.env.NUVIO_CONFIRM_SECRET;
  if (configured && configured.length >= 16) return Buffer.from(configured);
  // Per-process random secret: tokens remain valid for this process only.
  return randomBytes(32);
}
