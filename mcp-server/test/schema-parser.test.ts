import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/catalog/catalog.js';
import { buildSectionEntry, extractSchema, translate } from '../src/catalog/schema-parser.js';

const THEME_ROOT = resolve(__dirname, '..', '..');

export function loadThemeFiles(): Map<string, string> {
  const files = new Map<string, string>();
  for (const f of readdirSync(join(THEME_ROOT, 'sections'))) if (f.endsWith('.liquid')) files.set(`sections/${f}`, readFileSync(join(THEME_ROOT, 'sections', f), 'utf8'));
  files.set('locales/en.default.schema.json', readFileSync(join(THEME_ROOT, 'locales', 'en.default.schema.json'), 'utf8'));
  files.set('config/settings_data.json', readFileSync(join(THEME_ROOT, 'config', 'settings_data.json'), 'utf8'));
  return files;
}

export const LIMITS = { max_sections_per_template: 25, max_blocks_per_section: 50 };

describe('section schema parser against the real Dawn theme', () => {
  const files = loadThemeFiles();
  const cat = buildCatalog(files, 'test', LIMITS, () => 0);

  it('parses every section that has a schema and reports the ones that do not', () => {
    const liquidCount = [...files.keys()].filter((f) => f.startsWith('sections/')).length;
    expect(cat.sections.length + cat.skipped.filter((s) => s.file.startsWith('sections/')).length).toBe(liquidCount);
    expect(cat.sections.length).toBeGreaterThanOrEqual(38);
    for (const s of cat.skipped) expect(s.reason).toMatch(/no \{% schema %\} block/);
    expect(cat.skipped.map((s) => s.file)).toContain('sections/cart-drawer.liquid');
  });

  it('resolves translation keys to human names and labels', () => {
    const banner = cat.sections.find((s) => s.type === 'image-banner')!;
    expect(banner.name).toBe('Image banner');
    expect(banner.settings.find((s) => s.id === 'image_overlay_opacity')?.label).toBe('Overlay opacity');
    const height = banner.settings.find((s) => s.id === 'image_height')!;
    expect(height.type).toBe('select');
    expect(height.options?.map((o) => o.value)).toEqual(['adapt', 'small', 'medium', 'large']);
    expect(height.options?.[1].label).toBe('Small');
    expect(height.default).toBe('medium');
  });

  it('captures blocks, limits, ranges and asset slots', () => {
    const slideshow = cat.sections.find((s) => s.type === 'slideshow')!;
    expect(slideshow.blocks.find((b) => b.type === 'slide')?.limit).toBe(5);
    const banner = cat.sections.find((s) => s.type === 'image-banner')!;
    expect(banner.blocks.map((b) => b.type)).toEqual(expect.arrayContaining(['heading', 'text', 'buttons']));
    const opacity = banner.settings.find((s) => s.id === 'image_overlay_opacity')!;
    expect(opacity).toMatchObject({ type: 'range', min: 0, max: 100, step: 10, unit: '%' });
    expect(banner.asset_slots.map((a) => a.id)).toEqual(['image', 'image_2']);
    const video = cat.sections.find((s) => s.type === 'video')!;
    expect(video.asset_slots.map((a) => `${a.id}:${a.type}`)).toEqual(expect.arrayContaining(['video:video', 'video_url:video_url', 'cover_image:image_picker']));
    const multicolumn = cat.sections.find((s) => s.type === 'multicolumn')!;
    expect(multicolumn.blocks[0].type).toBe('column');
    expect(multicolumn.blocks[0].settings.map((s) => s.id)).toEqual(['image', 'title', 'text', 'link_label', 'link']);
    expect(multicolumn.presets[0].blocks?.length).toBe(3);
  });

  it('classifies which sections can go on a page', () => {
    const byType = Object.fromEntries(cat.sections.map((s) => [s.type, s]));
    expect(byType['main-page'].usable_in_page_templates).toBe(true);
    expect(byType['rich-text'].usable_in_page_templates).toBe(true);
    expect(byType['image-banner'].usable_in_page_templates).toBe(true);
    expect(byType['main-product'].usable_in_page_templates).toBe(false);
    expect(byType['header'].usable_in_page_templates).toBe(false);
    expect(byType['footer'].usable_in_page_templates).toBe(false);
    expect(byType['related-products'].usable_in_page_templates).toBe(false); // no presets
    expect(byType['quick-order-list'].usable_in_page_templates).toBe(false); // enabled_on templates: product
    expect(byType['apps'].blocks[0]).toMatchObject({ type: '@app', name: 'App block' });
  });

  it('reads color schemes from settings_data.json despite the comment header', () => {
    expect(cat.color_schemes.map((c) => c.id)).toContain('scheme-1');
    const s1 = cat.color_schemes.find((c) => c.id === 'scheme-1')!;
    expect(s1.background).toBe('#FFFFFF');
    expect(s1.text).toBe('#121212');
    expect(s1.text_is_light).toBe(false);
    expect(cat.skipped.find((s) => s.file === 'config/settings_data.json')).toBeUndefined();
  });

  it('handles malformed schemas gracefully', () => {
    expect(extractSchema('<div></div>')).toEqual({ ok: false, error: 'no {% schema %} block' });
    const bad = buildSectionEntry('sections/broken.liquid', '{% schema %}{ "name": "x", }{% endschema %}', {});
    expect('error' in bad && bad.error).toMatch(/schema JSON invalid/);
    const arr = buildSectionEntry('sections/arr.liquid', '{% schema %}[1,2]{% endschema %}', {});
    expect('error' in arr && arr.error).toMatch(/not a JSON object/);
    const good = buildSectionEntry('sections/min.liquid', '{%- schema -%}{"name":"t:sections.nope.name","settings":[{"type":"header","content":"x"},{"type":"text","id":"t","label":"T"}],"presets":[{"name":"Min"}]}{%- endschema -%}', {});
    expect('entry' in good && good.entry.name).toBe('Name');
    expect('entry' in good && good.entry.settings.map((s) => s.id)).toEqual(['t']);
    expect(translate('t:a.b.c', { a: { b: { c: 'Deep' } } })).toBe('Deep');
    expect(translate('plain', {})).toBe('plain');
  });
});
