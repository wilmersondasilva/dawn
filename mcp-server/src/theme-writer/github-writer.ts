import type { GitHubClient } from '../github/client.js';
import type { Promoter } from '../github/promote.js';
import type { ThemeWriter, WriteResult } from './index.js';

/** Fallback write path when themeFilesUpsert is not permitted: commit to the staging branch and let Shopify sync. */
export class GitHubThemeWriter implements ThemeWriter {
  readonly mode = 'github' as const;
  constructor(private readonly gh: GitHubClient, private readonly stagingBranch: string, private readonly promoter: Promoter, private readonly syncTimeoutMs = 90_000) {}

  private async commit(changes: Array<{ path: string; content: string | null }>, message: string): Promise<string> {
    const head = await this.gh.getBranchSha(this.stagingBranch);
    const sha = await this.gh.createCommit(head, changes, message);
    await this.gh.updateBranch(this.stagingBranch, sha, false);
    return sha;
  }

  async writeStaging(files: Array<{ filename: string; content: string }>): Promise<WriteResult> {
    const sha = await this.commit(files.map((f) => ({ path: f.filename, content: f.content })), `[page-builder] draft ${files.map((f) => f.filename.replace(/^templates\//, '')).join(', ')}`);
    const sync = await this.promoter.waitForStagingThemeSync(files.map((f) => f.filename), this.syncTimeoutMs);
    return {
      mode: this.mode, files: files.map((f) => f.filename), commit_sha: sha, synced: sync.synced,
      note: sync.synced ? 'Committed to the staging branch and confirmed on the Staging theme.' : `Committed to the staging branch; the Staging theme had not picked up ${sync.pending.join(', ')} within ${Math.round(this.syncTimeoutMs / 1000)}s. It usually appears within a minute.`,
    };
  }

  async deleteStaging(filenames: string[]): Promise<WriteResult> {
    const sha = await this.commit(filenames.map((f) => ({ path: f, content: null })), `[page-builder] remove draft ${filenames.map((f) => f.replace(/^templates\//, '')).join(', ')}`);
    return { mode: this.mode, files: filenames, commit_sha: sha, synced: false, note: 'Removal committed to the staging branch; Shopify will sync it shortly.' };
  }
}
