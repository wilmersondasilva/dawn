import { ToolError } from '../util.js';

/**
 * Client credentials grant for Dev Dashboard custom apps.
 * Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/client-credentials-grant
 * Tokens live 24h (expires_in = 86399). We refresh a few minutes early and
 * hold the token only in memory.
 */
export interface TokenResponse { access_token: string; scope: string; expires_in: number }

export interface ShopifyAuthOptions {
  store: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
  /** How long before expiry to proactively refresh. Default 10 minutes. */
  refreshSkewMs?: number;
}

export interface AuthStatus {
  hasToken: boolean;
  scopes: string[];
  expiresAt: string | null;
  secondsUntilExpiry: number | null;
}

export class ShopifyAuth {
  private token: { value: string; scopes: string[]; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly skew: number;

  constructor(private readonly opts: ShopifyAuthOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.skew = opts.refreshSkewMs ?? 10 * 60 * 1000;
  }

  get tokenUrl(): string {
    return `https://${this.opts.store}.myshopify.com/admin/oauth/access_token`;
  }

  async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt - this.skew > this.now()) return this.token.value;
    if (!this.inflight) {
      this.inflight = this.requestToken().finally(() => { this.inflight = null; });
    }
    return this.inflight;
  }

  /** Drop the cached token (e.g. after a 401) so the next call fetches a fresh one. */
  invalidate(): void {
    this.token = null;
  }

  status(): AuthStatus {
    if (!this.token) return { hasToken: false, scopes: [], expiresAt: null, secondsUntilExpiry: null };
    return {
      hasToken: true,
      scopes: this.token.scopes,
      expiresAt: new Date(this.token.expiresAt).toISOString(),
      secondsUntilExpiry: Math.max(0, Math.round((this.token.expiresAt - this.now()) / 1000)),
    };
  }

  private async requestToken(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
    });
    let res: Response;
    try {
      res = await this.fetchFn(this.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      });
    } catch (e) {
      throw new ToolError(`Could not reach Shopify to sign in (${(e as Error).message}).`, 'Check the server has internet access and SHOPIFY_STORE is correct.', 'AUTH_NETWORK');
    }
    const text = await res.text();
    let json: Partial<TokenResponse> & { error?: string; error_description?: string } = {};
    try { json = JSON.parse(text); } catch { /* handled below */ }
    if (!res.ok || !json.access_token) {
      const err = json.error ?? `HTTP ${res.status}`;
      if (err === 'shop_not_permitted') {
        throw new ToolError(
          'Shopify refused to issue an access token: the app and the store are not in the same Shopify organization (shop_not_permitted).',
          'The custom app must be created from the Dev Dashboard of the organization that owns this store. Re-create it there and update SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET.',
          'AUTH_SHOP_NOT_PERMITTED',
        );
      }
      if (err === 'invalid_client' || res.status === 401) {
        throw new ToolError('Shopify rejected the app credentials (invalid client id or secret).', 'Copy the Client ID and Client secret again from the app in the Dev Dashboard.', 'AUTH_INVALID_CLIENT');
      }
      throw new ToolError(`Shopify sign-in failed: ${err}${json.error_description ? ` – ${json.error_description}` : ''}.`, 'Check the app is installed on the store and has a released version.', 'AUTH_FAILED');
    }
    const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 86399;
    this.token = {
      value: json.access_token,
      scopes: (json.scope ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      expiresAt: this.now() + expiresIn * 1000,
    };
    return this.token.value;
  }
}
