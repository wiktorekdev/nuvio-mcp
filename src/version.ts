import { readFileSync } from 'node:fs';

/** Single source of truth for the server version, read from package.json. */
export function resolveVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = resolveVersion();
