import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import { ToolError, parseJsonLoose, pollUntil, sleep as defaultSleep, type Sleep } from '../util.js';
import type { GitHubClient, FileChange } from './client.js';
import type { StagingResetStrategy } from '../config.js';

export const PROMOTE_PREFIX = '[page-builder] promote';
export const ROLLBACK_PREFIX = '[page-builder] rollback';

export interface PromoterDeps {
  gh: GitHubClient;
  liveBranch: string;
  stagingBranch: string;
  /** Content of a file on the staging theme (what the customer previewed). */
  readStagingFile: (filename: string) => Promise<string | null>;
  /** Content of a file on the live theme (used to verify sync). */
  readLiveFile: (filename: string) => Promise<string | null>;
  logger?: Logger;
  sleep?: Sleep;
  now?: () => number;
  syncTimeoutMs?: number;
}

export interface StagingCleanup {
  performed: boolean;
  reason: string;
  /** Files on staging that still differ from the live branch (unpromoted drafts). */
  remaining_drafts: string[];
}

export interface PromoteResult {
  status: 'promoted' | 'nothing_to_promote';
  files: Array<{ filename: string; action: 'created' | 'updated' | 'unchanged' }>;
  pull_request?: { number: number; url: string };
  merge_commit_sha?: string;
  live_verified: boolean;
  unverified_files: string[];
  /** Post-promotion tidy-up of the staging branch (only when no other drafts remain). */
  staging_cleanup?: StagingCleanup;
  note: string;
}

export interface RollbackResult {
  status: 'rolled_back';
  reverted_commit: string;
  files: Array<{ filename: string; action: 'restored' | 'deleted' }>;
  pull_request: { number: number; url: string };
  merge_commit_sha: string;
  live_verified: boolean;
  unverified_files: string[];
  note: string;
}

/** Compare two template bodies semantically when both are JSON (Shopify may re-indent on save). */
export function sameContent(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  if (a === b) return true;
  // parseJsonLoose: Shopify prepends /* auto-generated */ headers when it writes
  // theme files; two copies that differ only by that header (or whitespace) are the same.
  try { return JSON.stringify(parseJsonLoose(a)) === JSON.stringify(parseJsonLoose(b)); } catch { return a.trim() === b.trim(); }
}

function assertTemplatePath(filename: string): void {
  if (!/^templates\/[^/]+\.json$/.test(filename) || filename.includes('..')) {
    throw new ToolError(`"${filename}" is not a template file; only files under templates/ can be promoted or rolled back.`, undefined, 'PROMOTE_SCOPE');
  }
  if (filename === 'config/settings_data.json') throw new ToolError('config/settings_data.json is never promoted by this tool.', undefined, 'PROMOTE_SCOPE');
}

export class Promoter {
  private readonly logger: Logger;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly syncTimeoutMs: number;

  constructor(private readonly d: PromoterDeps) {
    this.logger = d.logger ?? silentLogger;
    this.sleep = d.sleep ?? defaultSleep;
    this.now = d.now ?? Date.now;
    this.syncTimeoutMs = d.syncTimeoutMs ?? 120_000;
  }

  /** Make the staging branch reflect main. `force` resets it; `merge` merges main into it (keeps unpromoted drafts). */
  async resetStaging(strategy: StagingResetStrategy): Promise<{ strategy: StagingResetStrategy; main_sha: string; staging_sha_before: string; staging_sha_after: string; changed: boolean }> {
    const { gh, liveBranch, stagingBranch } = this.d;
    const mainSha = await gh.getBranchSha(liveBranch);
    const exists = await gh.branchExists(stagingBranch);
    if (!exists) {
      throw new ToolError(`The "${stagingBranch}" branch does not exist in GitHub.`, `Create it from ${liveBranch} and connect it to the "Staging" theme (see README).`, 'NO_STAGING_BRANCH');
    }
    const before = await gh.getBranchSha(stagingBranch);
    if (before === mainSha) return { strategy, main_sha: mainSha, staging_sha_before: before, staging_sha_after: before, changed: false };
    let after = mainSha;
    if (strategy === 'force') {
      await gh.updateBranch(stagingBranch, mainSha, true);
    } else {
      const merged = await gh.mergeBranches(stagingBranch, liveBranch, `[page-builder] sync ${stagingBranch} with ${liveBranch}`);
      after = merged ?? before;
    }
    this.logger.info('staging reset', { strategy, before, after });
    return { strategy, main_sha: mainSha, staging_sha_before: before, staging_sha_after: after, changed: after !== before };
  }

