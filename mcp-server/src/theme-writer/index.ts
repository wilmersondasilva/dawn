import type { ThemeWriteMode } from '../config.js';

export interface WriteResult {
  mode: ThemeWriteMode;
  files: string[];
  /** Commit created on the staging branch (github mode only). */
  commit_sha?: string;
  /** True when the staging theme has been confirmed to contain the new content. */
  synced: boolean;
  note: string;
}

/**
 * The single seam for "how do bytes reach the staging theme". Swap the
 * implementation with THEME_WRITE_MODE — nothing else in the server changes.
 *  - shopify: themeFilesUpsert on the staging theme (GitHub sync commits it back to the staging branch).
 *  - github:  commit to the staging branch (GitHub sync pushes it to the staging theme). Needs only read_themes.
 */
export interface ThemeWriter {
  readonly mode: ThemeWriteMode;
  writeStaging(files: Array<{ filename: string; content: string }>): Promise<WriteResult>;
  deleteStaging(filenames: string[]): Promise<WriteResult>;
}

export { ShopifyThemeWriter } from './shopify-writer.js';
export { GitHubThemeWriter } from './github-writer.js';
