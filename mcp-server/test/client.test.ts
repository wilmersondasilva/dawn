import { describe, expect, it } from 'vitest';
import { ShopifyAuth } from '../src/shopify/auth.js';
import { ShopifyGraphQL, throwOnUserErrors } from '../src/shopify/client.js';
import { mockFetch } from './fakes.js';

function setup(router: Parameters<typeof mockFetch>[0]) {
  let n = 0;
  const fetch = mockFetch((url, init) => {
    if (url.endsWith('/admin/oauth/access_token')) return { body: { access_token: `tok${++n}`, scope: 'read_themes', expires_in: 86399 } };
    return router(url, init);
  });
  const auth = new ShopifyAuth({ store: 'acme', clientId: 'a', clientSecret: 'b', fetch });
  const sleeps: number[] = [];
  const gql = new ShopifyGraphQL({ store: 'acme', apiVersion: '2026-07', auth, fetch, sleep: async (ms) => { sleeps.push(ms); } });
  return { fetch, gql, sleeps };
}

describe('ShopifyGraphQL', () => {
  it('sends the token and hits the pinned API version', async () => {
    const { gql, fetch } = setup((url, init) => {
      expect(url).toBe('https://acme.myshopify.com/admin/api/2026-07/graphql.json');
      expect((init?.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('tok1');
      return { body: { data: { shop: { name: 'Acme' } } } };
    });
    expect(await gql.request<{ shop: { name: string } }>('{ shop { name } }')).toEqual({ shop: { name: 'Acme' } });
    expect(fetch.calls.filter((c) => c.url.includes('graphql')).length).toBe(1);
  });

  it('refreshes the token and retries once on 401', async () => {
    let hits = 0;
    const { gql, fetch } = setup((_u, init) => {
      hits++;
      const tok = (init?.headers as Record<string, string>)['X-Shopify-Access-Token'];
      if (tok === 'tok1') return { status: 401, body: { errors: 'unauthorized' } };
      return { body: { data: { ok: true } } };
    });
    expect(await gql.request('{ ok }')).toEqual({ ok: true });
    expect(hits).toBe(2);
    expect(fetch.calls.filter((c) => c.url.endsWith('access_token')).length).toBe(2);
  });

  it('backs off using throttleStatus and retries on THROTTLED', async () => {
    let hits = 0;
    const { gql, sleeps } = setup(() => {
      hits++;
      if (hits === 1) return { body: { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: { requestedQueryCost: 500, actualQueryCost: null, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 100, restoreRate: 50 } } } } };
      return { body: { data: { ok: true } } };
    });
    expect(await gql.request('{ ok }')).toEqual({ ok: true });
    expect(hits).toBe(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(8000); // (500-100)/50 = 8s
  });

  it('retries on HTTP 429 and 5xx, and surfaces GraphQL errors readably', async () => {
    let hits = 0;
    const { gql } = setup(() => {
      hits++;
      if (hits === 1) return { status: 429, headers: { 'retry-after': '1' } };
      if (hits === 2) return { status: 502, body: 'bad gateway' };
      return { body: { data: { ok: true } } };
    });
    expect(await gql.request('{ ok }')).toEqual({ ok: true });
    const bad = setup(() => ({ body: { errors: [{ message: 'Field x doesn\'t exist' }] } }));
    await expect(bad.gql.request('{ x }')).rejects.toMatchObject({ code: 'SHOPIFY_GRAPHQL' });
  });

  it('maps ACCESS_DENIED user errors to the github write-mode hint', () => {
    let err: any; try { throwOnUserErrors([{ message: 'no', code: 'ACCESS_DENIED' }], 'Saving'); } catch (e) { err = e; }
    expect(err.code).toBe('THEME_WRITE_ACCESS_DENIED');
    expect(err.hint).toMatch(/THEME_WRITE_MODE=github/);
  });
});
