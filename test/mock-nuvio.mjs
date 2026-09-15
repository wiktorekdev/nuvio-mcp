// In-memory Nuvio backend used by the test suite. Mirrors the RPCs/tables the MCP talks to.
import { createServer } from 'node:http';

const now = () => new Date().toISOString();

function seed() {
  return {
    profiles: [
      {
        profile_index: 1,
        name: 'Main',
        avatar_color_hex: '#1E88E5',
        uses_primary_addons: false,
        uses_primary_plugins: false,
        avatar_id: null,
        avatar_url: null,
      },
    ],
    addons: { 1: [{ url: 'https://example.com/a/manifest.json', name: 'A', enabled: true, sort_order: 0 }] },
    plugins: { 1: [] },
    settings: {
      '1:tv': {
        settings_json: { theme: 'dark', features: { player_settings: { auto_play_next: true } } },
        updated_at: now(),
      },
    },
    home: {},
    collections: { 1: [] },
    library: { 1: [] },
    progress: { 1: [] },
    history: { 1: [] },
    providers: { 1: [] },
    trackerTokens: { 1: [] },
    trackerSettings: { 1: [] },
    sessions: [
      {
        session_id: '00000000-0000-4000-8000-000000000001',
        client_name: 'Nuvio Web',
        device_name: 'Chrome',
        is_current: false,
      },
      {
        session_id: '00000000-0000-4000-8000-000000000002',
        client_name: 'nuvio-mcp',
        device_name: 'MCP',
        is_current: true,
      },
    ],
  };
}

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

