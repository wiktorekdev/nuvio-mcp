import type { McpServer } from '@modelcontextprotocol/server';
import type { NuvioClient } from '../nuvio/client.js';
import type { NuvioConfig } from '../config.js';
import { definePlanMutation, defineRead, registry } from './helpers.js';
import { registerProfileTools } from './profiles.js';
import { registerAddonTools } from './addons.js';
import { registerPluginTools } from './plugins.js';
import { registerSettingsTools } from './settings.js';
import { registerCollectionTools } from './collections.js';
import { registerLibraryTools } from './library.js';
import { registerProviderTools } from './providers.js';
import { registerTrackerTools } from './trackers.js';
import { registerSessionTools } from './sessions.js';
import { registerAccountTools } from './account.js';
import { registerUndoTools } from './undo.js';

export function registerAllTools(server: McpServer, client: NuvioClient, cfg: NuvioConfig): void {
  registerProfileTools(server, client, cfg);
  registerAddonTools(server, client, cfg);
  registerPluginTools(server, client, cfg);
  registerSettingsTools(server, client, cfg);
  registerCollectionTools(server, client, cfg);
  registerLibraryTools(server, client, cfg);
  registerProviderTools(server, client, cfg);
  registerTrackerTools(server, client, cfg);
  registerSessionTools(server, client, cfg);
  registerAccountTools(server, client, cfg);
  registerUndoTools(server, client, cfg);
  definePlanMutation(server, client, cfg);

  defineRead(server, client, cfg, {
    name: 'nuvio_capabilities',
    title: 'Show MCP capabilities',
    description:
      'Describe this Nuvio MCP server: backend, transport, automatic-undo behaviour, the canonical tool list and ' +
      'the deprecated compatibility aliases.',
    risk: 'read',
    schema: {},
    handler: () => {
      const canonical = registry.filter((t) => t.canonical);
      const deprecated = registry.filter((t) => !t.canonical);
      return {
        backend_url: cfg.backendUrl,
        transport: cfg.transport,
        origin_client_id: cfg.originClientId,
        account_deletion: 'not supported by design',
        undo: {
          automatic: true,
          disabled: cfg.disableSnapshots,
          snapshot_dir: cfg.snapshotDir,
          snapshot_retention: {
            max_age_days: cfg.snapshotMaxAgeDays,
            max_count: cfg.snapshotMaxCount,
            max_total_bytes: cfg.snapshotMaxTotalBytes,
          },
          tools: [
            'nuvio_list_undo',
            'nuvio_inspect_snapshot',
            'nuvio_undo',
            'nuvio_redo',
            'nuvio_prune_snapshots',
          ],
        },
        canonical_tool_count: canonical.length,
        tools: canonical.map((t) => ({ name: t.name, risk: t.risk, title: t.title })),
        deprecated_tools: deprecated.map((t) => ({
          name: t.name,
          risk: t.risk,
          replacement: t.replacement,
        })),
      };
    },
  });
}
