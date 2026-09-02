import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { analyzeImage } from '../src/images/contrast.js';

const solid = (r: number, g: number, b: number) => sharp({ create: { width: 64, height: 64, channels: 3 as const, background: { r, g, b } } }).png().toBuffer();

async function checkerboard(): Promise<Buffer> {
  const px = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const v = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 255 : 0;
    const o = (y * 64 + x) * 3; px[o] = px[o + 1] = px[o + 2] = v;
  }
  return sharp(px, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
}

describe('image contrast analysis', () => {
  it('recommends light text on dark images', async () => {
    const a = await analyzeImage(await solid(15, 20, 40));
    expect(a.text).toBe('light');
    expect(a.suggested.overlay_opacity).toBe(0);
    expect(a.center_luminance).toBeLessThan(0.1);
    expect(a.is_busy).toBe(false);
  });

  it('recommends dark text on light, calm images', async () => {
    const a = await analyzeImage(await solid(245, 245, 240));
    expect(a.text).toBe('dark');
    expect(a.suggested.show_text_box).toBe(false);
    expect(a.center_luminance).toBeGreaterThan(0.85);
  });

  it('recommends light text plus overlay on mid-tone images', async () => {
    const a = await analyzeImage(await solid(150, 150, 150));
    expect(a.text).toBe('light');
    expect(a.suggested.overlay_opacity).toBeGreaterThanOrEqual(30);
  });

  it('flags busy imagery and suggests overlay/text box', async () => {
    const a = await analyzeImage(await checkerboard());
    expect(a.is_busy).toBe(true);
    expect(a.suggested.overlay_opacity + (a.suggested.show_text_box ? 1 : 0)).toBeGreaterThan(0);
    expect(a.recommendation).toMatch(/busy/i);
  });

  it('reports original dimensions and fails readably on junk', async () => {
    const a = await analyzeImage(await solid(0, 0, 0));
    expect(a.width).toBe(64);
    await expect(analyzeImage(Buffer.from('not an image'))).rejects.toMatchObject({ code: 'IMAGE_ANALYZE_FAILED' });
  });
});
