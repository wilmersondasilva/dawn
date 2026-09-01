import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  SHOPIFY_STORE: 'acme', SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'sec',
  GITHUB_OWNER: 'o', GITHUB_REPO: 'r', GITHUB_TOKEN: 't', MCP_PATH_SECRET: 'abcdefghijklmnopqrstuvwxyz0123',
};

describe('loadConfig', () => {
  it('applies defaults and normalises the store', () => {
    const c = loadConfig({ ...base, SHOPIFY_STORE: 'https://acme.myshopify.com' });
    expect(c).toMatchObject({ shopifyStore: 'acme', shopifyApiVersion: '2026-07', liveBranch: 'main', stagingBranch: 'staging', stagingThemeName: 'Staging', themeWriteMode: 'shopify', stagingResetStrategy: 'force', port: 3000 });
  });
  it('accepts SHOPIFY_STORE_DOMAIN as an alias', () => {
    const { SHOPIFY_STORE: _s, ...rest } = base;
    expect(loadConfig({ ...rest, SHOPIFY_STORE_DOMAIN: 'acme.myshopify.com' }).shopifyStore).toBe('acme');
  });
  it('fails fast on missing or weak values', () => {
    expect(() => loadConfig({ ...base, GITHUB_TOKEN: '' })).toThrow(/GITHUB_TOKEN/);
    expect(() => loadConfig({ ...base, MCP_PATH_SECRET: 'short' })).toThrow(/at least 24/);
    expect(() => loadConfig({ ...base, THEME_WRITE_MODE: 'ftp' })).toThrow(/THEME_WRITE_MODE/);
  });
});

describe('scopes', () => {
  it('treats write_x as satisfying read_x', async () => {
    const { missingScopes } = await import('../src/shopify/scopes.js');
    expect(missingScopes(['read_themes', 'write_themes', 'read_content', 'write_content', 'read_files', 'write_files'], ['write_files', 'write_content', 'write_themes'])).toEqual([]);
    expect(missingScopes(['read_themes', 'write_themes'], ['read_themes'])).toEqual(['write_themes']);
  });
});
