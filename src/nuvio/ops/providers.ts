import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
import type { ApplyResult } from '../types.js';

/** Provider credential layouts accepted by the backend. */
export const PROVIDER_CREDENTIAL_FIELD: Record<string, string> = {
  'debrid:torbox': 'api_key',
  'debrid:premiumize': 'api_key',
  'debrid:realdebrid': 'api_key',
  tmdb: 'api_key',
  mdblist: 'api_key',
  introdb: 'api_key',
  animeskip: 'client_id',
};

export interface ProviderCredential {
  provider: string;
  credential_json: Record<string, unknown>;
  updated_at?: string;
}

export async function listProviderCredentials(
  client: NuvioClient,
  profileId: number
): Promise<ProviderCredential[]> {
  return client.rpc<ProviderCredential[]>('sync_pull_provider_credentials', { p_profile_id: profileId });
}

function normalizeProvider(provider: string): { provider: string; field: string } {
  const key = provider.trim().toLowerCase();
  const field = PROVIDER_CREDENTIAL_FIELD[key];
  if (!field) {
    throw new NuvioError(
      `Unsupported provider "${provider}". Supported: ${Object.keys(PROVIDER_CREDENTIAL_FIELD).join(', ')}`
    );
  }
  return { provider: key, field };
}

export async function setProviderCredential(
  client: NuvioClient,
  profileId: number,
  provider: string,
  value: string,
  originId: string,
  apply: boolean
): Promise<ApplyResult<ProviderCredential[]>> {
  const { provider: key, field } = normalizeProvider(provider);
  if (!value.trim()) throw new NuvioError('Credential value cannot be empty');
  const before = await listProviderCredentials(client, profileId);
  const credential_json = { [field]: value.trim() };
  const exists = before.some((c) => c.provider === key);
  const after = exists
    ? before.map((c) => (c.provider === key ? { ...c, credential_json } : c))
    : [...before, { provider: key, credential_json }];
  const diff = [exists ? `~ update credential for ${key}` : `+ add credential for ${key}`];

  if (apply) {
    await client.rpc('sync_push_provider_credentials', {
      p_profile_id: profileId,
      p_credentials: [{ provider: key, credential_json }],
      p_origin_client_id: originId,
    });
  }
  return { applied: apply, changed: true, before, after, diff };
}

export async function deleteProviderCredential(
  client: NuvioClient,
  profileId: number,
  provider: string,
  originId: string,
  apply: boolean
): Promise<ApplyResult<ProviderCredential[]>> {
  const { provider: key } = normalizeProvider(provider);
  const before = await listProviderCredentials(client, profileId);
  if (!before.some((c) => c.provider === key)) {
    throw new NuvioError(`No credential stored for provider "${key}" on profile ${profileId}`);
  }
  const after = before.filter((c) => c.provider !== key);
  if (apply) {
    await client.rpc('sync_delete_provider_credentials', {
      p_profile_id: profileId,
      p_provider: key,
      p_origin_client_id: originId,
    });
  }
  return { applied: apply, changed: true, before, after, diff: [`- remove credential for ${key}`] };
}
