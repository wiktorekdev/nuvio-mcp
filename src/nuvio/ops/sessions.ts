import { NuvioError } from '../errors.js';
import type { NuvioClient } from '../client.js';
import type { ApplyResult, Session } from '../types.js';

export async function listSessions(client: NuvioClient): Promise<Session[]> {
  return client.rpc<Session[]>('list_my_sessions', {});
}

export async function revokeSession(
  client: NuvioClient,
  sessionId: string,
  apply: boolean
): Promise<ApplyResult<Session>> {
  const sessions = await listSessions(client);
  const target = sessions.find((s) => s.session_id === sessionId);
  if (!target) throw new NuvioError(`Session ${sessionId} not found`);
  const diff = [`- session ${sessionId} (${target.device_name ?? target.client_name ?? 'unknown device'})`];
  if (target.is_current) {
    diff.push('! this is the session used by the MCP itself; revoking it will require a new sign-in');
  }
  if (apply) {
    await client.rpc('revoke_my_session', { p_session_id: sessionId });
  }
  return { applied: apply, changed: true, before: target, after: target, diff };
}

export async function registerDevice(
  client: NuvioClient,
  device: {
    installation_id: string;
    client_name: string;
    client_version?: string;
    device_name?: string;
    platform?: string;
  },
  apply: boolean
): Promise<ApplyResult<Record<string, unknown>>> {
  if (apply) {
    await client.rpc('register_current_device', {
      p_installation_id: device.installation_id,
      p_client_name: device.client_name,
      p_client_version: device.client_version ?? '',
      p_device_name: device.device_name ?? '',
      p_platform: device.platform ?? '',
    });
  }
  return {
    applied: apply,
    changed: true,
    before: {},
    after: device as unknown as Record<string, unknown>,
    diff: [`~ register device ${device.device_name ?? device.client_name}`],
  };
}
