import type { Catalog } from '../catalog/catalog.js';
import type { SectionEntry, SettingDef } from '../catalog/schema-parser.js';
import { ID_RE, MAX_BLOCKS_PER_SECTION, MAX_SECTIONS_PER_TEMPLATE, SUFFIX_RE, WRITABLE_TEMPLATE_TYPES } from './limits.js';

export interface Issue { path: string; message: string; hint?: string }
export interface TemplateBlock { type: string; settings?: Record<string, unknown>; disabled?: boolean }
export interface TemplateSection { type: string; settings?: Record<string, unknown>; blocks?: Record<string, TemplateBlock>; block_order?: string[]; disabled?: boolean; custom_css?: string[] }
export interface TemplateJson { sections: Record<string, TemplateSection>; order: string[]; layout?: string | false; wrapper?: string; name?: string }

export interface ValidationResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
  template: TemplateJson | null;
  summary: { template_type: string | null; suffix: string | null; section_count: number; sections: Array<{ id: string; type: string; name: string; blocks: number }> };
}

export interface FilenameInfo { ok: boolean; error?: string; hint?: string; templateType: string | null; suffix: string | null }

export function parseTemplateFilename(filename: string): FilenameInfo {
  const m = /^templates\/([a-z0-9_-]+)(?:\.([^./]+))?\.json$/i.exec(filename);
  if (!m) return { ok: false, error: `"${filename}" is not a template filename. Expected templates/page.<name>.json or templates/index.json.`, templateType: null, suffix: null };
  const templateType = m[1];
  const suffix = m[2] ?? null;
  if (!(WRITABLE_TEMPLATE_TYPES as readonly string[]).includes(templateType)) {
    return { ok: false, error: `Only page templates (templates/page.*.json) and the homepage (templates/index.json) can be edited with this tool; "${templateType}" templates are off limits.`, templateType, suffix };
  }
  if (suffix !== null && !SUFFIX_RE.test(suffix)) {
    return { ok: false, error: `Template name "${suffix}" may only contain letters, numbers, hyphens and underscores.`, hint: 'Use something like page.about-us.json', templateType, suffix };
  }
  return { ok: true, templateType, suffix };
}

const IMAGE_REF = /^shopify:\/\/shop_images\/[^\s/]+$/;
const VIDEO_REF = /^shopify:\/\/files\/videos\/[^\s/]+$/;
const HTTP_RE = /^https?:\/\//i;
const RICHTEXT_START = /^\s*<(p|h[1-6]|ul|ol|div|blockquote)\b/i;

function isPlainObject(v: unknown): v is Record<string, unknown> { return !!v && typeof v === 'object' && !Array.isArray(v); }

