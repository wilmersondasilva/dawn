import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppContext } from '../context.js';
import { createMcpServer } from '../tools/index.js';
import { authorize } from './auth.js';

const MAX_BODY = 5 * 1024 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Host-agnostic request handler. Stateless streamable-HTTP: a fresh MCP server
 * + transport per request (recommended for serverless and fine for a long-
 * running Node process; all real state lives in AppContext).
 */
export function createRequestHandler(ctx: AppContext): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') return send(res, 200, { ok: true });

    const auth = authorize(req, { pathSecret: ctx.config.mcpPathSecret });
    if (!auth.ok) return send(res, 404, { error: 'not found' });

    if (req.method === 'GET' || req.method === 'DELETE') {
      // Stateless mode: no SSE resumption stream and no sessions to delete.
      return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

    let body: unknown;
    try { body = await readJsonBody(req); } catch (e) {
      return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: `Parse error: ${(e as Error).message}` }, id: null });
    }

    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      ctx.logger.error('mcp request failed', { error: (e as Error).message });
      if (!res.headersSent) send(res, 500, { jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  };
}
