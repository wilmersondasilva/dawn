/**
 * Shopify platform limits for JSON templates.
 * Source (checked 2026-09): https://shopify.dev/docs/storefronts/themes/architecture/templates/json-templates
 *   "JSON templates can render up to 25 sections, and each section can have up to 50 blocks."
 *   "A theme can contain up to 1,000 JSON templates."
 */
export const MAX_SECTIONS_PER_TEMPLATE = 25;
export const MAX_BLOCKS_PER_SECTION = 50;
export const MAX_JSON_TEMPLATES_PER_THEME = 1000;

/** Template types this server is allowed to write. Deliberately narrow: pages and the homepage. */
export const WRITABLE_TEMPLATE_TYPES = ['page', 'index'] as const;

/** Section/block ids in JSON templates: letters, numbers, underscore, hyphen. */
export const ID_RE = /^[A-Za-z0-9_-]+$/;
/** Template suffix (the part between `page.` and `.json`). */
export const SUFFIX_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/;