  /** Wait until the staging theme's copies of `filenames` match the staging branch (Shopify GitHub sync is async). */
  async waitForStagingThemeSync(filenames: string[], timeoutMs = 60_000): Promise<{ synced: boolean; pending: string[] }> {
    const expected = new Map<string, string | null>();
    for (const f of filenames) expected.set(f, (await this.d.gh.getFile(f, this.d.stagingBranch))?.content ?? null);
    return this.waitForMatch(expected, this.d.readStagingFile, timeoutMs);
  }

  private async waitForMatch(expected: Map<string, string | null>, read: (f: string) => Promise<string | null>, timeoutMs: number): Promise<{ synced: boolean; pending: string[] }> {
    let pending: string[] = [...expected.keys()];
    const done = await pollUntil(async () => {
      const still: string[] = [];
      for (const f of pending) if (!sameContent(await read(f), expected.get(f) ?? null)) still.push(f);
      pending = still;
      return still.length === 0 ? true : null;
    }, { timeoutMs, initialDelayMs: 2000, maxDelayMs: 10_000, sleep: this.sleep, now: this.now });
    return { synced: !!done, pending };
  }

  /**
   * Promote exactly `filenames` from the staging theme to main. Builds a fresh
   * branch off main containing only those files, so nothing else on staging
   * (drift, settings_data.json, abandoned drafts) can ride along.
   */
  async promote(filenames: string[], opts: { summary?: string } = {}): Promise<PromoteResult> {
    const { gh, liveBranch } = this.d;
    if (filenames.length === 0) throw new ToolError('No files were given to promote.', undefined, 'PROMOTE_EMPTY');
    const unique = [...new Set(filenames)];
    for (const f of unique) assertTemplatePath(f);

    const mainSha = await gh.getBranchSha(liveBranch);
    const changes: FileChange[] = [];
    const files: PromoteResult['files'] = [];
    const expected = new Map<string, string | null>();
    for (const f of unique) {
      const draft = await this.d.readStagingFile(f);
      if (draft === null) throw new ToolError(`"${f}" does not exist on the staging theme, so there is nothing to make live.`, 'Build the draft first with upsert_template_staging.', 'PROMOTE_MISSING_DRAFT');
      const live = (await gh.getFile(f, liveBranch))?.content ?? null;
      if (sameContent(draft, live)) { files.push({ filename: f, action: 'unchanged' }); continue; }
      files.push({ filename: f, action: live === null ? 'created' : 'updated' });
      changes.push({ path: f, content: draft });
      expected.set(f, draft);
    }
    if (changes.length === 0) {
      return { status: 'nothing_to_promote', files, live_verified: true, unverified_files: [], note: 'The live site already has this exact content.' };
    }

    const branch = `page-builder/promote-${this.now()}`;
    const message = `${PROMOTE_PREFIX} ${changes.map((c) => c.path.replace(/^templates\//, '')).join(', ')}`;
    const commitSha = await gh.createCommit(mainSha, changes, message);
    await gh.createBranch(branch, commitSha);
    let mergeSha: string;
    let pr: { number: number; html_url: string };
    try {
      pr = await gh.createPull({ title: message, body: `${opts.summary ?? 'Approved in chat.'}\n\nFiles:\n${changes.map((c) => `- ${c.path}`).join('\n')}\n\nAutomated by the Shopify page builder.`, head: branch, base: liveBranch });
      mergeSha = await gh.mergePull(pr.number, { method: 'merge', title: message });
    } finally {
      await gh.deleteBranch(branch).catch(() => undefined);
    }
    this.logger.info('promoted', { files: changes.map((c) => c.path), pr: pr.number, mergeSha });

    const verify = await this.waitForMatch(expected, this.d.readLiveFile, this.syncTimeoutMs);
    let staging_cleanup: StagingCleanup;
    try {
      staging_cleanup = await this.cleanupStagingAfterPromote();
    } catch (e) {
      staging_cleanup = { performed: false, reason: `cleanup skipped: ${(e as Error).message}`, remaining_drafts: [] };
    }
    return {
      status: 'promoted',
      files,
      pull_request: { number: pr.number, url: pr.html_url },
      merge_commit_sha: mergeSha,
      live_verified: verify.synced,
      unverified_files: verify.pending,
      staging_cleanup,
      note: verify.synced
        ? 'Merged to main and confirmed on the live theme.'
        : `Merged to main, but the live theme had not picked up ${verify.pending.join(', ')} after ${Math.round(this.syncTimeoutMs / 1000)}s. Shopify's GitHub sync is usually seconds; check the live page in a minute. If it never updates, check the theme's GitHub connection in Online Store → Themes.`,
    };
  }

