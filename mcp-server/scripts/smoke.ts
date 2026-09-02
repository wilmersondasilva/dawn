/**
 * Day-one smoke test. Run with: npm run check:shopify [-- --write-check]
 * Loads env from the environment (use `set -a; source .env; set +a` first, or a process manager).
 * 1. Obtains a client-credentials token and prints scopes + expiry (never the token).
 * 2. Discovers the live and Staging themes.
 * 3. Checks the GitHub token can read both branches.
 * 4. With --write-check: upserts + deletes a harmless template on Staging to test themeFilesUpsert.
 */
import { loadConfig } from '../src/config.js';
import { createAppContext } from '../src/context.js';
import { REQUIRED_SCOPES } from '../src/tools/read-tools.js';
import { missingScopes } from '../src/shopify/scopes.js';
import { normalizeTemplateJson } from '../src/util.js';

async function main() {
  const config = loadConfig();
  console.log(`Store: ${config.shopifyStore}.myshopify.com  API ${config.shopifyApiVersion}  write mode: ${config.themeWriteMode}`);
  const ctx = await createAppContext(config);
  const s = ctx.auth.status();
  console.log(`Token OK. Scopes: ${s.scopes.join(', ')}  expires ${s.expiresAt}`);
  const missing = missingScopes(REQUIRED_SCOPES, s.scopes).filter((sc) => !(sc === 'write_themes' && config.themeWriteMode === 'github'));
  if (missing.length) console.log(`WARNING missing scopes: ${missing.join(', ')} (release a new app version with them)`);
  console.log(`Live theme: ${ctx.themeIds.live.name} (${ctx.themeIds.live.numericId})  Staging theme: ${ctx.themeIds.staging.name} (${ctx.themeIds.staging.numericId})`);
  console.log(`GitHub ${config.githubOwner}/${config.githubRepo}: ${config.liveBranch}=${(await ctx.gh.getBranchSha(config.liveBranch)).slice(0, 7)} ${config.stagingBranch}=${(await ctx.gh.getBranchSha(config.stagingBranch)).slice(0, 7)}`);
  const cat = await ctx.catalog.get(true);
  console.log(`Catalog: ${cat.sections.length} sections (${cat.sections.filter((x) => x.usable_in_page_templates).length} usable on pages), ${cat.skipped.length} skipped, color schemes: ${cat.color_schemes.join(', ')}`);
  if (process.argv.includes('--write-check')) {
    const filename = 'templates/page.page-builder-access-check.json';
    try {
      await ctx.themes.upsertFiles(ctx.themeIds.staging.id, [{ filename, content: normalizeTemplateJson({ sections: { main: { type: 'main-page', settings: {} } }, order: ['main'] }) }]);
      await ctx.themes.deleteFiles(ctx.themeIds.staging.id, [filename]);
      console.log('themeFilesUpsert: ALLOWED — THEME_WRITE_MODE=shopify will work.');
    } catch (e) {
      console.log(`themeFilesUpsert: DENIED — ${(e as Error).message}\n→ Set THEME_WRITE_MODE=github.`);
    }
  }
}
main().catch((e) => { console.error(`FAILED: ${e.message}${e.hint ? `\nHint: ${e.hint}` : ''}`); process.exit(1); });
