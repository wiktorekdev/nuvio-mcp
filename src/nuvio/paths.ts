const UNSAFE_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function assertSafeSegment(segment: string): void {
  if (UNSAFE_SEGMENTS.has(segment)) {
    throw new Error(`Unsafe path segment: ${segment}`);
  }
}

function isSafeSegment(segment: string): boolean {
  return !UNSAFE_SEGMENTS.has(segment);
}

export function setPath(
  root: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('Setting path cannot be empty');
  const out = structuredClone(root) as Record<string, unknown>;
  let cursor: Record<string, unknown> | unknown[] = out;

  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    assertSafeSegment(key);
    const nextIsIndex = /^\d+$/.test(parts[i + 1]);
    const container = cursor as Record<string, unknown>;
    const existing = Array.isArray(cursor) ? cursor[Number(key)] : container[key];
    if (existing === undefined || existing === null || typeof existing !== 'object') {
      const created: Record<string, unknown> | unknown[] = nextIsIndex ? [] : {};
      if (Array.isArray(cursor)) cursor[Number(key)] = created;
      else container[key] = created;
      cursor = created;
    } else {
      cursor = existing as Record<string, unknown> | unknown[];
    }
  }

  const last = parts[parts.length - 1];
  assertSafeSegment(last);
  if (Array.isArray(cursor) && /^\d+$/.test(last)) cursor[Number(last)] = value;
  else (cursor as Record<string, unknown>)[last] = value;
  return out;
}

export function unsetPath(root: Record<string, unknown>, path: string): Record<string, unknown> {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) throw new Error('Setting path cannot be empty');
  const out = structuredClone(root) as Record<string, unknown>;
  let cursor: Record<string, unknown> | unknown[] = out;

  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    assertSafeSegment(key);
    const existing = Array.isArray(cursor) ? cursor[Number(key)] : (cursor as Record<string, unknown>)[key];
    if (existing === undefined || existing === null || typeof existing !== 'object') return out;
    cursor = existing as Record<string, unknown> | unknown[];
  }

  const last = parts[parts.length - 1];
  assertSafeSegment(last);
  if (Array.isArray(cursor) && /^\d+$/.test(last)) cursor.splice(Number(last), 1);
  else delete (cursor as Record<string, unknown>)[last];
  return out;
}

export function getPath(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const key of path.split('.').filter(Boolean)) {
    if (!isSafeSegment(key)) return undefined;
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = Array.isArray(cursor) ? cursor[Number(key)] : (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}
