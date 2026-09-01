import { timingSafeEqual } from 'node:crypto';

/**
 * Error whose message is written for a non-technical reader (Claude relays it
 * verbatim). `hint` says what to do next; `code` is a stable machine string.
 */
export class ToolError extends Error {
  constructor(message: string, public readonly hint?: string, public readonly code?: string, public readonly details?: unknown) {
    super(message);
    this.name = 'ToolError';
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export type Sleep = typeof sleep;

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Strip block and line comments that Shopify prepends to auto-generated JSON files (e.g. settings_data.json). */
export function stripJsonComments(text: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '*') { const end = text.indexOf('*/', i + 2); i = end === -1 ? text.length : end + 2; continue; }
    if (c === '/' && n === '/') { const end = text.indexOf('\n', i); i = end === -1 ? text.length : end; continue; }
    out += c;
    i++;
  }
  return out;
}

export function parseJsonLoose<T = unknown>(text: string): T {
  return JSON.parse(stripJsonComments(text)) as T;
}

/** Poll `check` with exponential backoff until it returns a truthy value or the timeout elapses. */
export async function pollUntil<T>(
  check: () => Promise<T | null | undefined | false>,
  opts: { timeoutMs: number; initialDelayMs?: number; maxDelayMs?: number; sleep?: Sleep; now?: () => number },
): Promise<T | null> {
  const sleepFn = opts.sleep ?? sleep;
  const now = opts.now ?? Date.now;
  const start = now();
  let delay = opts.initialDelayMs ?? 1500;
  const max = opts.maxDelayMs ?? 10000;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (now() - start >= opts.timeoutMs) return null;
    await sleepFn(delay);
    delay = Math.min(max, Math.round(delay * 1.6));
  }
}

export function gidToNumeric(gid: string): string {
  const m = /\/(\d+)(?:\?.*)?$/.exec(gid);
  return m ? m[1] : gid;
}

export function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last);
  } catch {
    return url.split('?')[0].split('/').pop() ?? url;
  }
}

export function normalizeTemplateJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n';
}