export function startMockNuvio() {
  const store = seed();

  const rpc = {
    sync_pull_profiles: () => store.profiles,
    // Deliberately mimics the hosted backend: pushes never delete omitted profiles.
    sync_push_profiles: (a) => {
      for (const p of a.p_profiles ?? []) {
        const existing = store.profiles.find((x) => x.profile_index === p.profile_index);
        if (existing) Object.assign(existing, p);
        else store.profiles.push({ ...p });
      }
      return undefined;
    },
    sync_patch_profile: (a) => {
      const p = store.profiles.find((x) => x.profile_index === a.p_profile_id);
      if (!p) throw { status: 404, message: 'Profile not found' };
      for (const key of [
        'name',
        'avatar_color_hex',
        'uses_primary_addons',
        'uses_primary_plugins',
        'avatar_id',
        'avatar_url',
      ]) {
        if (a[`p_${key}`] !== undefined && a[`p_${key}`] !== null) p[key] = a[`p_${key}`];
      }
      return undefined;
    },
    sync_delete_profile_data: (a) => {
      store.profiles = store.profiles.filter((x) => x.profile_index !== a.p_profile_id);
      delete store.addons[a.p_profile_id];
      delete store.collections[a.p_profile_id];
      return undefined;
    },
    sync_push_addons: (a) => {
      const existing = store.addons[a.p_profile_id] ?? [];
      const byUrl = new Map(existing.map((x) => [x.url, x]));
      store.addons[a.p_profile_id] = (a.p_addons ?? []).map((x) => ({ ...byUrl.get(x.url), ...x }));
      return undefined;
    },
    sync_push_plugins: (a) => {
      store.plugins[a.p_profile_id] = a.p_plugins ?? [];
      return undefined;
    },
    sync_pull_profile_settings_blob: (a) => {
      const row = store.settings[`${a.p_profile_id}:${a.p_platform}`];
      return row
        ? [{ profile_id: a.p_profile_id, settings_json: row.settings_json, updated_at: row.updated_at }]
        : [];
    },
    sync_push_profile_settings_blob: (a) => {
      store.settings[`${a.p_profile_id}:${a.p_platform}`] = {
        settings_json: a.p_settings_json,
        updated_at: now(),
      };
      return undefined;
    },
    sync_push_profile_settings_blob_guarded: (a) => {
      const row = store.settings[`${a.p_profile_id}:${a.p_platform}`];
      if (row && row.updated_at !== a.p_expected_updated_at) {
        throw { status: 400, code: '40001', message: 'Settings changed on another device.' };
      }
      store.settings[`${a.p_profile_id}:${a.p_platform}`] = {
        settings_json: a.p_settings_json,
        updated_at: now(),
      };
      return now();
    },
    sync_pull_home_catalog_settings: (a) => {
      const row = store.home[`${a.p_profile_id}:${a.p_platform}`];
      return row ? [{ ...row, profile_id: a.p_profile_id, platform: a.p_platform }] : [];
    },
    sync_push_home_catalog_settings: (a) => {
      store.home[`${a.p_profile_id}:${a.p_platform}`] = {
        settings_json: a.p_settings_json,
        updated_at: now(),
      };
      return undefined;
    },
    sync_pull_collections: (a) => [
      {
        profile_id: a.p_profile_id,
        collections_json: store.collections[a.p_profile_id] ?? [],
        updated_at: now(),
      },
    ],
    sync_push_collections: (a) => {
      store.collections[a.p_profile_id] = a.p_collections_json ?? [];
      return undefined;
    },
    sync_pull_library: (a) =>
      (store.library[a.p_profile_id] ?? []).slice(a.p_offset ?? 0, (a.p_offset ?? 0) + (a.p_limit ?? 100)),
    sync_push_library_items: (a) => {
      const list = store.library[a.p_profile_id] ?? [];
      for (const item of a.p_items ?? []) {
        const idx = list.findIndex(
          (x) => x.content_id === item.content_id && x.content_type === item.content_type
        );
        if (idx >= 0) list[idx] = { ...list[idx], ...item };
        else list.push({ ...item });
      }
      store.library[a.p_profile_id] = list;
      return undefined;
    },
    sync_delete_library_items: (a) => {
      const keys = new Set((a.p_keys ?? []).map((k) => `${k.content_type}:${k.content_id}`));
      store.library[a.p_profile_id] = (store.library[a.p_profile_id] ?? []).filter(
        (x) => !keys.has(`${x.content_type}:${x.content_id}`)
      );
      return undefined;
    },
    sync_pull_watch_progress: (a) => (store.progress[a.p_profile_id] ?? []).slice(0, a.p_limit ?? 100),
    sync_push_watch_progress: (a) => {
      const keyOf = (x) =>
        x.progress_key ??
        (x.season != null ? `${x.content_id}_s${x.season}e${x.episode}` : String(x.content_id));
      const list = store.progress[a.p_profile_id] ?? [];
      for (const item of a.p_entries ?? []) {
        const key = keyOf(item);
        const idx = list.findIndex((x) => keyOf(x) === key);
        const row = { ...item, progress_key: key };
        if (idx >= 0) list[idx] = { ...list[idx], ...row };
        else list.push(row);
      }
      store.progress[a.p_profile_id] = list;
      return undefined;
    },
    sync_delete_watch_progress: (a) => {
      const keyOf = (x) =>
        x.progress_key ??
        (x.season != null ? `${x.content_id}_s${x.season}e${x.episode}` : String(x.content_id));
      const keys = new Set(a.p_keys ?? []);
      store.progress[a.p_profile_id] = (store.progress[a.p_profile_id] ?? []).filter(
        (x) => !keys.has(keyOf(x))
      );
      return undefined;
    },
    sync_pull_watched_items: (a) => (store.history[a.p_profile_id] ?? []).slice(0, a.p_page_size ?? 100),
    sync_push_watched_items: (a) => {
      const list = store.history[a.p_profile_id] ?? [];
      for (const item of a.p_items ?? []) {
        const idx = list.findIndex(
          (x) =>
            x.content_id === item.content_id &&
            (x.season ?? -1) === (item.season ?? -1) &&
            (x.episode ?? -1) === (item.episode ?? -1)
        );
        if (idx >= 0) list[idx] = { ...list[idx], ...item };
        else list.push({ ...item });
      }
      store.history[a.p_profile_id] = list;
      return undefined;
    },
    sync_delete_watched_items: (a) => {
      const keys = new Set(
        (a.p_keys ?? []).map((k) => `${k.content_id}|${k.season ?? -1}|${k.episode ?? -1}`)
      );
      store.history[a.p_profile_id] = (store.history[a.p_profile_id] ?? []).filter(
        (x) => !keys.has(`${x.content_id}|${x.season ?? -1}|${x.episode ?? -1}`)
      );
      return undefined;
    },
    sync_pull_provider_credentials: (a) => store.providers[a.p_profile_id] ?? [],
    sync_push_provider_credentials: (a) => {
      const list = store.providers[a.p_profile_id] ?? [];
      for (const cred of a.p_credentials ?? []) {
        const idx = list.findIndex((x) => x.provider === cred.provider);
        const row = { provider: cred.provider, credential_json: cred.credential_json, updated_at: now() };
        if (idx >= 0) list[idx] = row;
        else list.push(row);
      }
      store.providers[a.p_profile_id] = list;
      return undefined;
    },
    sync_delete_provider_credentials: (a) => {
      store.providers[a.p_profile_id] = (store.providers[a.p_profile_id] ?? []).filter(
        (x) => x.provider !== a.p_provider
      );
      return undefined;
    },
    get_tracker_tokens: (a) => store.trackerTokens[a.p_profile_id] ?? [],
    upsert_tracker_tokens: (a) => {
      const list = store.trackerTokens[a.p_profile_id] ?? [];
      const idx = list.findIndex((x) => x.tracker === a.p_tracker);
      const row = {
        tracker: a.p_tracker,
        access_token: a.p_access_token,
        refresh_token: a.p_refresh_token,
        tracker_username: a.p_username,
      };
      if (idx >= 0) list[idx] = row;
      else list.push(row);
      store.trackerTokens[a.p_profile_id] = list;
      return undefined;
    },
    clear_tracker_tokens: (a) => {
      store.trackerTokens[a.p_profile_id] = (store.trackerTokens[a.p_profile_id] ?? []).filter(
        (x) => x.tracker !== a.p_tracker
      );
      return undefined;
    },
    get_profile_tracker_settings: (a) => store.trackerSettings[a.p_profile_id] ?? [],
    upsert_profile_tracker_settings: (a) => {
      const list = store.trackerSettings[a.p_profile_id] ?? [];
      const idx = list.findIndex((x) => x.tracker === a.p_tracker);
      const row = {
        tracker: a.p_tracker,
        enabled_statuses: a.p_enabled_statuses,
        row_order: a.p_row_order,
        send_progress: a.p_send_progress,
      };
      if (idx >= 0) list[idx] = row;
      else list.push(row);
      store.trackerSettings[a.p_profile_id] = list;
      return undefined;
    },
    list_my_sessions: () => store.sessions,
    revoke_my_session: (a) => {
      store.sessions = store.sessions.filter((s) => s.session_id !== a.p_session_id);
      return undefined;
    },
    register_current_device: (a) => {
      if (a.p_client_name !== 'Nuvio Web')
        throw { status: 400, code: '22023', message: 'Unsupported Nuvio client' };
      return undefined;
    },
    get_sync_overview: () => ({
      profiles: { 1: { name: 'Main' } },
      addons: { 1: (store.addons[1] ?? []).length },
    }),
    get_avatar_catalog: () => [{ id: 'avatar_cat_01', is_active: true }],
    sync_export_account_backup: () => ({ version: 1, exported_at: now() }),
    health_ping: () => ({ ok: true }),
    sync_copy_profile_setup: (a) => {
      const src = store.settings[`${a.p_source_profile_id}:tv`];
      if (src && a.p_copy_tv)
        store.settings[`${a.p_target_profile_id}:tv`] = {
          settings_json: src.settings_json,
          updated_at: now(),
        };
      return undefined;
    },
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (url.pathname === '/auth/v1/token')
        return json(res, 200, {
          access_token: 'mock-token',
          refresh_token: 'mock-refresh',
          expires_in: 3600,
          user: { id: 'mock-user', email: 'mock@example.com' },
        });
      if (url.pathname === '/auth/v1/user')
        return json(res, 200, { id: 'mock-user', email: 'mock@example.com' });
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.split('/').pop();
        const handler = rpc[name];
        if (!handler) return json(res, 404, { code: 'PGRST202', message: `Could not find function ${name}` });
        try {
          const args = body ? JSON.parse(body) : {};
          const result = handler(args);
          return json(res, result === undefined ? 204 : 200, result);
        } catch (error) {
          return json(res, error.status ?? 400, { code: error.code, message: error.message });
        }
      }
      if (url.pathname === '/rest/v1/addons' || url.pathname === '/rest/v1/plugins') {
        const table = url.pathname.endsWith('addons') ? store.addons : store.plugins;
        const profile = Number(url.searchParams.get('profile_id')?.replace('eq.', '') ?? 1);
        return json(res, 200, table[profile] ?? []);
      }
      json(res, 404, { message: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, store, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
