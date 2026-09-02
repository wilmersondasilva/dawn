import { parseJsonLoose } from '../util.js';
import { buildSectionEntry, type Locale, type SectionEntry } from './schema-parser.js';

export interface ColorSchemeInfo {
  id: string;
  background: string | null;
  text: string | null;
  /** True when the scheme's text colour is light (usable over dark images). */
  text_is_light: boolean | null;
}

function hexLightness(hex: string | null): number | null {
  if (!hex) return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const lin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const y = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  const l = y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : y * (24389 / 27);
  return Math.min(1, Math.max(0, l / 100));
}

export interface CatalogSource {
  /** Return {filename → content} for sections/*.liquid, locales/en.default.schema.json and config/settings_data.json. */
  loadFiles(): Promise<Map<string, string>>;
}

export interface Catalog {
  fetched_at: string;
  source: string;
  sections: SectionEntry[];
  skipped: Array<{ file: string; reason: string }>;
  color_schemes: ColorSchemeInfo[];
  limits: { max_sections_per_template: number; max_blocks_per_section: number };
}

export const CATALOG_FILE_PATTERNS = ['sections/*.liquid', 'locales/en.default.schema.json', 'config/settings_data.json'];

export function buildCatalog(files: Map<string, string>, source: string, limits: Catalog['limits'], now: () => number = Date.now): Catalog {
  let locale: Locale | undefined;
  const localeText = files.get('locales/en.default.schema.json');
  const skipped: Catalog['skipped'] = [];
  if (localeText) {
    try { locale = parseJsonLoose<Locale>(localeText); } catch (e) { skipped.push({ file: 'locales/en.default.schema.json', reason: `could not parse: ${(e as Error).message}` }); }
  }
  const sections: SectionEntry[] = [];
  for (const [file, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!file.startsWith('sections/') || !file.endsWith('.liquid')) continue;
    const r = buildSectionEntry(file, content, locale);
    if ('entry' in r) sections.push(r.entry); else skipped.push({ file, reason: r.error });
  }
  let color_schemes: ColorSchemeInfo[] = [];
  const settingsData = files.get('config/settings_data.json');
  if (settingsData) {
    try {
      const sd = parseJsonLoose<{ current?: { color_schemes?: Record<string, { settings?: Record<string, string> }> } | string; presets?: Record<string, { color_schemes?: Record<string, { settings?: Record<string, string> }> }> }>(settingsData);
      const cur = typeof sd.current === 'string' ? sd.presets?.[sd.current] : sd.current;
      color_schemes = Object.entries(cur?.color_schemes ?? {}).map(([id, def]) => {
        const text = def?.settings?.text ?? null;
        const lum = hexLightness(text);
        return { id, background: def?.settings?.background ?? null, text, text_is_light: lum === null ? null : lum > 0.6 };
      });
    } catch (e) { skipped.push({ file: 'config/settings_data.json', reason: `could not parse: ${(e as Error).message}` }); }
  }
  return { fetched_at: new Date(now()).toISOString(), source, sections, skipped, color_schemes, limits };
}

/** Cached catalog with a short TTL and a manual refresh. */
export class SectionCatalog {
  private cache: { at: number; value: Catalog } | null = null;
  private inflight: Promise<Catalog> | null = null;
  constructor(private readonly src: CatalogSource, private readonly opts: { ttlMs: number; sourceLabel: string; limits: Catalog['limits']; now?: () => number }) {}

  async get(refresh = false): Promise<Catalog> {
    const now = this.opts.now ?? Date.now;
    if (!refresh && this.cache && now() - this.cache.at < this.opts.ttlMs) return this.cache.value;
    if (!this.inflight) {
      this.inflight = (async () => {
        const files = await this.src.loadFiles();
        const value = buildCatalog(files, this.opts.sourceLabel, this.opts.limits, now);
        this.cache = { at: now(), value };
        return value;
      })().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  invalidate(): void { this.cache = null; }
}
