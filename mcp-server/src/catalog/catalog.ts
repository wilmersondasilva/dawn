import { parseJsonLoose } from '../util.js';
import { buildSectionEntry, type Locale, type SectionEntry } from './schema-parser.js';

export interface CatalogSource {
  /** Return {filename → content} for sections/*.liquid, locales/en.default.schema.json and config/settings_data.json. */
  loadFiles(): Promise<Map<string, string>>;
}

export interface Catalog {
  fetched_at: string;
  source: string;
  sections: SectionEntry[];
  skipped: Array<{ file: string; reason: string }>;
  color_schemes: string[];
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
  let color_schemes: string[] = [];
  const settingsData = files.get('config/settings_data.json');
  if (settingsData) {
    try {
      const sd = parseJsonLoose<{ current?: { color_schemes?: Record<string, unknown> } | string; presets?: Record<string, { color_schemes?: Record<string, unknown> }> }>(settingsData);
      const cur = typeof sd.current === 'string' ? sd.presets?.[sd.current] : sd.current;
      color_schemes = Object.keys(cur?.color_schemes ?? {});
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
