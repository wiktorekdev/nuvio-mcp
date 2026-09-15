import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
import type { ApplyResult } from '../types.js';
import { fetchJsonFromPublicUrl } from '../safe-fetch.js';

export interface ProviderTestResult {
  provider: string;
  /** Whether the value has the expected shape for this provider. */
  format_valid: boolean;
  /** Live verification result, or null when the provider cannot be checked offline. */
  verified: boolean | null;
  detail: string;
}

function looksLikeKey(value: string): boolean {
  const v = value.trim();
  return v.length >= 8 && v.length <= 200 && !/\s/.test(v);
}

/** Provider endpoints that can validate a key with a cheap read. */
const LIVE_CHECKS: Record<string, (key: string) => string> = {
  tmdb: (key) => `https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(key)}`,
  mdblist: (key) => `https://mdblist.com/api/?apikey=${encodeURIComponent(key)}`,
};

/**
 * Verify a provider credential WITHOUT storing it. Never returns or logs the
 * secret itself. Live checks are best-effort and only run for providers with a
 * cheap public endpoint; others report format validation only.
 */
export async function testProviderCredential(provider: string, value: string): Promise<ProviderTestResult> {
  const key = provider.trim().toLowerCase();
  if (!PROVIDER_CREDENTIAL_FIELD[key]) {
    throw new NuvioError(
      `Unsupported provider "${provider}". Supported: ${Object.keys(PROVIDER_CREDENTIAL_FIELD).join(', ')}`
    );
  }
  if (!value.trim())
    return { provider: key, format_valid: false, verified: false, detail: 'Credential is empty.' };
  const formatValid = looksLikeKey(value);
  if (!formatValid) {
    return { provider: key, format_valid: false, verified: false, detail: 'Credential looks malformed.' };
  }
  const check = LIVE_CHECKS[key];
  if (!check) {
    return {
      provider: key,
      format_valid: true,
      verified: null,
      detail: 'Format accepted; this provider cannot be verified without a live call.',
    };
  }
  try {
    await fetchJsonFromPublicUrl(check(value.trim()));
    return { provider: key, format_valid: true, verified: true, detail: 'Provider accepted the credential.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Do not echo the secret; the message comes from the HTTP layer only.
    return { provider: key, format_valid: true, verified: false, detail: `Verification failed: ${message}` };
  }
}

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
  return client.readRpc<ProviderCredential[]>('sync_pull_provider_credentials', { p_profile_id: profileId });
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
