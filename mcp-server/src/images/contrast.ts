import sharp from 'sharp';
import { ToolError } from '../util.js';

/**
 * Decide whether text placed over an image should be light or dark.
 * The image is downscaled and its relative luminance measured — overall,
 * and in the center region (where banner text usually sits). "Busyness"
 * (luminance standard deviation) tells us when no single text colour will
 * read cleanly and an overlay or text box is needed.
 */
export interface ContrastAnalysis {
  width: number;
  height: number;
  /** 0 (black) … 1 (white), perceptual lightness (CIE L* / 100). */
  average_luminance: number;
  center_luminance: number;
  /** Std dev of luminance; > ~0.22 means high-contrast/busy imagery. */
  busyness: number;
  is_busy: boolean;
  text: 'light' | 'dark';
  recommendation: string;
  suggested: { text: 'light' | 'dark'; overlay_opacity: number; show_text_box: boolean };
}

const srgbToLinear = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** Linear luminance Y → perceptual lightness (CIE L*), scaled 0..1. */
const toLightness = (y: number): number => {
  const l = y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : y * (24389 / 27);
  return Math.min(1, Math.max(0, l / 100));
};

export async function analyzeImage(buf: Buffer): Promise<ContrastAnalysis> {
  let data: Buffer; let info: { width: number; height: number; channels: number };
  let meta: { width?: number; height?: number };
  try {
    const img = sharp(buf, { limitInputPixels: 80_000_000 });
    meta = await img.metadata();
    const raw = await img.resize(48, 48, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    data = raw.data; info = raw.info;
  } catch (e) {
    throw new ToolError('Could not read the image to measure its colors.', 'Make sure the link points at an actual image file (JPG/PNG/WEBP).', 'IMAGE_ANALYZE_FAILED', String(e));
  }
  const { width: w, height: h, channels } = info;
  const lums: number[] = [];
  for (let i = 0; i < w * h; i++) {
    const o = i * channels;
    lums.push(toLightness(0.2126 * srgbToLinear(data[o]) + 0.7152 * srgbToLinear(data[o + 1]) + 0.0722 * srgbToLinear(data[o + 2])));
  }
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
  const busyness = Math.sqrt(lums.reduce((a, b) => a + (b - mean) ** 2, 0) / lums.length);
  // Center region: middle 50% box.
  let cSum = 0; let cN = 0;
  for (let y = Math.floor(h * 0.25); y < Math.ceil(h * 0.75); y++)
    for (let x = Math.floor(w * 0.25); x < Math.ceil(w * 0.75); x++) { cSum += lums[y * w + x]; cN++; }
  const center = cN ? cSum / cN : mean;
  const is_busy = busyness > 0.22;

  let text: 'light' | 'dark'; let overlay = 0; let textBox = false; let rec: string;
  if (center <= 0.45) {
    text = 'light';
    overlay = is_busy ? 20 : 0;
    rec = 'The image is dark: use LIGHT text (a color scheme with light/white text).' + (is_busy ? ' It is also busy — add a slight dark overlay (~20%) so the text stays readable everywhere.' : ' No overlay needed.');
  } else if (center >= 0.75 && !is_busy) {
    text = 'dark';
    rec = 'The image is light and calm: use DARK text (a color scheme with dark text). No overlay needed.';
  } else {
    text = 'light';
    overlay = is_busy ? 40 : 30;
    textBox = is_busy && center >= 0.55;
    rec = `The image is ${is_busy ? 'busy/high-contrast' : 'mid-toned'}: safest is LIGHT text with a dark overlay of ~${overlay}%` + (textBox ? ', or dark text inside a solid text box (show_text_box: true).' : '.');
  }
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    width: meta.width ?? w, height: meta.height ?? h,
    average_luminance: r3(mean), center_luminance: r3(center), busyness: r3(busyness), is_busy,
    text, recommendation: rec,
    suggested: { text, overlay_opacity: overlay, show_text_box: textBox },
  };
}

/** Fetch an image for analysis; Shopify CDN images are requested tiny via ?width= to keep it fast. */
export async function fetchImageBuffer(url: string, fetchFn: typeof fetch = fetch, maxBytes = 15 * 1024 * 1024): Promise<Buffer> {
  let u: URL;
  try { u = new URL(url); } catch { throw new ToolError('That is not a valid image URL.', undefined, 'BAD_IMAGE_URL'); }
  if (/(^|\.)cdn\.shopify\.com$/.test(u.hostname) || /\.shopify\.com$/.test(u.hostname)) u.searchParams.set('width', '96');
  const res = await fetchFn(u.toString(), { redirect: 'follow' });
  if (!res.ok) throw new ToolError(`Could not download the image (HTTP ${res.status}).`, 'Check the link is public.', 'IMAGE_FETCH_FAILED');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > maxBytes) throw new ToolError('The image is too large to analyse.', undefined, 'IMAGE_TOO_LARGE');
  return buf;
}
