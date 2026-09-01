import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { registerReadTools } from './read-tools.js';
import { registerWriteTools } from './write-tools.js';

export const SERVER_INFO = { name: 'shopify-page-builder', version: '0.1.0' };

export function createMcpServer(ctx: AppContext): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: 'Tools for building Shopify pages safely: read the section catalog, draft templates on the Staging theme, preview, and only go live (publish_page / promote_to_live) after a separate explicit approval. Never expose secrets; relay error messages and hints to the user in plain language.',
  });
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  return server;
}
