import { ToolError, gidToNumeric } from '../util.js';
import { throwOnUserErrors, type ShopifyGraphQL, type UserError } from './client.js';

export interface ThemeInfo { id: string; numericId: string; name: string; role: string }
export interface ThemeFile { filename: string; content: string; checksumMd5: string | null; size: number }

const THEME_FILES_QUERY = /* GraphQL */ `
  query ThemeFiles($id: ID!, $filenames: [String!], $first: Int!, $after: String) {
    theme(id: $id) {
      files(filenames: $filenames, first: $first, after: $after) {
        nodes {
          filename size checksumMd5 contentType
          body {
            __typename
            ... on OnlineStoreThemeFileBodyText { content }
            ... on OnlineStoreThemeFileBodyBase64 { contentBase64 }
            ... on OnlineStoreThemeFileBodyUrl { url }
          }
        }
        pageInfo { hasNextPage endCursor }
        userErrors { code filename }
      }
    }
  }
`;

const THEMES_QUERY = /* GraphQL */ `
  query DiscoverThemes($stagingName: [String!]) {
    live: themes(first: 1, roles: [MAIN]) { nodes { id name role } }
    staging: themes(first: 10, names: $stagingName) { nodes { id name role } }
  }
`;

const UPSERT_MUTATION = /* GraphQL */ `
  mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
    themeFilesUpsert(themeId: $themeId, files: $files) {
      upsertedThemeFiles { filename }
      userErrors { field message code filename }
    }
  }
`;

const DELETE_MUTATION = /* GraphQL */ `
  mutation ThemeFilesDelete($themeId: ID!, $files: [String!]!) {
    themeFilesDelete(themeId: $themeId, files: $files) {
      deletedThemeFiles { filename }
      userErrors { field message code filename }
    }
  }
`;

/** Read/write theme files and discover the live + staging themes. */
export class ThemeService {
  constructor(private readonly gql: ShopifyGraphQL, private readonly fetchFn: typeof fetch = fetch) {}

  async discover(stagingName: string): Promise<{ live: ThemeInfo; staging: ThemeInfo }> {
    const data = await this.gql.request<{ live: { nodes: ThemeInfo[] }; staging: { nodes: ThemeInfo[] } }>(THEMES_QUERY, { stagingName: [stagingName] });
    const live = data.live.nodes[0];
    if (!live) throw new ToolError('Could not find the live (published) theme.', 'Make sure the app has the read_themes scope.', 'NO_LIVE_THEME');
    const candidates = data.staging.nodes.filter((t) => t.name === stagingName && t.role !== 'MAIN');
    if (candidates.length === 0) {
      throw new ToolError(
        `Could not find an unpublished theme named "${stagingName}".`,
        `In the Shopify admin go to Online Store → Themes → Add theme → Connect from GitHub, pick the staging branch, and rename the theme to exactly "${stagingName}".`,
        'NO_STAGING_THEME',
      );
    }
    if (candidates.length > 1) {
      throw new ToolError(`Found ${candidates.length} themes named "${stagingName}"; there must be exactly one.`, 'Rename or delete the extra copies in Online Store → Themes.', 'AMBIGUOUS_STAGING_THEME');
    }
    const fmt = (t: ThemeInfo): ThemeInfo => ({ ...t, numericId: gidToNumeric(t.id) });
    return { live: fmt(live), staging: fmt(candidates[0]) };
  }

  /** Read files matching the given filenames/patterns (Shopify supports `*` wildcards, max 50 patterns). */
  async readFiles(themeId: string, filenames: string[]): Promise<ThemeFile[]> {
    if (filenames.length > 50) throw new Error('readFiles: at most 50 filename patterns per call');
    const out: ThemeFile[] = [];
    let after: string | null = null;
    do {
      const data: {
        theme: { files: { nodes: Array<{ filename: string; size: number; checksumMd5: string | null; body: { __typename: string; content?: string; contentBase64?: string; url?: string } }>; pageInfo: { hasNextPage: boolean; endCursor: string | null }; userErrors: Array<{ code: string; filename: string }> } } | null;
      } = await this.gql.request(THEME_FILES_QUERY, { id: themeId, filenames, first: 250, after });
      if (!data.theme) throw new ToolError('Theme not found.', 'The theme may have been deleted; restart the server to re-discover themes.', 'THEME_NOT_FOUND');
      const files = data.theme.files;
      for (const node of files.nodes) {
        let content: string;
        if (node.body.__typename === 'OnlineStoreThemeFileBodyText') content = node.body.content ?? '';
        else if (node.body.__typename === 'OnlineStoreThemeFileBodyBase64') content = Buffer.from(node.body.contentBase64 ?? '', 'base64').toString('utf8');
        else if (node.body.__typename === 'OnlineStoreThemeFileBodyUrl' && node.body.url) content = await (await this.fetchFn(node.body.url)).text();
        else content = '';
        out.push({ filename: node.filename, content, checksumMd5: node.checksumMd5, size: node.size });
      }
      after = files.pageInfo.hasNextPage ? files.pageInfo.endCursor : null;
    } while (after);
    return out;
  }

  async readFile(themeId: string, filename: string): Promise<string | null> {
    const files = await this.readFiles(themeId, [filename]);
    return files.find((f) => f.filename === filename)?.content ?? null;
  }

  async upsertFiles(themeId: string, files: Array<{ filename: string; content: string }>): Promise<string[]> {
    if (files.length > 50) throw new Error('upsertFiles: at most 50 files per call');
    const data = await this.gql.request<{ themeFilesUpsert: { upsertedThemeFiles: Array<{ filename: string }> | null; userErrors: UserError[] } }>(UPSERT_MUTATION, {
      themeId,
      files: files.map((f) => ({ filename: f.filename, body: { type: 'TEXT', value: f.content } })),
    });
    throwOnUserErrors(data.themeFilesUpsert.userErrors, 'Saving theme file');
    return (data.themeFilesUpsert.upsertedThemeFiles ?? []).map((f) => f.filename);
  }

  async deleteFiles(themeId: string, filenames: string[]): Promise<string[]> {
    const data = await this.gql.request<{ themeFilesDelete: { deletedThemeFiles: Array<{ filename: string }> | null; userErrors: UserError[] } }>(DELETE_MUTATION, { themeId, files: filenames });
    throwOnUserErrors(data.themeFilesDelete.userErrors, 'Deleting theme file');
    return (data.themeFilesDelete.deletedThemeFiles ?? []).map((f) => f.filename);
  }
}
