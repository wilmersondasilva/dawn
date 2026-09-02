import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { createAppContext } from './context.js';
import { createRequestHandler } from './http/app.js';
import { mcpPath } from './http/auth.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = await createAppContext(config);
  const handler = createRequestHandler(ctx);
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(config.port, () => {
    ctx.logger.info('MCP server listening', {
      port: config.port,
      path: mcpPath('<MCP_PATH_SECRET>'),
      store: `${config.shopifyStore}.myshopify.com`,
      write_mode: config.themeWriteMode,
      live_theme: ctx.themeIds.live.name,
      staging_theme: ctx.themeIds.staging.name,
    });
  });
  const shutdown = () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  // Fail loudly: misconfiguration must stop the process, not degrade silently.
  process.stderr.write(`FATAL: ${(e as Error).message}\n${(e as { hint?: string }).hint ? `Hint: ${(e as { hint?: string }).hint}\n` : ''}`);
  process.exit(1);
});
