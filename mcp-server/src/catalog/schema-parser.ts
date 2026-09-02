/**
 * Parses `{% schema %}` blocks from section Liquid files into a compact,
 * human-readable catalog. Translation keys (`t:sections.foo.name`) are resolved
 * against locales/en.default.schema.json so Claude sees "Image banner", not a key.
 */
export interface SettingDef {
  id: string;
  type: string;
  label: string;
  default?: unknown;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  info?: string;
  accept?: string[];
}

export interface BlockDef {
  type: string;
  name: string;
  limit?: number;
  settings: SettingDef[];
}

export interface PresetDef { name: string; settings?: Record<string, unknown>; blocks?: Array<{ type: string; settings?: Record<string, unknown> }> }

export interface SectionEntry {
  /** Value used in template `type` — the filename without `.liquid`. */
  type: string;
  file: string;
  name: string;
  /** True when a merchant could add this section to a page-style template in the editor. */
  usable_in_page_templates: boolean;
  usability_notes: string[];
  max_blocks?: number;
  enabled_on?: { templates?: string[]; groups?: string[] };
  disabled_on?: { templates?: string[]; groups?: string[] };
  settings: SettingDef[];
  blocks: BlockDef[];
  presets: PresetDef[];
  /** Settings whose type takes an asset (image_picker / video / video_url), for quick asset planning. */
  asset_slots: Array<{ scope: 'section' | string; id: string; type: string; label: string }>;
}

export type Locale = Record<string, unknown>;

const SCHEMA_RE = /{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/;

export function extractSchema(liquid: string): { ok: true; schema: Record<string, unknown> } | { ok: false; error: string } {
  const m = SCHEMA_RE.exec(liquid);
  if (!m) return { ok: false, error: 'no {% schema %} block' };
  try {
    const parsed = JSON.parse(m[1]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'schema is not a JSON object' };
    return { ok: true, schema: parsed as Record<string, unknown> };
  } catch (e) {
    return { ok: false, error: `schema JSON invalid: ${(e as Error).message}` };
  }
}

/** Resolve `t:a.b.c` against the locale tree; returns the last path segment humanised if missing. */
export function translate(value: unknown, locale: Locale | undefined): string {
  if (typeof value !== 'string') return value == null ? '' : String(value);
  if (!value.startsWith('t:')) return value;
  const path = value.slice(2).split('.');
  let cur: unknown = locale;
  for (const seg of path) {
    if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) cur = (cur as Record<string, unknown>)[seg];
    else { cur = undefined; break; }
  }
  if (typeof cur === 'string') return cur;
  const last = path[path.length - 1] ?? value;
  return last.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function parseSettings(list: unknown, locale: Locale | undefined): SettingDef[] {
  if (!Array.isArray(list)) return [];
  const out: SettingDef[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.id !== 'string' || typeof s.type !== 'string') continue; // header/paragraph entries have no id
    const def: SettingDef = { id: s.id, type: s.type, label: translate(s.label, locale) };
    if ('default' in s) def.default = typeof s.default === 'string' ? translate(s.default, locale) : s.default;
    if (Array.isArray(s.options)) def.options = s.options.map((o) => ({ value: String((o as Record<string, unknown>).value), label: translate((o as Record<string, unknown>).label, locale) }));
    for (const k of ['min', 'max', 'step'] as const) if (typeof s[k] === 'number') def[k] = s[k] as number;
    if (typeof s.unit === 'string') def.unit = s.unit;
    if (typeof s.info === 'string') def.info = translate(s.info, locale);
    if (Array.isArray(s.accept)) def.accept = s.accept.map(String);
    out.push(def);
  }
  return out;
}

function parseBlocks(list: unknown, locale: Locale | undefined): BlockDef[] {
  if (!Array.isArray(list)) return [];
  const out: BlockDef[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Record<string, unknown>;
    if (typeof b.type !== 'string') continue;
    const def: BlockDef = { type: b.type, name: b.type === '@app' ? 'App block' : translate(b.name, locale) || b.type, settings: parseSettings(b.settings, locale) };
    if (typeof b.limit === 'number') def.limit = b.limit;
    out.push(def);
  }
  return out;
}

function parsePresets(list: unknown, locale: Locale | undefined): PresetDef[] {
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && typeof p === 'object').map((raw) => {
    const p = raw as Record<string, unknown>;
    const def: PresetDef = { name: translate(p.name, locale) };
    if (p.settings && typeof p.settings === 'object') def.settings = p.settings as Record<string, unknown>;
    if (Array.isArray(p.blocks)) def.blocks = p.blocks.map((b) => ({ type: String((b as Record<string, unknown>).type), ...((b as Record<string, unknown>).settings ? { settings: (b as Record<string, unknown>).settings as Record<string, unknown> } : {}) }));
    return def;
  });
}

const ASSET_TYPES = new Set(['image_picker', 'video', 'video_url']);

export function buildSectionEntry(file: string, liquid: string, locale: Locale | undefined): { entry: SectionEntry } | { error: string } {
  const type = file.replace(/^sections\//, '').replace(/\.liquid$/, '');
  const res = extractSchema(liquid);
  if (!res.ok) return { error: res.error };
  const schema = res.schema;
  const settings = parseSettings(schema.settings, locale);
  const blocks = parseBlocks(schema.blocks, locale);
  const presets = parsePresets(schema.presets, locale);
  const enabled_on = schema.enabled_on as SectionEntry['enabled_on'];
  const disabled_on = schema.disabled_on as SectionEntry['disabled_on'];

  const notes: string[] = [];
  let usable = true;
  if (presets.length === 0) { usable = false; notes.push('No presets: this section is not addable from the theme editor (it is a fixed "main" section, or belongs to header/footer groups).'); }
  if (type.startsWith('main-')) { usable = type === 'main-page' ? usable : false; if (type !== 'main-page') notes.push('This is the main section of a different template type (product, collection, etc.).'); }
  if (enabled_on?.templates && !enabled_on.templates.includes('page') && !enabled_on.templates.includes('*')) { usable = false; notes.push(`Only enabled on templates: ${enabled_on.templates.join(', ')}.`); }
  if (disabled_on?.templates && (disabled_on.templates.includes('page') || disabled_on.templates.includes('*'))) { usable = false; notes.push('Explicitly disabled on page templates.'); }
  if (type === 'main-page') { usable = true; notes.push('Renders the page title and body text; normally the first section of every page template.'); }

  const asset_slots: SectionEntry['asset_slots'] = [];
  for (const s of settings) if (ASSET_TYPES.has(s.type)) asset_slots.push({ scope: 'section', id: s.id, type: s.type, label: s.label });
  for (const b of blocks) for (const s of b.settings) if (ASSET_TYPES.has(s.type)) asset_slots.push({ scope: `block:${b.type}`, id: s.id, type: s.type, label: s.label });

  const entry: SectionEntry = {
    type, file, name: translate(schema.name, locale) || type,
    usable_in_page_templates: usable, usability_notes: notes,
    ...(typeof schema.max_blocks === 'number' ? { max_blocks: schema.max_blocks } : {}),
    ...(enabled_on ? { enabled_on } : {}), ...(disabled_on ? { disabled_on } : {}),
    settings, blocks, presets, asset_slots,
  };
  return { entry };
}
