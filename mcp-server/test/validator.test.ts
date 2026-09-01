import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/catalog/catalog.js';
import { validateTemplate, parseTemplateFilename } from '../src/validation/template-validator.js';
import { LIMITS, loadThemeFiles } from './schema-parser.test.js';

const THEME_ROOT = resolve(__dirname, '..', '..');
const cat = buildCatalog(loadThemeFiles(), 'test', LIMITS, () => 0);
const v = (tpl: unknown, filename = 'templates/page.test.json') => validateTemplate(tpl, cat, { filename });
const msgs = (r: ReturnType<typeof v>) => r.errors.map((e) => e.message).join('\n');

const base = () => ({
  sections: {
    main: { type: 'main-page', settings: { padding_top: 36, padding_bottom: 36 } },
    hero: {
      type: 'image-banner',
      blocks: { h: { type: 'heading', settings: { heading: 'Hello', heading_size: 'h1' } }, b: { type: 'buttons', settings: { button_label_1: 'Shop', button_link_1: 'shopify://collections/all' } } },
      block_order: ['h', 'b'],
      settings: { image: 'shopify://shop_images/hero.jpg', image_height: 'large', image_overlay_opacity: 40, color_scheme: 'scheme-1' },
    },
  },
  order: ['main', 'hero'],
});

