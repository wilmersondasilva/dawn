import type { AppContext } from '../context.js';

export function storefrontBase(ctx: AppContext): string { return `https://${ctx.config.shopifyStore}.myshopify.com`; }
export function adminBase(ctx: AppContext): string { return `https://admin.shopify.com/store/${ctx.config.shopifyStore}`; }

export function stagingPreviewUrl(ctx: AppContext, path = '/'): string {
  const u = new URL(path, storefrontBase(ctx));
  u.searchParams.set('preview_theme_id', ctx.themeIds.staging.numericId);
  return u.toString();
}

export function stagingEditorUrl(ctx: AppContext, previewPath: string): string {
  return `${adminBase(ctx)}/themes/${ctx.themeIds.staging.numericId}/editor?previewPath=${encodeURIComponent(previewPath)}`;
}

export function livePageUrl(ctx: AppContext, handle: string): string { return `${storefrontBase(ctx)}/pages/${handle}`; }
export function adminPageUrl(ctx: AppContext, numericId: string): string { return `${adminBase(ctx)}/pages/${numericId}`; }
