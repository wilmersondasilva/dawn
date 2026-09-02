import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { run } from './helpers.js';
import { ToolError } from '../util.js';
import { validateTemplate } from '../validation/template-validator.js';
import { adminPageUrl, livePageUrl, stagingEditorUrl, stagingPreviewUrl } from './urls.js';
import { missingScopes } from '../shopify/scopes.js';

export const REQUIRED_SCOPES = ['read_themes', 'write_themes', 'read_content', 'write_content', 'read_files', 'write_files'];

export function registerReadTools(server: McpServer, ctx: AppContext): void {
  const { logger } = ctx;

  server.registerTool('get_auth_status', {
    title: 'Auth & connection status',
    description: 'Reports which store and themes the server is connected to, the scopes granted to the app, when the token expires, and which write mode is active. Never returns secrets. Call this first if anything seems misconfigured.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => run(logger, 'get_auth_status', {}, false, async () => {
    await ctx.auth.getToken();
    const s = ctx.auth.status();
    const missing = missingScopes(REQUIRED_SCOPES, s.scopes).filter((sc) => !(sc === 'write_themes' && ctx.config.themeWriteMode === 'github'));
    return {
      store: `${ctx.config.shopifyStore}.myshopify.com`, api_version: ctx.config.shopifyApiVersion,
      scopes: s.scopes, missing_scopes: missing, token_expires_at: s.expiresAt,
      themes: { live: { id: ctx.themeIds.live.numericId, name: ctx.themeIds.live.name }, staging: { id: ctx.themeIds.staging.numericId, name: ctx.themeIds.staging.name } },
      theme_write_mode: ctx.config.themeWriteMode, staging_reset_strategy: ctx.config.stagingResetStrategy,
      github: { repo: `${ctx.config.githubOwner}/${ctx.config.githubRepo}`, live_branch: ctx.config.liveBranch, staging_branch: ctx.config.stagingBranch },
      server_started_at: ctx.startedAt,
    };
  }));

  server.registerTool('get_section_catalog', {
    title: 'List available sections',
    description: 'Lists the sections that exist in the store\'s theme (read live from the Staging theme, cached briefly). Default output is a compact summary of sections usable on pages: name, type, block types, asset slots. Pass section_types to get full settings/blocks/presets detail for specific sections before generating a template. Always call this instead of assuming which sections exist.',
    inputSchema: {
      refresh: z.boolean().optional().describe('Bypass the cache and re-read the theme.'),
      section_types: z.array(z.string()).optional().describe('Return full detail (all settings with types/options/defaults, blocks, presets) for these section types only.'),
      include_unusable: z.boolean().optional().describe('Also list sections that cannot be added to pages (main-product, header, etc.).'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ refresh, section_types, include_unusable }) => run(logger, 'get_section_catalog', { refresh, section_types }, false, async () => {
    const cat = await ctx.catalog.get(!!refresh);
    if (section_types?.length) {
      const wanted = new Set(section_types);
      const found = cat.sections.filter((s) => wanted.has(s.type));
      const missing = section_types.filter((t) => !found.some((s) => s.type === t));
      return { source: cat.source, fetched_at: cat.fetched_at, color_schemes: cat.color_schemes, limits: cat.limits, sections: found, not_found: missing };
    }
    const list = cat.sections.filter((s) => include_unusable || s.usable_in_page_templates);
    return {
      source: cat.source, fetched_at: cat.fetched_at, color_schemes: cat.color_schemes, limits: cat.limits,
      sections: list.map((s) => ({
        type: s.type, name: s.name, usable_in_page_templates: s.usable_in_page_templates,
        ...(s.usability_notes.length ? { notes: s.usability_notes } : {}),
        ...(s.max_blocks !== undefined ? { max_blocks: s.max_blocks } : {}),
        setting_ids: s.settings.map((x) => `${x.id}:${x.type}`),
        blocks: s.blocks.map((b) => ({ type: b.type, name: b.name, ...(b.limit !== undefined ? { limit: b.limit } : {}), setting_ids: b.settings.map((x) => `${x.id}:${x.type}`) })),
        asset_slots: s.asset_slots,
        presets: s.presets.map((p) => p.name),
      })),
      skipped: cat.skipped,
      tip: 'Call again with section_types=[...] to get option values, ranges and defaults before writing a template.',
    };
  }));

  server.registerTool('get_page', {
    title: 'Look up a page',
    description: 'Find a store page by handle, title, or id. Returns id, handle, title, published state and the template it uses (template_suffix; null means the default page template).',
    inputSchema: {
      handle: z.string().optional().describe('URL handle, e.g. "about-us".'),
      title: z.string().optional().describe('Title to search for (partial match).'),
      id: z.string().optional().describe('Page id (numeric or gid).'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ handle, title, id }) => run(logger, 'get_page', { handle, title, id }, false, async () => {
    if (id) { const p = await ctx.pages.getById(id); return p ? { page: fmtPage(ctx, p) } : { page: null, message: 'No page with that id.' }; }
    if (handle) { const p = await ctx.pages.findByHandle(handle.replace(/^\/?pages\//, '')); return p ? { page: fmtPage(ctx, p) } : { page: null, message: `No page with handle "${handle}".` }; }
    if (title) { const ps = await ctx.pages.findByTitle(title); return { matches: ps.map((p) => fmtPage(ctx, p)), message: ps.length ? undefined : `No page whose title contains "${title}".` }; }
    throw new ToolError('Give a handle, title or id to look up.', undefined, 'BAD_INPUT');
  }));

  server.registerTool('list_pages', {
    title: 'List pages',
    description: 'Paginated list of store pages (handle, title, published, template_suffix).',
    inputSchema: { first: z.number().int().min(1).max(250).optional(), after: z.string().optional().describe('Cursor from a previous call.'), query: z.string().optional().describe('Shopify search syntax, e.g. "title:About*"') },
    annotations: { readOnlyHint: true },
  }, async ({ first, after, query }) => run(logger, 'list_pages', { first, after, query }, false, async () => {
    const r = await ctx.pages.list({ first, after, query });
    return { pages: r.pages.map((p) => fmtPage(ctx, p)), has_next_page: r.hasNextPage, end_cursor: r.endCursor };
  }));

  server.registerTool('get_template', {
    title: 'Read a template',
    description: 'Read a JSON template file (e.g. templates/page.about.json) from the Staging theme (drafts) or the live theme. Returns the parsed JSON plus a plain-language outline of its sections.',
    inputSchema: { filename: z.string().describe('templates/page.<name>.json or templates/index.json'), theme: z.enum(['staging', 'live']).default('staging') },
    annotations: { readOnlyHint: true },
  }, async ({ filename, theme }) => run(logger, 'get_template', { filename, theme }, false, async () => {
    const themeId = theme === 'live' ? ctx.themeIds.live.id : ctx.themeIds.staging.id;
    const content = await ctx.themes.readFile(themeId, filename);
    if (content === null) return { exists: false, filename, theme, message: `${filename} does not exist on the ${theme} theme.` };
    const cat = await ctx.catalog.get();
    const v = validateTemplate(content, cat, { filename });
    let parsed: unknown = null; try { parsed = JSON.parse(content); } catch { /* keep raw */ }
    return { exists: true, filename, theme, template: parsed ?? content, outline: v.summary.sections, validation: { ok: v.ok, errors: v.errors, warnings: v.warnings } };
  }));

  server.registerTool('validate_template', {
    title: 'Validate a template (no write)',
    description: 'Check a template JSON against the theme\'s section catalog and Shopify limits without saving anything. Use it to iterate before upsert_template_staging.',
    inputSchema: { filename: z.string(), template: z.union([z.string(), z.record(z.unknown())]).describe('Template JSON (object or string).') },
    annotations: { readOnlyHint: true },
  }, async ({ filename, template }) => run(logger, 'validate_template', { filename }, false, async () => {
    const cat = await ctx.catalog.get();
    const v = validateTemplate(template, cat, { filename });
    return { ok: v.ok, errors: v.errors, warnings: v.warnings, summary: v.summary };
  }));

  server.registerTool('search_files', {
    title: 'Search store files',
    description: 'Search images/videos/files already uploaded to the store (Content → Files). Returns url, dimensions where available, and the exact reference string to put in a template setting (shopify://shop_images/<file> for images).',
    inputSchema: { term: z.string().optional().describe('Words from the filename or alt text.'), kind: z.enum(['IMAGE', 'VIDEO', 'FILE']).optional(), first: z.number().int().min(1).max(100).optional(), after: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ term, kind, first, after }) => run(logger, 'search_files', { term, kind, first }, false, async () => {
    const r = await ctx.files.search({ term, kind, first, after });
    return { files: r.files, has_next_page: r.hasNextPage, end_cursor: r.endCursor };
  }));

  server.registerTool('get_preview_urls', {
    title: 'Preview links',
    description: 'Links for previewing the Staging theme, and for a specific page. The customer must be logged into the Shopify admin for preview links to work. For unpublished pages, the theme-editor link is the reliable way to see the draft.',
    inputSchema: { page_handle: z.string().optional().describe('Handle of the page to preview.') },
    annotations: { readOnlyHint: true },
  }, async ({ page_handle }) => run(logger, 'get_preview_urls', { page_handle }, false, async () => {
    const out: Record<string, unknown> = {
      staging_theme: { name: ctx.themeIds.staging.name, storefront_preview: stagingPreviewUrl(ctx, '/'), theme_editor: stagingEditorUrl(ctx, '/') },
      how_to_view: 'Open the link while logged into the Shopify admin. The storefront preview shows the Staging theme; the theme editor link opens the same draft in the customizer preview.',
    };
    if (page_handle) {
      const handle = page_handle.replace(/^\/?pages\//, '');
      const page = await ctx.pages.findByHandle(handle);
      const path = `/pages/${handle}`;
      if (page && !page.isPublished) {
        // Unpublished pages 404 on the storefront (even with preview_theme_id) — by design.
        // Confirmed on the dev store 2026-09: only the theme editor renders them.
        out.page = {
          handle, exists: true, published: false, template_suffix: page.templateSuffix,
          theme_editor_preview: stagingEditorUrl(ctx, path),
          admin_page: adminPageUrl(ctx, page.numericId),
          note: 'Preview the draft with theme_editor_preview (requires being logged into the Shopify admin). The page\'s normal address shows "404 not found" to everyone until it is published — that is expected; it means the draft is hidden from visitors.',
        };
      } else {
        out.page = {
          handle, exists: !!page, published: page?.isPublished ?? null, template_suffix: page?.templateSuffix ?? null,
          preview_on_staging_theme: stagingPreviewUrl(ctx, path),
          theme_editor_preview: stagingEditorUrl(ctx, path),
          admin_page: page ? adminPageUrl(ctx, page.numericId) : null,
          live_url: page?.isPublished ? livePageUrl(ctx, handle) : null,
          note: page
            ? 'Published page: preview_on_staging_theme shows the DRAFT design (admin login required); live_url shows what visitors currently see.'
            : 'No page with this handle exists yet.',
        };
      }
    }
    return out;
  }));

  server.registerTool('list_recent_promotions', {
    title: 'Recent go-lives',
    description: 'Lists recent page-builder promotions/rollbacks on the live branch with their commit SHAs (needed for rollback).',
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true },
  }, async ({ limit }) => run(logger, 'list_recent_promotions', { limit }, false, async () => {
    const commits = await ctx.gh.listCommits(ctx.config.liveBranch, 100);
    const ours = commits.filter((c) => c.message.startsWith('[page-builder]')).slice(0, limit ?? 10);
    return { promotions: ours.map((c) => ({ sha: c.sha, message: c.message.split('\n')[0], date: c.date })) };
  }));
}

export function fmtPage(ctx: AppContext, p: { id: string; numericId: string; handle: string; title: string; isPublished: boolean; templateSuffix: string | null; updatedAt?: string }) {
  return {
    id: p.id, handle: p.handle, title: p.title, published: p.isPublished, template_suffix: p.templateSuffix,
    template_file: `templates/page${p.templateSuffix ? `.${p.templateSuffix}` : ''}.json`,
    admin_url: adminPageUrl(ctx, p.numericId), live_url: p.isPublished ? livePageUrl(ctx, p.handle) : null, updated_at: p.updatedAt,
  };
}
