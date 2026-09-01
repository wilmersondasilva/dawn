import { appendFileSync } from 'node:fs';

const SECRET_KEY = /(token|secret|password|authorization|client_secret|api_key)/i;

/** Recursively redact anything that looks like a credential before it reaches a log line. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && /^(shpat_|shpca_|shpua_|github_pat_|ghp_)/.test(value)) return '[redacted]';
  return value;
}

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  /** Mutation audit trail: tool name, params (redacted), resulting ids/SHAs. */
  audit(event: { tool: string; params?: unknown; result?: unknown; ok: boolean; error?: string }): void;
}

export function createLogger(opts: { auditFile?: string; silent?: boolean } = {}): Logger {
  const write = (level: string, msg: string, data?: unknown) => {
    if (opts.silent) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(data ? { data: redact(data) } : {}) });
    (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
  };
  return {
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    audit: (event) => {
      const line = JSON.stringify({ ts: new Date().toISOString(), level: 'audit', ...(redact(event) as object) });
      if (!opts.silent) process.stdout.write(line + '\n');
      if (opts.auditFile) {
        try { appendFileSync(opts.auditFile, line + '\n'); } catch (e) { write('error', 'audit file write failed', { error: String(e) }); }
      }
    },
  };
}

export const silentLogger: Logger = createLogger({ silent: true });
