import { type Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { ShopifyAuth } from './shopify/auth.js';
import { ShopifyGraphQL } from './shopify/client.js';
import { ThemeService, type ThemeInfo } from './shopify/themes.js';
import { PageService } from './shopify/pages.js';
import { FileService } from './shopify/files.js';
import { GitHubClient } from './github/client.js';
import { Promoter } from './github/promote.js';
import { SectionCatalog, CATALOG_FILE_PATTERNS } from './catalog/catalog.js';
import { MAX_BLOCKS_PER_SECTION, MAX_SECTIONS_PER_TEMPLATE } from './validation/limits.js';
import { GitHubThemeWriter, ShopifyThemeWriter, type ThemeWriter } from './theme-writer/index.js';
import { sleep as defaultSleep, type Sleep } from './util.js';

export interface AppContext {
  config: Config;
  logger: Logger;
  auth: ShopifyAuth;
  gql: ShopifyGraphQL;
  themes: ThemeService;
  pages: PageService;
  files: FileService;
  gh: GitHubClient;
  catalog: SectionCatalog;
  promoter: Promoter;
  writer: ThemeWriter;
  themeIds: { live: ThemeInfo; staging: ThemeInfo };
  startedAt: string;
}

export interface ContextDeps { fetch?: typeof fetch; logger?: Logger; sleep?: Sleep }

/** Wire every service together. Discovers the live + staging themes and fails loudly if either is missing. */
export async function createAppContext(config: Config, deps: ContextDeps = {}): Promise<AppContext> {
  const logger = deps.logger ?? createLogger({ auditFile: config.auditLogFile });
  const fetchFn = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;

  const auth = new ShopifyAuth({ store: config.shopifyStore, clientId: config.shopifyClientId, clientSecret: config.shopifyClientSecret, fetch: fetchFn });
  const gql = new ShopifyGraphQL({ store: config.shopifyStore, apiVersion: config.shopifyApiVersion, auth, fetch: fetchFn, logger, sleep });
  const themes = new ThemeService(gql, fetchFn);
  const pages = new PageService(gql);
  const files = new FileService(gql, fetchFn, sleep);
  const gh = new GitHubClient({ owner: config.githubOwner, repo: config.githubRepo, token: config.githubToken, fetch: fetchFn });

  const themeIds = await themes.discover(config.stagingThemeName);
  logger.info('themes discovered', { live: { id: themeIds.live.numericId, name: themeIds.live.name }, staging: { id: themeIds.staging.numericId, name: themeIds.staging.name } });

  const catalog = new SectionCatalog(
    { loadFiles: async () => new Map((await themes.readFiles(themeIds.staging.id, CATALOG_FILE_PATTERNS)).map((f) => [f.filename, f.content])) },
    { ttlMs: config.catalogTtlMs, sourceLabel: `staging theme "${themeIds.staging.name}"`, limits: { max_sections_per_template: MAX_SECTIONS_PER_TEMPLATE, max_blocks_per_section: MAX_BLOCKS_PER_SECTION } },
  );

  const promoter = new Promoter({
    gh, liveBranch: config.liveBranch, stagingBranch: config.stagingBranch,
    readStagingFile: (f) => themes.readFile(themeIds.staging.id, f),
    readLiveFile: (f) => themes.readFile(themeIds.live.id, f),
    logger, sleep, syncTimeoutMs: config.syncTimeoutMs,
  });

  const writer: ThemeWriter = config.themeWriteMode === 'github'
    ? new GitHubThemeWriter(gh, config.stagingBranch, promoter, config.syncTimeoutMs)
    : new ShopifyThemeWriter(themes, themeIds.staging.id, sleep);

  return { config, logger, auth, gql, themes, pages, files, gh, catalog, promoter, writer, themeIds, startedAt: new Date().toISOString() };
}
