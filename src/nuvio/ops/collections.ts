import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
import type { ApplyResult, Collection, CollectionFolder, CollectionsBlob } from '../types.js';

export async function getCollections(client: NuvioClient, profileId: number): Promise<Collection[]> {
  const rows = await client.readRpc<CollectionsBlob[]>('sync_pull_collections', { p_profile_id: profileId });
  return rows[0]?.collections_json ?? [];
}

function assertUniqueIds(collections: Collection[]): void {
  const ids = new Set<string>();
  for (const c of collections) {
    if (!c.id) throw new NuvioError('Every collection needs an id');
    if (ids.has(c.id)) throw new NuvioError(`Duplicate collection id: ${c.id}`);
    ids.add(c.id);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function diffCollections(before: Collection[], after: Collection[]): string[] {
  const b = new Map(before.map((c) => [c.id, c]));
  const a = new Map(after.map((c) => [c.id, c]));
  const diff: string[] = [];
  for (const [id, c] of a) {
    const prev = b.get(id);
    if (!prev) diff.push(`+ collection "${c.title}" (${id})`);
    else if (JSON.stringify(canonical(prev)) !== JSON.stringify(canonical(c))) {
      diff.push(`~ collection ${id} updated`);
    }
  }
  for (const id of b.keys()) if (!a.has(id)) diff.push(`- collection ${id}`);
  if (before.map((c) => c.id).join('|') !== after.map((c) => c.id).join('|')) {
    diff.push('~ collection order changed');
  }
  return diff.sort();
}

async function commit(
  client: NuvioClient,
  profileId: number,
  originId: string,
  before: Collection[],
  after: Collection[],
  apply: boolean
): Promise<ApplyResult<Collection[]>> {
  const diff = diffCollections(before, after);
  if (apply && diff.length > 0) {
    await client.rpc('sync_push_collections', {
      p_profile_id: profileId,
      p_collections_json: after,
      p_origin_client_id: originId,
    });
  }
  return { applied: apply && diff.length > 0, changed: diff.length > 0, before, after, diff };
}

export async function createCollection(
  client: NuvioClient,
  profileId: number,
  collection: Collection,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Collection[]>> {
  const before = await getCollections(client, profileId);
  if (before.some((c) => c.id === collection.id)) {
    throw new NuvioError(`A collection with id "${collection.id}" already exists`);
  }
  const after = [...before, collection];
  assertUniqueIds(after);
  return commit(client, profileId, originId, before, after, apply);
}

export async function updateCollection(
  client: NuvioClient,
  profileId: number,
  collectionId: string,
  changes: Partial<Omit<Collection, 'id'>>,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Collection[]>> {
  const before = await getCollections(client, profileId);
  const target = before.find((c) => c.id === collectionId);
  if (!target) throw new NuvioError(`Collection "${collectionId}" not found`);
  const after = before.map((c) => (c.id === collectionId ? { ...c, ...changes } : c));
  assertUniqueIds(after);
  return commit(client, profileId, originId, before, after, apply);
}

export async function deleteCollection(
  client: NuvioClient,
  profileId: number,
  collectionId: string,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Collection[]>> {
  const before = await getCollections(client, profileId);
  if (!before.some((c) => c.id === collectionId))
    throw new NuvioError(`Collection "${collectionId}" not found`);
  const after = before.filter((c) => c.id !== collectionId);
  if (after.length !== before.length - 1)
    throw new NuvioError('Internal invariant failed (collection delete)');
  return commit(client, profileId, originId, before, after, apply);
}

export async function addFolder(
  client: NuvioClient,
  profileId: number,
  collectionId: string,
  folder: CollectionFolder,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Collection[]>> {
  const before = await getCollections(client, profileId);
  const target = before.find((c) => c.id === collectionId);
  if (!target) throw new NuvioError(`Collection "${collectionId}" not found`);
  if (target.folders.some((f) => f.id === folder.id))
    throw new NuvioError(`Folder "${folder.id}" already exists in collection "${collectionId}"`);
  const after = before.map((c) => (c.id === collectionId ? { ...c, folders: [...c.folders, folder] } : c));
  return commit(client, profileId, originId, before, after, apply);
}

export async function updateFolder(
  client: NuvioClient,
  profileId: number,
  collectionId: string,
  folderId: string,
  changes: Partial<Omit<CollectionFolder, 'id'>>,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Collection[]>> {
  const before = await getCollections(client, profileId);
  const target = before.find((c) => c.id === collectionId);
  if (!target) throw new NuvioError(`Collection "${collectionId}" not found`);
  if (!target.folders.some((f) => f.id === folderId))
    throw new NuvioError(`Folder "${folderId}" not found in collection "${collectionId}"`);
  const after = before.map((c) =>
    c.id === collectionId
      ? { ...c, folders: c.folders.map((f) => (f.id === folderId ? { ...f, ...changes } : f)) }
      : c
  );
  return commit(client, profileId, originId, before, after, apply);
}

export async function removeFolder(
  client: NuvioClient,
  profileId: number,
  collectionId: string,
  folderId: string,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Collection[]>> {
  const before = await getCollections(client, profileId);
  const target = before.find((c) => c.id === collectionId);
  if (!target) throw new NuvioError(`Collection "${collectionId}" not found`);
  const nextFolders = target.folders.filter((f) => f.id !== folderId);
  if (nextFolders.length !== target.folders.length - 1)
    throw new NuvioError(`Folder "${folderId}" not found in collection "${collectionId}"`);
  const after = before.map((c) => (c.id === collectionId ? { ...c, folders: nextFolders } : c));
  return commit(client, profileId, originId, before, after, apply);
}

export async function reorderCollections(
  client: NuvioClient,
  profileId: number,
  orderedIds: string[],
  originId: string,
  apply: boolean
): Promise<ApplyResult<Collection[]>> {
  const before = await getCollections(client, profileId);
  const current = before.map((c) => c.id).sort();
  const wanted = [...orderedIds].sort();
  if (current.length !== wanted.length || current.some((id, i) => id !== wanted[i])) {
    throw new NuvioError('Reorder must list every collection id exactly once.');
  }
  const after = orderedIds.map((id) => before.find((c) => c.id === id)!);
  return commit(client, profileId, originId, before, after, apply);
}

export async function duplicateCollection(
  client: NuvioClient,
  profileId: number,
  collectionId: string,
  newId: string,
  newTitle: string | undefined,
  originId: string,
  apply: boolean
): Promise<ApplyResult<Collection[]>> {
  const before = await getCollections(client, profileId);
  const source = before.find((c) => c.id === collectionId);
  if (!source) throw new NuvioError(`Collection "${collectionId}" not found`);
  if (before.some((c) => c.id === newId)) throw new NuvioError(`Collection "${newId}" already exists`);
  const copy = structuredClone(source);
  copy.id = newId;
  copy.title = newTitle ?? `${source.title} (copy)`;
  copy.folders = copy.folders.map((f) => ({ ...f, id: `${newId}-${f.id}` }));
  const index = before.findIndex((c) => c.id === collectionId);
  const after = [...before.slice(0, index + 1), copy, ...before.slice(index + 1)];
  return commit(client, profileId, originId, before, after, apply);
}

export async function reorderCollectionFolders(
  client: NuvioClient,
  profileId: number,
  collectionId: string,
  orderedFolderIds: string[],
  originId: string,
  apply: boolean
): Promise<ApplyResult<Collection[]>> {
  const before = await getCollections(client, profileId);
  const target = before.find((c) => c.id === collectionId);
  if (!target) throw new NuvioError(`Collection "${collectionId}" not found`);
  const current = target.folders.map((f) => f.id).sort();
  const wanted = [...orderedFolderIds].sort();
  if (current.length !== wanted.length || current.some((id, i) => id !== wanted[i])) {
    throw new NuvioError('Reorder must list every folder id exactly once.');
  }
  const after = before.map((c) =>
    c.id === collectionId
      ? { ...c, folders: orderedFolderIds.map((id) => target.folders.find((f) => f.id === id)!) }
      : c
  );
  return commit(client, profileId, originId, before, after, apply);
}
