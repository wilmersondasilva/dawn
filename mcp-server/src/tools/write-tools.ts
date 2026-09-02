import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { run } from './helpers.js';
import { ToolError, normalizeTemplateJson } from '../util.js';
import { validateTemplate, parseTemplateFilename } from '../validation/template-validator.js';
import { normalizeShareLink } from '../share-links.js';
import { fmtPage } from './read-tools.js';
import { livePageUrl, stagingEditorUrl, stagingPreviewUrl } from './urls.js';

const confirmSchema = z.literal(true).describe('Must be true. Only pass after the customer explicitly approved THIS action in their latest message.');

export function registerWriteTools(server: McpServer, ctx: AppContext): void {
  const { logger } = ctx;

  server.registerTool('check_theme_write_access', {
    title: 'Day-one write access check',
    description: 'Writes and deletes a harmless test template on the Staging theme to confirm this app may modify theme files. If Shopify answers ACCESS_DENIED, the server must run with THEME_WRITE_MODE=github. Safe to run any time; touches only the Staging theme.',
    inputSchema: {},
  }, async () => run(logger, 'check_theme_write_access', {}, true, async () => {
    const filename = 'templates/page.page-builder-access-check.json';
    const body = normalizeTemplateJson({ sections: { main: { type: 'main-page', settings: {} } }, order: ['main'] });
    try {
      await ctx.themes.upsertFiles(ctx.themeIds.staging.id, [{ filename, content: body }]);
    } catch (e) {
      const err = e as ToolError;
      return { theme_file_writes_allowed: false, error: err.message, hint: err.hint, recommended_setting: 'THEME_WRITE_MODE=github', current_mode: ctx.config.themeWriteMode };
    }
    await ctx.themes.deleteFiles(ctx.themeIds.staging.id, [filename]).catch(() => undefined);
    return { theme_file_writes_allowed: true, current_mode: ctx.config.themeWriteMode, note: ctx.config.themeWriteMode === 'github' ? 'Writes work; you could switch to THEME_WRITE_MODE=shopify for faster drafts, but github mode is also fine.' : 'All good.' };
  }));

  server.registerTool('upload_file_from_url', {
    title: 'Upload a file to the store',
    description: 'Upload an image/video/file into the store from a public link (Dropbox, Google Drive and direct links are normalised automatically). Waits until Shopify has processed it and returns the reference to use in a template (e.g. shopify://shop_images/hero.jpg). Alt text is required for accessibility.',
    inputSchema: {
      url: z.string().url().describe('Public share link or direct file URL.'),
      alt: z.string().min(1).describe('Short description of the image/video for accessibility.'),
      kind: z.enum(['IMAGE', 'VIDEO', 'FILE']).default('IMAGE'),
      filename: z.string().optional().describe('Override the stored filename (keep the extension).'),
    },
  }, async ({ url, alt, kind, filename }) => run(logger, 'upload_file_from_url', { url, alt, kind, filename }, true, async () => {
    const norm = normalizeShareLink(url);
    if (norm.provider === 'unknown') throw new ToolError(norm.warnings[0] ?? 'Invalid link.', 'Ask for a public https link to the file.', 'BAD_LINK');
    const file = await ctx.files.createFromUrl({ url: norm.url, alt, kind, filename: filename ?? norm.filenameGuess, maxBytes: ctx.config.maxUploadBytes });
    return { file, link: { provider: norm.provider, normalized: norm.changed, warnings: norm.warnings }, use_in_template: file.reference };
  }));

  server.registerTool('upsert_template_staging', {
    title: 'Save a draft template to Staging',
    description: 'Validate a page template and save it as a DRAFT on the Staging theme (never the live theme). Steps: validate → sync the staging branch with main → write. Returns validation issues instead of writing if anything is invalid. Filename must be templates/page.<name>.json or templates/index.json.',
    inputSchema: {
      filename: z.string().describe('e.g. templates/page.summer-sale.json'),
      template: z.union([z.string(), z.record(z.unknown())]).describe('Full template JSON (object or string).'),
      note: z.string().optional().describe('One line describing this draft (kept in the audit log).'),
    },
  }, async ({ filename, template, note }) => run(logger, 'upsert_template_staging', { filename, note }, true, async () => {
    const cat = await ctx.catalog.get();
    const v = validateTemplate(template, cat, { filename });
    if (!v.ok) return { status: 'rejected', reason: 'The template did not pass validation; nothing was written.', errors: v.errors, warnings: v.warnings };
    const content = normalizeTemplateJson(v.template);
    const reset = await ctx.promoter.resetStaging(ctx.config.stagingResetStrategy);
    let branchSync: { synced: boolean; pending: string[] } | null = null;
    if (reset.changed && ctx.writer.mode === 'shopify') {
      branchSync = await ctx.promoter.waitForStagingThemeSync([filename], 45_000);
    }
    const write = await ctx.writer.writeStaging([{ filename, content }]);
    const fn = parseTemplateFilename(filename);
    const previewPath = fn.templateType === 'index' ? '/' : null;
    return {
      status: 'draft_saved', filename, write, staging_reset: reset, ...(branchSync ? { staging_branch_sync: branchSync } : {}),
      outline: v.summary.sections, warnings: v.warnings,
      template_suffix: fn.suffix,
      preview: previewPath ? { storefront: stagingPreviewUrl(ctx, previewPath), theme_editor: stagingEditorUrl(ctx, previewPath) } : { note: 'For a page template, call get_preview_urls with the page handle once the page exists (create_page for new pages).' },
      next: 'Nothing is live. Share the preview with the customer; go live only after a separate explicit approval.',
    };
  }));

  server.registerTool('delete_template_staging', {
    title: 'Delete a draft template from Staging',
    description: 'Remove an abandoned draft template from the Staging theme. Never touches the live theme.',
    inputSchema: { filename: z.string() },
  }, async ({ filename }) => run(logger, 'delete_template_staging', { filename }, true, async () => {
    const fn = parseTemplateFilename(filename);
    if (!fn.ok) throw new ToolError(fn.error!, fn.hint, 'BAD_FILENAME');
    if (fn.suffix === null) throw new ToolError(`Refusing to delete ${filename}: default templates must not be removed.`, undefined, 'PROTECTED_TEMPLATE');
    const live = await ctx.gh.getFile(filename, ctx.config.liveBranch);
    if (live) return { status: 'skipped', reason: `${filename} also exists on the live site; deleting it from Staging would just be undone by the next sync. If the goal is to remove it from the live site, that is a separate change.` };
    const r = await ctx.writer.deleteStaging([filename]);
    return { status: 'deleted', ...r };
  }));

  server.registerTool('create_page', {
    title: 'Create a page (unpublished)',
    description: 'Create a new store page, always UNPUBLISHED (visitors get 404 until publish_page is called separately). Assigns the template suffix so it uses templates/page.<suffix>.json.',
    inputSchema: {
      title: z.string().min(1),
      handle: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional().describe('URL handle, lowercase with hyphens. Defaults to a slug of the title.'),
      template_suffix: z.string().optional().describe('The <name> in templates/page.<name>.json. Omit for the default page template.'),
      body_html: z.string().optional().describe('Optional page body HTML (shown by the main-page section).'),
    },
  }, async ({ title, handle, template_suffix, body_html }) => run(logger, 'create_page', { title, handle, template_suffix }, true, async () => {
    if (template_suffix) {
      const exists = await ctx.themes.readFile(ctx.themeIds.staging.id, `templates/page.${template_suffix}.json`);
      if (exists === null) throw new ToolError(`templates/page.${template_suffix}.json does not exist on Staging yet.`, 'Save the draft template first with upsert_template_staging, then create the page.', 'TEMPLATE_MISSING');
    }
    const page = await ctx.pages.createUnpublished({ title, handle, templateSuffix: template_suffix ?? null, body: body_html });
    return {
      status: 'created_unpublished', page: fmtPage(ctx, page),
      preview: { theme_editor: stagingEditorUrl(ctx, `/pages/${page.handle}`), note: 'Preview the draft with the theme editor link (admin login required). The page\'s public URL shows 404 until it is published — expected; the draft is hidden from visitors.' },
      next: 'Not visible to visitors. Publishing requires a separate explicit approval (publish_page), and if the template is new it must also be promoted to live first (promote_to_live).',
    };
  }));

  server.registerTool('set_page_template', {
    title: 'Change which template a page uses',
    description: 'Point an existing page at a different template suffix. For a PUBLISHED page this changes what visitors see as soon as the template exists on the live theme — treat it as a go-live action and get explicit approval first.',
    inputSchema: { page_id: z.string(), template_suffix: z.string().nullable().describe('null = default page template'), confirm: confirmSchema },
  }, async ({ page_id, template_suffix }) => run(logger, 'set_page_template', { page_id, template_suffix }, true, async () => {
    const page = await ctx.pages.getById(page_id);
    if (!page) throw new ToolError('No page with that id.', undefined, 'PAGE_NOT_FOUND');
    if (template_suffix && page.isPublished) {
      const onLive = await ctx.themes.readFile(ctx.themeIds.live.id, `templates/page.${template_suffix}.json`);
      if (onLive === null) throw new ToolError(`templates/page.${template_suffix}.json is not on the live theme yet, so the published page would fall back to the default template.`, 'Run promote_to_live for that template first, then set the page template.', 'TEMPLATE_NOT_LIVE');
    }
    const updated = await ctx.pages.update(page.id, { templateSuffix: template_suffix });
    return { status: 'template_assigned', page: fmtPage(ctx, updated) };
  }));

  server.registerTool('publish_page', {
    title: 'Publish a page (LIVE)',
    description: 'Make a page visible to the public. Requires confirm=true, which you may only pass after the customer explicitly said to publish/go live in their latest message. If the page uses a custom template, promote_to_live must have succeeded first.',
    inputSchema: { page_id: z.string(), confirm: confirmSchema },
  }, async ({ page_id }) => run(logger, 'publish_page', { page_id }, true, async () => {
    const page = await ctx.pages.getById(page_id);
    if (!page) throw new ToolError('No page with that id.', undefined, 'PAGE_NOT_FOUND');
    if (page.templateSuffix) {
      const onLive = await ctx.themes.readFile(ctx.themeIds.live.id, `templates/page.${page.templateSuffix}.json`);
      if (onLive === null) throw new ToolError(`The page's template (templates/page.${page.templateSuffix}.json) is not on the live theme yet; publishing now would show the default page layout.`, 'Run promote_to_live for that template first.', 'TEMPLATE_NOT_LIVE');
    }
    const updated = await ctx.pages.update(page.id, { isPublished: true });
    return { status: 'published', page: fmtPage(ctx, updated), live_url: livePageUrl(ctx, updated.handle), undo: 'unpublish_page reverses this.' };
  }));

  server.registerTool('unpublish_page', {
    title: 'Unpublish a page',
    description: 'Hide a page from the public (visitors get 404). The page and its content are kept.',
    inputSchema: { page_id: z.string() },
  }, async ({ page_id }) => run(logger, 'unpublish_page', { page_id }, true, async () => {
    const page = await ctx.pages.getById(page_id);
    if (!page) throw new ToolError('No page with that id.', undefined, 'PAGE_NOT_FOUND');
    const updated = await ctx.pages.update(page.id, { isPublished: false });
    return { status: 'unpublished', page: fmtPage(ctx, updated) };
  }));

  server.registerTool('promote_to_live', {
    title: 'Make approved templates LIVE',
    description: 'Copy ONLY the listed template files from the Staging theme to the live theme (via a scoped pull request on the live branch, merged automatically, then verified on the live theme). Requires confirm=true — only after the customer explicitly approved going live in their latest message. Returns the merge commit SHA needed for rollback.',
    inputSchema: {
      filenames: z.array(z.string().regex(/^templates\/[^/]+\.json$/)).min(1).describe('Exact template files approved, e.g. ["templates/page.summer-sale.json"].'),
      summary: z.string().optional().describe('One sentence describing the change, for the audit trail / PR body.'),
      confirm: confirmSchema,
    },
  }, async ({ filenames, summary }) => run(logger, 'promote_to_live', { filenames, summary }, true, async () => {
    const result = await ctx.promoter.promote(filenames, { summary });
    return { ...result, undo: result.merge_commit_sha ? `rollback with merge_commit_sha=${result.merge_commit_sha}` : undefined };
  }));

  server.registerTool('rollback', {
    title: 'Undo a go-live',
    description: 'Revert a previous promote_to_live by its merge commit SHA: restores the affected template files on the live theme to their previous content. Requires confirm=true after explicit approval.',
    inputSchema: { merge_commit_sha: z.string().regex(/^[0-9a-f]{7,40}$/), confirm: confirmSchema },
  }, async ({ merge_commit_sha }) => run(logger, 'rollback', { merge_commit_sha }, true, async () => ctx.promoter.rollback(merge_commit_sha)));
}