describe('template validation', () => {
  it('accepts the theme\'s real page.contact.json and index.json', () => {
    const contact = readFileSync(join(THEME_ROOT, 'templates', 'page.contact.json'), 'utf8');
    const r = v(contact, 'templates/page.contact.json');
    expect(msgs(r)).toBe('');
    expect(r.ok).toBe(true);
    expect(r.summary.sections.map((s) => s.type)).toEqual(['main-page', 'contact-form']);
    const index = readFileSync(join(THEME_ROOT, 'templates', 'index.json'), 'utf8');
    const ri = v(index, 'templates/index.json');
    expect(msgs(ri)).toBe('');
    expect(ri.ok).toBe(true);
  });

  it('accepts a well-formed hero page and returns an outline', () => {
    const r = v(base());
    expect(msgs(r)).toBe('');
    expect(r.summary.sections).toEqual([{ id: 'main', type: 'main-page', name: 'Page', blocks: 0 }, { id: 'hero', type: 'image-banner', name: 'Image banner', blocks: 2 }]);
  });

  it('rejects unknown sections, blocks and bad option values', () => {
    const t = base() as any;
    t.sections.hero.type = 'mega-hero';
    expect(msgs(v(t))).toMatch(/Section type "mega-hero" does not exist/);
    const t2 = base() as any;
    t2.sections.hero.blocks.h.type = 'subtitle';
    expect(msgs(v(t2))).toMatch(/Block type "subtitle" is not valid inside "Image banner"/);
    const t3 = base() as any;
    t3.sections.hero.settings.image_height = 'huge';
    expect(msgs(v(t3))).toMatch(/must be one of: adapt, small, medium, large/);
    const t4 = base() as any;
    t4.sections.hero.settings.image_overlay_opacity = 140;
    expect(msgs(v(t4))).toMatch(/at most 100%/);
    const t5 = base() as any;
    t5.sections.hero.settings.image_overlay_opacity = '40';
    expect(msgs(v(t5))).toMatch(/must be a number/);
  });

  it('rejects raw URLs in image settings and requires shopify:// references', () => {
    const t = base() as any;
    t.sections.hero.settings.image = 'https://cdn.example.com/hero.jpg';
    const r = v(t);
    expect(msgs(r)).toMatch(/must be uploaded to the store first/);
    expect(r.errors[0].hint).toMatch(/upload_file_from_url/);
    const t2 = base() as any;
    t2.sections.hero.settings.image = 'hero.jpg';
    expect(msgs(v(t2))).toMatch(/shopify:\/\/shop_images/);
  });

  it('checks structure: order/sections consistency, block_order, ids', () => {
    const t = base() as any;
    t.order = ['main', 'hero', 'ghost'];
    expect(msgs(v(t))).toMatch(/"ghost" but there is no such section/);
    const t2 = base() as any;
    t2.order = ['main'];
    expect(msgs(v(t2))).toMatch(/Section "hero" is missing from "order"/);
    const t3 = base() as any;
    delete t3.sections.hero.block_order;
    expect(msgs(v(t3))).toMatch(/has blocks but no "block_order"/);
    const t4 = base() as any;
    t4.sections['bad id!'] = { type: 'rich-text' };
    t4.order.push('bad id!');
    expect(msgs(v(t4))).toMatch(/may only contain letters/);
    expect(v('{not json').errors[0].message).toMatch(/not valid JSON/);
    expect(v({ order: [] }).errors[0].message).toMatch(/"sections" must be an object/);
  });

  it('enforces block limits (per-type limit, max_blocks, platform caps) and section cap', () => {
    const t = base() as any;
    t.sections.slides = { type: 'slideshow', blocks: {}, block_order: [] };
    for (let i = 0; i < 6; i++) { t.sections.slides.blocks[`s${i}`] = { type: 'slide', settings: {} }; t.sections.slides.block_order.push(`s${i}`); }
    t.order.push('slides');
    expect(msgs(v(t))).toMatch(/at most 5 "Slide" block/);
    const many: any = { sections: {}, order: [] };
    for (let i = 0; i < 26; i++) { many.sections[`r${i}`] = { type: 'rich-text' }; many.order.push(`r${i}`); }
    expect(msgs(v(many))).toMatch(/at most 25 sections/);
    const big: any = { sections: { m: { type: 'multicolumn', blocks: {}, block_order: [] } }, order: ['m'] };
    for (let i = 0; i < 51; i++) { big.sections.m.blocks[`c${i}`] = { type: 'column' }; big.sections.m.block_order.push(`c${i}`); }
    expect(msgs(v(big))).toMatch(/at most 50 blocks/);
  });

  it('rejects sections that cannot live on a page and wrong template files', () => {
    const t = base() as any;
    t.sections.prod = { type: 'main-product' };
    t.order.push('prod');
    expect(msgs(v(t))).toMatch(/cannot be used on this kind of page/);
    const t2 = base() as any;
    t2.sections.rel = { type: 'quick-order-list' };
    t2.order.push('rel');
    expect(msgs(v(t2))).toMatch(/only allowed on product templates/);
    expect(parseTemplateFilename('templates/product.special.json').ok).toBe(false);
    expect(parseTemplateFilename('config/settings_data.json').ok).toBe(false);
    expect(parseTemplateFilename('templates/page.bad name.json').ok).toBe(false);
    expect(parseTemplateFilename('templates/page.about-us.json')).toMatchObject({ ok: true, templateType: 'page', suffix: 'about-us' });
    expect(parseTemplateFilename('templates/index.json')).toMatchObject({ ok: true, templateType: 'index', suffix: null });
  });

  it('warns on unknown settings and default-template edits; errors on unwrapped richtext', () => {
    const t = base() as any;
    t.sections.hero.settings.made_up = 1;
    const r = v(t);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.message).join()).toMatch(/Unknown setting "made_up"/);
    const t2: any = { sections: { main: { type: 'main-page' }, txt: { type: 'rich-text', blocks: { p: { type: 'text', settings: { text: 'no paragraph tag' } } }, block_order: ['p'] } }, order: ['main', 'txt'] };
    expect(msgs(v(t2))).toMatch(/wrapped in <p>/);
    t2.sections.txt.blocks.p.settings.text = '<p>ok</p>';
    expect(v(t2).ok).toBe(true);
    expect(v(base(), 'templates/page.json').warnings.map((w) => w.message).join()).toMatch(/default template for every page/);
  });
});
