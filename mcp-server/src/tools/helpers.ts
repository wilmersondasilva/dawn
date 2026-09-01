import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../logger.js';
import { ToolError } from '../util.js';

export function ok(result: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

export function fail(err: unknown): CallToolResult {
  const e = err instanceof ToolError ? err : new ToolError(`Unexpected error: ${(err as Error)?.message ?? String(err)}`, 'Try again; if it keeps happening the server logs will have details.', 'UNEXPECTED');
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.message, hint: e.hint, code: e.code }, null, 2) }] };
}

/** Run a tool body, convert errors into readable tool errors, and audit mutations. */
export async function run(logger: Logger, tool: string, params: unknown, mutation: boolean, body: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const result = await body();
    if (mutation) logger.audit({ tool, params, result: summarize(result), ok: true });
    return ok(result);
  } catch (err) {
    const e = err as ToolError;
    if (mutation) logger.audit({ tool, params, ok: false, error: e.message });
    else logger.warn(`${tool} failed`, { error: e.message });
    return fail(err);
  }
}

function summarize(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const r = result as Record<string, unknown>;
  const keep = ['status', 'id', 'page', 'files', 'file', 'merge_commit_sha', 'pull_request', 'commit_sha', 'filename', 'mode', 'synced', 'live_verified', 'reference', 'reset'];
  return Object.fromEntries(Object.entries(r).filter(([k]) => keep.includes(k)));
}