function checkSettingValue(def: SettingDef, value: unknown, path: string, catalog: Catalog, errors: Issue[], warnings: Issue[]): void {
  const t = def.type;
  const typeErr = (expected: string): void => { errors.push({ path, message: `"${def.id}" (${def.label}) must be ${expected}, got ${JSON.stringify(value)}.` }); };
  switch (t) {
    case 'select':
    case 'radio': {
      if (typeof value !== 'string') return typeErr('one of the listed options');
      const allowed = (def.options ?? []).map((o) => o.value);
      if (allowed.length && !allowed.includes(value)) errors.push({ path, message: `"${def.id}" (${def.label}) must be one of: ${allowed.join(', ')} — got "${value}".` });
      return;
    }
    case 'range': {
      if (typeof value !== 'number' || Number.isNaN(value)) return typeErr('a number');
      if (def.min !== undefined && value < def.min) errors.push({ path, message: `"${def.id}" (${def.label}) must be at least ${def.min}${def.unit ?? ''}, got ${value}.` });
      if (def.max !== undefined && value > def.max) errors.push({ path, message: `"${def.id}" (${def.label}) must be at most ${def.max}${def.unit ?? ''}, got ${value}.` });
      if (def.step !== undefined && def.min !== undefined && def.step > 0) {
        const k = (value - def.min) / def.step;
        if (Math.abs(k - Math.round(k)) > 1e-9) warnings.push({ path, message: `"${def.id}" (${def.label}) should be a multiple of ${def.step} starting at ${def.min}; ${value} will be rounded by Shopify.` });
      }
      return;
    }
    case 'checkbox':
      if (typeof value !== 'boolean') typeErr('true or false');
      return;
    case 'number':
      if (typeof value !== 'number') typeErr('a number');
      return;
    case 'image_picker':
      if (value === '' || value === null) return;
      if (typeof value !== 'string') return typeErr('an image reference');
      if (HTTP_RE.test(value)) { errors.push({ path, message: `"${def.id}" (${def.label}) is a web URL; images must be uploaded to the store first and referenced as shopify://shop_images/<filename>.`, hint: 'Use upload_file_from_url or search_files to get the reference.' }); return; }
      if (!IMAGE_REF.test(value)) errors.push({ path, message: `"${def.id}" (${def.label}) must look like shopify://shop_images/<filename>, got "${value}".` });
      return;
    case 'video':
      if (value === '' || value === null) return;
      if (typeof value !== 'string' || HTTP_RE.test(value) || !VIDEO_REF.test(value)) errors.push({ path, message: `"${def.id}" (${def.label}) must reference a hosted video as shopify://files/videos/<filename>; for YouTube/Vimeo use a video_url setting instead.` });
      return;
    case 'video_url': {
      if (value === '' || value === null) return;
      if (typeof value !== 'string') return typeErr('a YouTube or Vimeo link');
      const accept = def.accept?.length ? def.accept : ['youtube', 'vimeo'];
      const okHost = accept.some((p) => (p === 'youtube' ? /(youtube\.com|youtu\.be)/i : /vimeo\.com/i).test(value));
      if (!okHost) errors.push({ path, message: `"${def.id}" (${def.label}) must be a ${accept.join(' or ')} link, got "${value}".` });
      return;
    }
    case 'url':
      if (value === '' || value === null) return;
      if (typeof value !== 'string') return typeErr('a link');
      if (!/^(shopify:\/\/|\/|https?:\/\/|mailto:|tel:|#)/i.test(value)) warnings.push({ path, message: `"${def.id}" (${def.label}) looks like an unusual link: "${value}". Internal links are usually shopify://collections/<handle>, shopify://products/<handle>, shopify://pages/<handle> or /path.` });
      return;
    case 'richtext':
      if (typeof value !== 'string') return typeErr('text');
      if (value.trim() && !RICHTEXT_START.test(value)) errors.push({ path, message: `"${def.id}" (${def.label}) is rich text and must be wrapped in <p>…</p> (or a heading/list tag).`, hint: 'Example: "<p>Your text here</p>"' });
      return;
    case 'inline_richtext':
    case 'text':
    case 'textarea':
    case 'html':
      if (typeof value !== 'string') typeErr('text');
      if (t === 'html' && typeof value === 'string' && /<script/i.test(value)) errors.push({ path, message: `"${def.id}" must not contain <script> tags.` });
      return;
    case 'liquid':
      if (typeof value !== 'string') return typeErr('text');
      warnings.push({ path, message: `"${def.id}" is a Liquid setting; the page builder is meant to compose existing sections, not write code. Keep this to plain text/HTML.` });
      return;
    case 'color_scheme':
      if (typeof value !== 'string') return typeErr('a color scheme id');
      if (catalog.color_schemes.length && !catalog.color_schemes.includes(value)) warnings.push({ path, message: `Color scheme "${value}" is not one of the theme's schemes (${catalog.color_schemes.join(', ')}).` });
      return;
    case 'color':
      if (typeof value !== 'string' || !/^(#[0-9a-f]{3,8}|rgba?\(.*\)|transparent)$/i.test(value)) warnings.push({ path, message: `"${def.id}" should be a hex color like #ffffff.` });
      return;
    case 'collection_list':
    case 'product_list':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) typeErr('a list of handles');
      return;
    case 'collection':
    case 'product':
    case 'page':
    case 'blog':
    case 'article':
    case 'link_list':
    case 'metaobject':
    case 'font_picker':
    case 'text_alignment':
    case 'color_background':
      if (value !== null && typeof value !== 'string') return typeErr('a handle (text)');
      if (typeof value === 'string' && HTTP_RE.test(value)) warnings.push({ path, message: `"${def.id}" (${def.label}) expects a handle like "summer-sale", not a URL.` });
      return;
    default:
      return; // unknown setting type: accept
  }
}

function checkSettings(defs: SettingDef[], settings: unknown, path: string, catalog: Catalog, errors: Issue[], warnings: Issue[]): void {
  if (settings === undefined) return;
  if (!isPlainObject(settings)) return void errors.push({ path, message: 'settings must be an object.' });
  const byId = new Map(defs.map((d) => [d.id, d]));
  for (const [id, value] of Object.entries(settings)) {
    const def = byId.get(id);
    if (!def) { warnings.push({ path: `${path}.${id}`, message: `Unknown setting "${id}" — it will be ignored by the theme.` }); continue; }
    checkSettingValue(def, value, `${path}.${id}`, catalog, errors, warnings);
  }
}

export function validateTemplate(input: unknown, catalog: Catalog, opts: { filename: string }): ValidationResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const summary: ValidationResult['summary'] = { template_type: null, suffix: null, section_count: 0, sections: [] };

  const fn = parseTemplateFilename(opts.filename);
  summary.template_type = fn.templateType; summary.suffix = fn.suffix;
  if (!fn.ok) errors.push({ path: 'filename', message: fn.error!, hint: fn.hint });
  else if (fn.templateType === 'page' && fn.suffix === null) warnings.push({ path: 'filename', message: 'templates/page.json is the default template for every page without a custom template; changing it affects all of them.' });

  let tpl: unknown = input;
  if (typeof input === 'string') {
    try { tpl = JSON.parse(input); } catch (e) { errors.push({ path: '$', message: `The template is not valid JSON: ${(e as Error).message}` }); return { ok: false, errors, warnings, template: null, summary }; }
  }
  if (!isPlainObject(tpl)) { errors.push({ path: '$', message: 'The template must be a JSON object.' }); return { ok: false, errors, warnings, template: null, summary }; }

  for (const k of Object.keys(tpl)) if (!['sections', 'order', 'layout', 'wrapper', 'name'].includes(k)) warnings.push({ path: `$.${k}`, message: `Unexpected top-level key "${k}".` });
  const sections = tpl.sections;
  const order = tpl.order;
  if (!isPlainObject(sections)) errors.push({ path: '$.sections', message: '"sections" must be an object keyed by section id.' });
  if (!Array.isArray(order) || !order.every((o) => typeof o === 'string')) errors.push({ path: '$.order', message: '"order" must be an array of section ids.' });
  if (errors.some((e) => e.path.startsWith('$'))) return { ok: false, errors, warnings, template: null, summary };

  const secMap = sections as Record<string, unknown>;
  const orderArr = order as string[];
  const ids = Object.keys(secMap);
  summary.section_count = ids.length;
  if (ids.length > MAX_SECTIONS_PER_TEMPLATE) errors.push({ path: '$.sections', message: `A template can have at most ${MAX_SECTIONS_PER_TEMPLATE} sections; this one has ${ids.length}.` });
  if (ids.length === 0) errors.push({ path: '$.sections', message: 'The template has no sections.' });
  const seen = new Set<string>();
  for (const id of orderArr) {
    if (!(id in secMap)) errors.push({ path: '$.order', message: `"order" lists "${id}" but there is no such section.` });
    if (seen.has(id)) errors.push({ path: '$.order', message: `"${id}" appears more than once in "order".` });
    seen.add(id);
  }
  for (const id of ids) if (!seen.has(id)) errors.push({ path: `$.sections.${id}`, message: `Section "${id}" is missing from "order" and would never render.` });

  const catalogByType = new Map<string, SectionEntry>(catalog.sections.map((s) => [s.type, s]));
  const hasMain = ids.some((id) => isPlainObject(secMap[id]) && (secMap[id] as Record<string, unknown>).type === 'main-page');
  if (fn.templateType === 'page' && !hasMain) warnings.push({ path: '$.sections', message: 'No "main-page" section: the page title and body text will not be shown. That is fine for a fully custom landing page, otherwise add it first.' });

  for (const id of ids) {
    const path = `$.sections.${id}`;
    if (!ID_RE.test(id)) errors.push({ path, message: `Section id "${id}" may only contain letters, numbers, hyphens and underscores.` });
    const sec = secMap[id];
    if (!isPlainObject(sec) || typeof sec.type !== 'string') { errors.push({ path, message: 'Each section needs a "type".' }); continue; }
    const entry = catalogByType.get(sec.type);
    if (!entry) {
      const known = catalog.sections.filter((s) => s.usable_in_page_templates).map((s) => s.type);
      errors.push({ path: `${path}.type`, message: `Section type "${sec.type}" does not exist in this theme.`, hint: `Available: ${known.join(', ')}` });
      continue;
    }
    if (!entry.usable_in_page_templates && !(entry.type === 'main-page')) {
      errors.push({ path: `${path}.type`, message: `Section "${entry.name}" (${entry.type}) cannot be used on this kind of page. ${entry.usability_notes.join(' ')}` });
    }
    const tt = fn.templateType ?? 'page';
    if (entry.enabled_on?.templates && !entry.enabled_on.templates.includes(tt) && !entry.enabled_on.templates.includes('*')) errors.push({ path: `${path}.type`, message: `"${entry.name}" is only allowed on ${entry.enabled_on.templates.join(', ')} templates.` });
    if (entry.disabled_on?.templates && (entry.disabled_on.templates.includes(tt) || entry.disabled_on.templates.includes('*'))) errors.push({ path: `${path}.type`, message: `"${entry.name}" is disabled on ${tt} templates.` });

    checkSettings(entry.settings, sec.settings, `${path}.settings`, catalog, errors, warnings);
    if (sec.disabled !== undefined && typeof sec.disabled !== 'boolean') errors.push({ path: `${path}.disabled`, message: '"disabled" must be true or false.' });
    if (sec.custom_css !== undefined) warnings.push({ path: `${path}.custom_css`, message: 'custom_css present. The page builder should not add CSS; keep only what the merchant already had.' });

    let blockCount = 0;
    const blocks = sec.blocks;
    if (blocks !== undefined) {
      if (!isPlainObject(blocks)) { errors.push({ path: `${path}.blocks`, message: '"blocks" must be an object keyed by block id.' }); }
      else {
        const blockIds = Object.keys(blocks);
        blockCount = blockIds.length;
        if (blockIds.length > MAX_BLOCKS_PER_SECTION) errors.push({ path: `${path}.blocks`, message: `A section can have at most ${MAX_BLOCKS_PER_SECTION} blocks; "${id}" has ${blockIds.length}.` });
        if (entry.max_blocks !== undefined && blockIds.length > entry.max_blocks) errors.push({ path: `${path}.blocks`, message: `"${entry.name}" allows at most ${entry.max_blocks} blocks; "${id}" has ${blockIds.length}.` });
        const bo = sec.block_order;
        if (bo !== undefined && (!Array.isArray(bo) || !bo.every((b) => typeof b === 'string'))) errors.push({ path: `${path}.block_order`, message: '"block_order" must be an array of block ids.' });
        const boArr = Array.isArray(bo) ? (bo as string[]) : [];
        if (blockIds.length && bo === undefined) errors.push({ path: `${path}.block_order`, message: `Section "${id}" has blocks but no "block_order"; blocks would not render.` });
        for (const b of boArr) if (!(b in blocks)) errors.push({ path: `${path}.block_order`, message: `"block_order" lists "${b}" but there is no such block.` });
        for (const b of blockIds) if (bo !== undefined && !boArr.includes(b)) errors.push({ path: `${path}.blocks.${b}`, message: `Block "${b}" is missing from "block_order".` });
        const perType = new Map<string, number>();
        for (const bid of blockIds) {
          const bpath = `${path}.blocks.${bid}`;
          if (!ID_RE.test(bid)) errors.push({ path: bpath, message: `Block id "${bid}" may only contain letters, numbers, hyphens and underscores.` });
          const blk = blocks[bid];
          if (!isPlainObject(blk) || typeof blk.type !== 'string') { errors.push({ path: bpath, message: 'Each block needs a "type".' }); continue; }
          if (blk.type.startsWith('shopify://apps/')) {
            if (!entry.blocks.some((d) => d.type === '@app')) errors.push({ path: `${bpath}.type`, message: `"${entry.name}" does not accept app blocks.` });
            else warnings.push({ path: `${bpath}.type`, message: 'App block settings are not validated.' });
            continue;
          }
          const bdef = entry.blocks.find((d) => d.type === blk.type);
          if (!bdef) { errors.push({ path: `${bpath}.type`, message: `Block type "${blk.type}" is not valid inside "${entry.name}".`, hint: `Valid block types: ${entry.blocks.map((d) => d.type).join(', ') || 'none — this section has no blocks'}` }); continue; }
          perType.set(blk.type, (perType.get(blk.type) ?? 0) + 1);
          checkSettings(bdef.settings, blk.settings, `${bpath}.settings`, catalog, errors, warnings);
        }
        for (const bdef of entry.blocks) if (bdef.limit !== undefined && (perType.get(bdef.type) ?? 0) > bdef.limit) errors.push({ path: `${path}.blocks`, message: `"${entry.name}" allows at most ${bdef.limit} "${bdef.name}" block(s); "${id}" has ${perType.get(bdef.type)}.` });
      }
    } else if (sec.block_order !== undefined) {
      warnings.push({ path: `${path}.block_order`, message: '"block_order" given without any blocks.' });
    }
    summary.sections.push({ id, type: entry.type, name: entry.name, blocks: blockCount });
  }

  return { ok: errors.length === 0, errors, warnings, template: errors.length === 0 ? (tpl as unknown as TemplateJson) : null, summary };
}
