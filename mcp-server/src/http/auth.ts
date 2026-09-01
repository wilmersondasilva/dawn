import type { IncomingMessage } from 'node:http';
import { safeEqual } from '../util.js';

/**
 * Transport-level authorization. v1: the MCP endpoint lives under an
 * unguessable path (MCP_PATH_SECRET) and that URL is treated as a password.
 *
 * To add OAuth later, extend `authorize` (e.g. validate a Bearer token and
 * return { ok: true, subject }) — the tools never look at the request, so
 * nothing else changes.
 */
export interface AuthResult { ok: boolean; reason?: string; subject?: string }

export function mcpPath(secret: string): string { return `/mcp/${secret}`; }

export function authorize(req: IncomingMessage, opts: { pathSecret: string }): AuthResult {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const expected = mcpPath(opts.pathSecret);
  if (url.pathname.length !== expected.length || !safeEqual(url.pathname, expected)) return { ok: false, reason: 'not found' };
  return { ok: true, subject: 'path-secret' };
}
