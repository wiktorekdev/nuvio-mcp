export interface Profile {
  id: string;
  user_id: string;
  profile_index: number;
  name: string;
  avatar_color_hex: string | null;
  uses_primary_addons: boolean;
  uses_primary_plugins: boolean;
  avatar_id: string | null;
  avatar_url: string | null;
  profile_background_id?: string | null;
  profile_background_url?: string | null;
  pin_enabled: boolean;
  pin_locked_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface Addon {
  id: string;
  user_id: string;
  profile_id: number;
  url: string;
  name: string | null;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Plugin {
  id: string;
  user_id: string;
  profile_id: number;
  url: string;
  name: string | null;
  enabled: boolean;
  sort_order: number;
  repo_type: string | null;
  created_at: string;
  updated_at: string;
}

export type Platform = 'tv' | 'mobile' | 'desktop' | 'web' | string;

export interface SettingsBlob {
  profile_id: number;
  settings_json: Record<string, unknown>;
  updated_at: string;
}

export interface HomeCatalogSettings {
  id?: string;
  user_id?: string;
  profile_id: number;
  platform: Platform;
  settings_json: Record<string, unknown>;
  updated_at: string;
}

export interface CollectionSource {
  addonId: string;
  type: string;
  catalogId: string;
}

export interface CollectionFolder {
  id: string;
  title: string;
  coverImageUrl?: string;
  coverEmoji?: string;
  tileShape?: 'POSTER' | 'LANDSCAPE' | 'SQUARE';
  hideTitle?: boolean;
  catalogSources: CollectionSource[];
}

export interface Collection {
  id: string;
  title: string;
  backdropImageUrl?: string;
  pinToTop?: boolean;
  viewMode?: 'TABBED_GRID' | 'ROWS' | 'FOLLOW_LAYOUT';
  showAllTab?: boolean;
  folders: CollectionFolder[];
}

export interface CollectionsBlob {
  profile_id: number;
  collections_json: Collection[];
  updated_at: string;
}

export interface Session {
  session_id: string;
  created_at: string;
  last_active_at?: string;
  client_name?: string;
  client_version?: string;
  platform?: string;
  device_name?: string;
  user_agent?: string;
  is_current?: boolean;
}

export interface SyncOverview {
  addons?: Record<string, number>;
  plugins?: Record<string, number>;
  profiles?: Record<string, number>;
  library_items?: Record<string, number>;
  watched_items?: Record<string, number>;
  watch_progress?: Record<string, number>;
}

/** Result of a mutation attempt. When `applied` is false the change was only planned. */
export interface ApplyResult<T> {
  applied: boolean;
  changed: boolean;
  before: T;
  after: T;
  diff: string[];
}
