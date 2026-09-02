import { ToolError, gidToNumeric } from '../util.js';
import { throwOnUserErrors, type ShopifyGraphQL, type UserError } from './client.js';

export interface PageInfo {
  id: string;
  numericId: string;
  handle: string;
  title: string;
  isPublished: boolean;
  templateSuffix: string | null;
  updatedAt?: string;
}

const PAGE_FIELDS = 'id handle title isPublished templateSuffix updatedAt';

export class PageService {
  constructor(private readonly gql: ShopifyGraphQL) {}

  private fmt(p: Omit<PageInfo, 'numericId'>): PageInfo {
    return { ...p, numericId: gidToNumeric(p.id) };
  }

  async list(opts: { first?: number; after?: string | null; query?: string } = {}): Promise<{ pages: PageInfo[]; hasNextPage: boolean; endCursor: string | null }> {
    const data = await this.gql.request<{ pages: { nodes: Array<Omit<PageInfo, 'numericId'>>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
      /* GraphQL */ `query Pages($first: Int!, $after: String, $query: String) {
        pages(first: $first, after: $after, query: $query, sortKey: TITLE) {
          nodes { ${PAGE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: Math.min(250, opts.first ?? 50), after: opts.after ?? null, query: opts.query ?? null },
    );
    return { pages: data.pages.nodes.map((p) => this.fmt(p)), hasNextPage: data.pages.pageInfo.hasNextPage, endCursor: data.pages.pageInfo.endCursor };
  }

  async findByHandle(handle: string): Promise<PageInfo | null> {
    const { pages } = await this.list({ first: 5, query: `handle:${handle}` });
    return pages.find((p) => p.handle === handle) ?? null;
  }

  async findByTitle(title: string): Promise<PageInfo[]> {
    const { pages } = await this.list({ first: 10, query: `title:*${title.replace(/"/g, '')}*` });
    return pages;
  }

  async getById(id: string): Promise<PageInfo | null> {
    const gid = id.startsWith('gid://') ? id : `gid://shopify/Page/${id}`;
    const data = await this.gql.request<{ page: Omit<PageInfo, 'numericId'> | null }>(/* GraphQL */ `query Page($id: ID!) { page(id: $id) { ${PAGE_FIELDS} } }`, { id: gid });
    return data.page ? this.fmt(data.page) : null;
  }

  /** Always creates the page unpublished. Publishing is a separate, explicit tool. */
  async createUnpublished(input: { title: string; handle?: string; templateSuffix?: string | null; body?: string }): Promise<PageInfo> {
    const data = await this.gql.request<{ pageCreate: { page: Omit<PageInfo, 'numericId'> | null; userErrors: UserError[] } }>(
      /* GraphQL */ `mutation PageCreate($page: PageCreateInput!) { pageCreate(page: $page) { page { ${PAGE_FIELDS} } userErrors { field message code } } }`,
      { page: { title: input.title, handle: input.handle, templateSuffix: input.templateSuffix ?? null, body: input.body ?? '', isPublished: false } },
    );
    throwOnUserErrors(data.pageCreate.userErrors, 'Creating page');
    if (!data.pageCreate.page) throw new ToolError('Shopify did not return the created page.', 'Try again.', 'PAGE_CREATE_EMPTY');
    return this.fmt(data.pageCreate.page);
  }

  async update(id: string, patch: { isPublished?: boolean; templateSuffix?: string | null; title?: string; body?: string; handle?: string }): Promise<PageInfo> {
    const data = await this.gql.request<{ pageUpdate: { page: Omit<PageInfo, 'numericId'> | null; userErrors: UserError[] } }>(
      /* GraphQL */ `mutation PageUpdate($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { ${PAGE_FIELDS} } userErrors { field message code } } }`,
      { id, page: patch },
    );
    throwOnUserErrors(data.pageUpdate.userErrors, 'Updating page');
    if (!data.pageUpdate.page) throw new ToolError('Shopify did not return the updated page.', 'Try again.', 'PAGE_UPDATE_EMPTY');
    return this.fmt(data.pageUpdate.page);
  }
}
