import { McpServer } from '@modelcontextprotocol/server';
import type { NuvioClient } from './nuvio/client.js';
import type { NuvioConfig } from './config.js';
import { registerAllTools } from './tools/index.js';
import { VERSION } from './version.js';

/**
 * Build a fresh MCP server. The v2 Streamable HTTP handler and the stdio server
 * both call this once per connection/request, so it must be cheap and side-effect free.
 */
export function createServer(client: NuvioClient, cfg: NuvioConfig): McpServer {
  const server = new McpServer({ name: 'nuvio-mcp', version: VERSION });
  registerAllTools(server, client, cfg);
  return server;
}
