import { describe, expect, it } from 'vitest';
import { ShopifyAuth } from '../src/shopify/auth.js';
import { mockFetch } from './fakes.js';

const tokenBody = (t: string) => ({ access_token: t, scope: 'read_themes,write_themes', expires_in: 86399 });

describe('ShopifyAuth (client credentials)', () => {
  it('posts a form-encoded client_credentials grant and caches the token', async () => {
    let n = 0;
    const fetch = mockFetch((url, init) => {
      expect(url).toBe('https://acme.myshopify.com/admin/oauth/access_token');
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
      const params = new URLSearchParams(String(init?.body));
      expect(params.get('grant_type')).toBe('client_credentials');
      expect(params.get('client_id')).toBe('cid');
      expect(params.get('client_secret')).toBe('sec');
      return { body: tokenBody(`tok${++n}`) };
    });
    const auth = new ShopifyAuth({ store: 'acme', clientId: 'cid', clientSecret: 'sec', fetch });
    expect(await auth.getToken()).toBe('tok1');
    expect(await auth.getToken()).toBe('tok1');
    expect(fetch.calls.length).toBe(1);
    expect(auth.status().scopes).toEqual(['read_themes', 'write_themes']);
    expect(auth.status().secondsUntilExpiry).toBeGreaterThan(86000);
  });

  it('single-flights concurrent first calls', async () => {
    let n = 0;
    const fetch = mockFetch(() => ({ body: tokenBody(`tok${++n}`) }));
    const auth = new ShopifyAuth({ store: 'acme', clientId: 'a', clientSecret: 'b', fetch });
    const [a, b, c] = await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]);
    expect([a, b, c]).toEqual(['tok1', 'tok1', 'tok1']);
    expect(fetch.calls.length).toBe(1);
  });

  it('refreshes shortly before expiry and after invalidate()', async () => {
    let now = 1_000_000; let n = 0;
    const fetch = mockFetch(() => ({ body: tokenBody(`tok${++n}`) }));
    const auth = new ShopifyAuth({ store: 'acme', clientId: 'a', clientSecret: 'b', fetch, now: () => now, refreshSkewMs: 10 * 60 * 1000 });
    expect(await auth.getToken()).toBe('tok1');
    now += (86399 - 11 * 60) * 1000; // 11 minutes before expiry: still valid
    expect(await auth.getToken()).toBe('tok1');
    now += 2 * 60 * 1000; // 9 minutes before expiry: inside the skew → refresh
    expect(await auth.getToken()).toBe('tok2');
    auth.invalidate();
    expect(await auth.getToken()).toBe('tok3');
    expect(fetch.calls.length).toBe(3);
  });

  it('explains shop_not_permitted and invalid credentials in plain language', async () => {
    const f1 = mockFetch(() => ({ status: 400, body: { error: 'shop_not_permitted' } }));
    await expect(new ShopifyAuth({ store: 'acme', clientId: 'a', clientSecret: 'b', fetch: f1 }).getToken()).rejects.toMatchObject({ code: 'AUTH_SHOP_NOT_PERMITTED' });
    const f2 = mockFetch(() => ({ status: 401, body: { error: 'invalid_client' } }));
    await expect(new ShopifyAuth({ store: 'acme', clientId: 'a', clientSecret: 'b', fetch: f2 }).getToken()).rejects.toMatchObject({ code: 'AUTH_INVALID_CLIENT' });
  });
});
