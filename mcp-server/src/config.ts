/**
 * All configuration comes from environment variables. Nothing secret is ever
 * hardcoded, logged, or returned from a tool. See ../.env.example.
 */
export type ThemeWriteMode = 'shopify' | 'github';
export type StagingResetStrategy = 'force' | 'merge';

export interface Config {
  shopifyStore: string; // subdomain only
  shopifyApiVersion: string;
  shopifyClientId: string;
  shopifyClientSecret: string;
  githubOwner: string;
  githubRepo: string;
  githubToken: string;
  liveBranch: string;
  stagingBranch: string;
  stagingThemeName: string;
  mcpPathSecret: string;
  themeWriteMode: ThemeWriteMode;
  stagingResetStrategy: StagingResetStrategy;
  port: number;
  auditLogFile?: string;
  catalogTtlMs: number;
  syncTimeoutMs: number;
  maxUploadBytes: number;
}

/** Latest stable Admin API version at time of writing (checked 2026-09 on shopify.dev/docs/api/admin-graphql). */
export const DEFAULT_SHOPIFY_API_VERSION = '2026-07';

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key]?.trim();
  if (!v) throw new Error(`Missing required environment variable ${key}. See .env.example.`);
  return v;
}

function optional(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const v = env[key]?.trim();
  return v ? v : fallback;
}

function oneOf<T extends string>(env: NodeJS.ProcessEnv, key: string, allowed: readonly T[], fallback: T): T {
  const v = optional(env, key, fallback) as T;
  if (!allowed.includes(v)) throw new Error(`${key} must be one of ${allowed.join(', ')} (got "${v}")`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Accept SHOPIFY_STORE_DOMAIN as an alias (full domain or subdomain).
  const storeRaw = env.SHOPIFY_STORE?.trim() || env.SHOPIFY_STORE_DOMAIN?.trim() || '';
  if (!storeRaw) throw new Error('Missing required environment variable SHOPIFY_STORE (or SHOPIFY_STORE_DOMAIN). See .env.example.');
  const store = storeRaw.replace(/\.myshopify\.com$/i, '').replace(/^https?:\/\//, '');
  if (!/^[a-z0-9-]+$/i.test(store)) throw new Error('SHOPIFY_STORE must be the store subdomain only, e.g. "my-store"');
  const secret = required(env, 'MCP_PATH_SECRET');
  if (secret.length < 24 || !/^[A-Za-z0-9_-]+$/.test(secret)) {
    throw new Error('MCP_PATH_SECRET must be at least 24 URL-safe characters (A-Z a-z 0-9 _ -). Generate one with: openssl rand -base64 36 | tr "+/" "-_"');
  }
  return {
    shopifyStore: store,
    shopifyApiVersion: optional(env, 'SHOPIFY_API_VERSION', DEFAULT_SHOPIFY_API_VERSION),
    shopifyClientId: required(env, 'SHOPIFY_CLIENT_ID'),
    shopifyClientSecret: required(env, 'SHOPIFY_CLIENT_SECRET'),
    githubOwner: required(env, 'GITHUB_OWNER'),
    githubRepo: required(env, 'GITHUB_REPO'),
    githubToken: required(env, 'GITHUB_TOKEN'),
    liveBranch: optional(env, 'GITHUB_LIVE_BRANCH', 'main'),
    stagingBranch: optional(env, 'GITHUB_STAGING_BRANCH', 'staging'),
    stagingThemeName: optional(env, 'STAGING_THEME_NAME', 'Staging'),
    mcpPathSecret: secret,
    themeWriteMode: oneOf(env, 'THEME_WRITE_MODE', ['shopify', 'github'] as const, 'shopify'),
    stagingResetStrategy: oneOf(env, 'STAGING_RESET_STRATEGY', ['force', 'merge'] as const, 'force'),
    port: Number(optional(env, 'PORT', '3000')),
    auditLogFile: env.AUDIT_LOG_FILE?.trim() || undefined,
    catalogTtlMs: Number(optional(env, 'CATALOG_TTL_SECONDS', '300')) * 1000,
    syncTimeoutMs: Number(optional(env, 'SYNC_TIMEOUT_SECONDS', '120')) * 1000,
    maxUploadBytes: Number(optional(env, 'MAX_UPLOAD_MB', '250')) * 1024 * 1024,
  };
}
