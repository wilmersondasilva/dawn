import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import { ToolError, sleep as defaultSleep, type Sleep } from '../util.js';
import type { ShopifyAuth } from './auth.js';

interface GraphQLError { message: string; extensions?: { code?: string; [k: string]: unknown }; path?: (string | number)[] }
interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLError[];
  extensions?: { cost?: { requestedQueryCost: number; actualQueryCost: number | null; throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number } } };
}

export interface ShopifyGraphQLOptions {
  store: string;
  apiVersion: string;
  auth: ShopifyAuth;
  fetch?: typeof fetch;
  logger?: Logger;
  sleep?: Sleep;
  maxThrottleRetries?: number;
}

/**
 * Thin Admin GraphQL client: injects the client-credentials token, retries
 * once on 401 (after refreshing the token), backs off on throttling using the
 * cost/throttleStatus extension, and retries transient 5xx.
 */
export class ShopifyGraphQL {
  private readonly fetchFn: typeof fetch;
  private readonly logger: Logger;
  private readonly sleep: Sleep;
  private readonly maxThrottleRetries: number;

  constructor(private readonly opts: ShopifyGraphQLOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.logger = opts.logger ?? silentLogger;
    this.sleep = opts.sleep ?? defaultSleep;
    this.maxThrottleRetries = opts.maxThrottleRetries ?? 6;
  }

  get endpoint(): string {
    return `https://${this.opts.store}.myshopify.com/admin/api/${this.opts.apiVersion}/graphql.json`;
  }

  async request<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let retried401 = false;
    let throttleRetries = 0;
    let serverRetries = 0;
    for (;;) {
      const token = await this.opts.auth.getToken();
      let res: Response;
      try {
        res = await this.fetchFn(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Shopify-Access-Token': token },
          body: JSON.stringify({ query, variables }),
        });
      } catch (e) {
        if (serverRetries++ < 3) { await this.sleep(500 * 2 ** serverRetries); continue; }
        throw new ToolError(`Could not reach Shopify (${(e as Error).message}).`, 'Try again in a minute.', 'SHOPIFY_NETWORK');
      }

      if (res.status === 401 || res.status === 403) {
        if (!retried401 && res.status === 401) { retried401 = true; this.opts.auth.invalidate(); continue; }
        throw new ToolError(
          res.status === 401 ? 'Shopify rejected the access token.' : 'Shopify says this app is not allowed to do that (403).',
          'Check the app is installed on the store and its released version includes the required scopes: read_themes, write_themes, read_content, write_content, read_files, write_files.',
          'SHOPIFY_FORBIDDEN',
        );
      }
      if (res.status === 429) {
        if (throttleRetries++ >= this.maxThrottleRetries) throw new ToolError('Shopify is rate-limiting requests right now.', 'Wait a minute and try again.', 'SHOPIFY_THROTTLED');
        const retryAfter = Number(res.headers.get('retry-after')) || 2;
        await this.sleep(retryAfter * 1000);
        continue;
      }
      if (res.status >= 500) {
        if (serverRetries++ < 3) { await this.sleep(500 * 2 ** serverRetries); continue; }
        throw new ToolError(`Shopify returned a server error (${res.status}).`, 'Try again in a few minutes.', 'SHOPIFY_5XX');
      }
      if (!res.ok) {
        throw new ToolError(`Shopify returned HTTP ${res.status}.`, undefined, 'SHOPIFY_HTTP', await safeText(res));
      }

      const json = (await res.json()) as GraphQLResponse<T>;
      const throttled = json.errors?.find((e) => e.extensions?.code === 'THROTTLED');
      if (throttled) {
        if (throttleRetries++ >= this.maxThrottleRetries) throw new ToolError('Shopify is rate-limiting requests right now.', 'Wait a minute and try again.', 'SHOPIFY_THROTTLED');
        const cost = json.extensions?.cost;
        let waitMs = 2000;
        if (cost) {
          const deficit = cost.requestedQueryCost - cost.throttleStatus.currentlyAvailable;
          waitMs = Math.max(500, Math.ceil((deficit / Math.max(1, cost.throttleStatus.restoreRate)) * 1000) + 250);
        }
        this.logger.warn('shopify throttled; backing off', { waitMs });
        await this.sleep(waitMs);
        continue;
      }
      if (json.errors?.length) {
        const msgs = json.errors.map((e) => e.message).join('; ');
        throw new ToolError(`Shopify rejected the request: ${msgs}`, undefined, 'SHOPIFY_GRAPHQL', json.errors);
      }
      if (!json.data) throw new ToolError('Shopify returned an empty response.', 'Try again.', 'SHOPIFY_EMPTY');
      return json.data;
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 500); } catch { return ''; }
}

export interface UserError { field?: string[] | null; message: string; code?: string | null }

/** Turn Shopify userErrors into a single ToolError with a readable message. */
export function throwOnUserErrors(errors: UserError[] | undefined | null, context: string): void {
  if (!errors || errors.length === 0) return;
  const codes = errors.map((e) => e.code).filter(Boolean) as string[];
  const msg = errors.map((e) => (e.field?.length ? `${e.field.join('.')}: ${e.message}` : e.message)).join('; ');
  if (codes.includes('ACCESS_DENIED')) {
    throw new ToolError(
      `${context}: Shopify denied write access to theme files (ACCESS_DENIED).`,
      'This store/app is not exempted for theme-file writes. Set THEME_WRITE_MODE=github on the server so drafts are committed to the staging branch and synced by Shopify\'s GitHub integration instead.',
      'THEME_WRITE_ACCESS_DENIED',
      errors,
    );
  }
  throw new ToolError(`${context}: ${msg}`, undefined, codes[0] ?? 'USER_ERROR', errors);
}