  /**
   * After a successful promotion, reset the staging branch onto the live
   * branch — but ONLY if staging holds no other content that differs from
   * live (i.e. no unpromoted drafts would be lost). Content is compared
   * semantically, so sync-added comment headers don't block the tidy-up.
   */
  private async cleanupStagingAfterPromote(): Promise<StagingCleanup> {
    const { gh, liveBranch, stagingBranch } = this.d;
    const mainSha = await gh.getBranchSha(liveBranch);
    const stagingSha = await gh.getBranchSha(stagingBranch);
    if (stagingSha === mainSha) return { performed: false, reason: 'staging already matches the live branch', remaining_drafts: [] };
    const cmp = await gh.compare(liveBranch, stagingBranch);
    const remaining: string[] = [];
    for (const f of cmp.files) {
      const draft = (await gh.getFile(f, stagingBranch))?.content ?? null;
      const live = (await gh.getFile(f, liveBranch))?.content ?? null;
      if (!sameContent(draft, live)) remaining.push(f);
    }
    if (remaining.length) {
      return { performed: false, reason: 'staging still holds other unpromoted drafts; left untouched so they are not lost', remaining_drafts: remaining };
    }
    await gh.updateBranch(stagingBranch, mainSha, true);
    this.logger.info('staging cleaned after promote', { mainSha });
    return { performed: true, reason: 'staging reset to match the live branch (no other drafts present)', remaining_drafts: [] };
  }

  /** Revert a promotion: restore every file touched by `mergeSha` to its state before that commit. */
  async rollback(mergeSha: string): Promise<RollbackResult> {
    const { gh, liveBranch } = this.d;
    const commit = await gh.getCommit(mergeSha);
    if (commit.parents.length === 0) throw new ToolError('That commit has no parent and cannot be reverted.', undefined, 'ROLLBACK_ROOT');
    if (!commit.message.startsWith(PROMOTE_PREFIX) && !commit.message.startsWith(ROLLBACK_PREFIX)) {
      throw new ToolError('That commit was not created by the page builder, so it will not be reverted automatically.', 'Only promotions made through promote_to_live can be rolled back here.', 'ROLLBACK_SCOPE');
    }
    const parent = commit.parents[0];
    if (commit.files.length === 0) throw new ToolError('GitHub reported no file changes for that commit.', undefined, 'ROLLBACK_EMPTY');
    for (const f of commit.files) assertTemplatePath(f.filename);

    const mainSha = await gh.getBranchSha(liveBranch);
    const changes: FileChange[] = [];
    const files: RollbackResult['files'] = [];
    const expected = new Map<string, string | null>();
    for (const f of commit.files) {
      const before = f.status === 'added' ? null : (await gh.getFile(f.filename, parent))?.content ?? null;
      changes.push({ path: f.filename, content: before });
      files.push({ filename: f.filename, action: before === null ? 'deleted' : 'restored' });
      expected.set(f.filename, before);
    }
    const branch = `page-builder/rollback-${this.now()}`;
    const message = `${ROLLBACK_PREFIX} of ${mergeSha.slice(0, 7)}`;
    const commitSha = await gh.createCommit(mainSha, changes, message);
    await gh.createBranch(branch, commitSha);
    let newMerge: string;
    let pr: { number: number; html_url: string };
    try {
      pr = await gh.createPull({ title: message, body: `Reverts ${mergeSha}.\n\nFiles:\n${files.map((f) => `- ${f.filename} (${f.action})`).join('\n')}`, head: branch, base: liveBranch });
      newMerge = await gh.mergePull(pr.number, { method: 'merge', title: message });
    } finally {
      await gh.deleteBranch(branch).catch(() => undefined);
    }
    this.logger.info('rolled back', { reverted: mergeSha, mergeSha: newMerge });
    const verify = await this.waitForMatch(expected, this.d.readLiveFile, this.syncTimeoutMs);
    return {
      status: 'rolled_back', reverted_commit: mergeSha, files,
      pull_request: { number: pr.number, url: pr.html_url }, merge_commit_sha: newMerge,
      live_verified: verify.synced, unverified_files: verify.pending,
      note: verify.synced ? 'Reverted on main and confirmed on the live theme.' : `Reverted on main; the live theme had not caught up for ${verify.pending.join(', ')} yet. Check again in a minute.`,
    };
  }
}
