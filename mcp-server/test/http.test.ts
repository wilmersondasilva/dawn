import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AppContext } from '../src/context.js';
import { createRequestHandler } from '../src/http/app.js';
import { silentLogger } from '../src/logger.js';
import { buildCatalog } from '../src/catalog/catalog.js';
import { LIMITS, loadThemeFiles } from './schema-parser.test.js';

const SECRET = 'test-secret-0123456789abcdefghij';

function stubContext(): AppContext {
  const catalog = buildCatalog(loadThemeFiles(), 'test', LIMITS, () => 0);
  const ctx = {
    config: { mcpPathSecret: SECRET, shopifyStore: 'acme', shopifyApiVersion: '2026-07', themeWriteMode: 'shopify', stagingResetStrategy: 'force', githubOwner: 'o', githubRepo: 'r', liveBranch: 'main', stagingBranch: 'staging' },
    logger: silentLogger,
    themeIds: { live: { id: 'gid://shopify/OnlineStoreTheme/1', numericId: '1', name: 'Dawn', role: 'MAIN' }, staging: { id: 'gid://shopify/OnlineStoreTheme/2', numericId: '2', name: 'Staging', role: 'UNPUBLISHED' } },
    catalog: { get: async () => catalog, invalidate: () => undefined },
    pages: { findByHandle: async (h: string) => (h === 'about' ? { id: 'gid://shopify/Page/9', numericId: '9', handle: 'about', title: 'About', isPublished: false, templateSuffix: 'about' } : null) },
    auth: { getToken: async () => 'x', status: () => ({ hasToken: true, scopes: ['read_themes'], expiresAt: 'later', secondsUntilExpiry: 1 }) },
    startedAt: 'now',
  };
  return ctx as unknown as AppContext;
}

describe('HTTP transport', () => {
  let server: Server; let base: string;
  beforeAll(async () => {
    const handler = createRequestHandler(stubContext());
    server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('hides the endpoint behind the secret path', async () => {
    expect((await fetch(`${base}/mcp/wrong-secret-0123456789abcdefgh`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/mcp/${SECRET}`, { method: 'GET' })).status).toBe(405);
  });

  it('serves MCP over streamable HTTP: initialize, list tools, call a tool', async () => {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/${SECRET}`)));
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(expect.arrayContaining(['get_section_catalog', 'get_page', 'get_template', 'list_pages', 'search_files', 'upload_file_from_url', 'upsert_template_staging', 'create_page', 'publish_page', 'unpublish_page', 'promote_to_live', 'rollback', 'get_preview_urls', 'delete_template_staging', 'get_auth_status', 'validate_template']));
    expect(names.some((n) => /live/.test(n) && /upsert|write/.test(n))).toBe(false); // no direct live theme write tool

    const preview = await client.callTool({ name: 'get_preview_urls', arguments: { page_handle: 'about' } });
    const body = JSON.parse((preview.content as Array<{ text: string }>)[0].text);
    expect(body.staging_theme.storefront_preview).toBe('https://acme.myshopify.com/?preview_theme_id=2');
    expect(body.page.theme_editor_preview).toBe('https://admin.shopify.com/store/acme/themes/2/editor?previewPath=%2Fpages%2Fabout');
    expect(body.page.published).toBe(false);

    const catalog = await client.callTool({ name: 'get_section_catalog', arguments: {} });
    const cat = JSON.parse((catalog.content as Array<{ text: string }>)[0].text);
    expect(cat.sections.some((s: { type: string }) => s.type === 'image-banner')).toBe(true);
    expect(cat.sections.some((s: { type: string }) => s.type === 'main-product')).toBe(false);

    const bad = await client.callTool({ name: 'validate_template', arguments: { filename: 'templates/page.x.json', template: { sections: { a: { type: 'nope' } }, order: ['a'] } } });
    expect(JSON.parse((bad.content as Array<{ text: string }>)[0].text).ok).toBe(false);

    const status = await client.callTool({ name: 'get_auth_status', arguments: {} });
    const st = JSON.parse((status.content as Array<{ text: string }>)[0].text);
    expect(Object.keys(st)).not.toEqual(expect.arrayContaining(['token', 'access_token', 'client_secret']));
    expect(JSON.stringify(st)).not.toContain(SECRET);
    expect(st.missing_scopes).toContain('write_content');
    await client.close();
  });
});
