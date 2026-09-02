import { describe, expect, it } from 'vitest';
import type { GitHubClient } from '../src/github/client.js';
import { Promoter, sameContent } from '../src/github/promote.js';
import { GitHubThemeWriter } from '../src/theme-writer/github-writer.js';
import { FakeGitHub } from './fakes.js';

const TPL = 'templates/page.sale.json';
const draft = JSON.stringify({ sections: { main: { type: 'main-page' } }, order: ['main'] }, null, 2);
const oldLive = JSON.stringify({ sections: { main: { type: 'main-page', settings: { padding_top: 0 } } }, order: ['main'] });

function setup(opts: { live?: Record<string, string>; staging?: Record<string, string>; liveSyncs?: boolean } = {}) {
  const gh = new FakeGitHub({ 'config/settings_data.json': '{"current":"Default"}', 'templates/page.json': '{}', ...(opts.live ?? {}) });
  // Theme file stores. Live theme mirrors main when "sync" happens; staging theme holds drafts.
  const stagingTheme = new Map<string, string>(Object.entries(opts.staging ?? {}));
  const liveTheme = new Map<string, string>();
  let now = 1_700_000_000_000;
  const promoter = new Promoter({
    gh: gh as unknown as GitHubClient, liveBranch: 'main', stagingBranch: 'staging',
    readStagingFile: async (f) => stagingTheme.get(f) ?? (await gh.getFile(f, 'staging'))?.content ?? null,
    readLiveFile: async (f) => {
      // Simulate Shopify GitHub sync: live theme reflects main (unless disabled), after one poll.
      if (opts.liveSyncs === false) return liveTheme.get(f) ?? null;
      return (await gh.getFile(f, 'main'))?.content ?? null;
    },
    sleep: async () => { now += 1000; }, now: () => now, syncTimeoutMs: 5000,
  });
  return { gh, promoter, stagingTheme, liveTheme };
}

describe('Promoter.promote — scoped promotion', () => {
  it('opens and merges a PR that contains only the approved file, then verifies live', async () => {
    const { gh, promoter, stagingTheme } = setup({ staging: { [TPL]: draft } });
    // Drift on staging that must NOT be promoted: settings_data + another abandoned draft.
    const stagingSha = await gh.createCommit(gh.branches.get('staging')!, [{ path: 'config/settings_data.json', content: '{"current":"Changed on staging"}' }, { path: 'templates/page.abandoned.json', content: '{}' }], 'drift');
    gh.branches.set('staging', stagingSha);
    stagingTheme.set('templates/page.abandoned.json', '{}');
    gh.calls.length = 0;

    const r = await promoter.promote([TPL], { summary: 'Sale page approved' });
    expect(r.status).toBe('promoted');
    expect(r.files).toEqual([{ filename: TPL, action: 'created' }]);
    expect(r.live_verified).toBe(true);
    expect(r.merge_commit_sha).toBeTruthy();
    expect(r.pull_request?.number).toBe(1);

    const mainTree = gh.treeOf('main');
    expect(mainTree.get(TPL)).toBe(draft);
    expect(mainTree.get('config/settings_data.json')).toBe('{"current":"Default"}');
    expect(mainTree.has('templates/page.abandoned.json')).toBe(false);
    const commitCall = gh.calls.find((c) => c.startsWith('createCommit:'));
    expect(commitCall).toBe(`createCommit:${TPL}`);
    expect([...gh.branches.keys()].some((b) => b.startsWith('page-builder/'))).toBe(false); // temp branch cleaned up
    const merge = await gh.getCommit(r.merge_commit_sha!);
    expect(merge.message).toMatch(/^\[page-builder\] promote page\.sale\.json/);
    // Staging still holds real drift (settings tweak + abandoned draft) → cleanup must NOT touch it.
    expect(r.staging_cleanup?.performed).toBe(false);
    expect(r.staging_cleanup?.remaining_drafts).toEqual(expect.arrayContaining(['config/settings_data.json', 'templates/page.abandoned.json']));
    expect(gh.treeOf('staging').has('templates/page.abandoned.json')).toBe(true);
  });

  it('resets staging onto main after promoting when no other drafts remain', async () => {
    const { gh, promoter, stagingTheme } = setup();
    // Draft lives on the staging branch (as the sync would have committed it) and on the staging theme.
    const sha = await gh.createCommit(gh.branches.get('staging')!, [{ path: TPL, content: draft }], 'draft');
    gh.branches.set('staging', sha);
    stagingTheme.set(TPL, draft);
    const r = await promoter.promote([TPL]);
    expect(r.status).toBe('promoted');
    expect(r.staging_cleanup).toMatchObject({ performed: true, remaining_drafts: [] });
    expect(gh.branches.get('staging')).toBe(gh.branches.get('main'));
    expect(gh.treeOf('staging').get(TPL)).toBe(draft);
  });

  it('keeps staging when the only differences are comment headers (semantic compare)', async () => {
    const { gh, promoter, stagingTheme } = setup();
    const headered = '/*\n * auto-generated\n */\n' + draft;
    const sha = await gh.createCommit(gh.branches.get('staging')!, [{ path: TPL, content: headered }], 'draft with header');
    gh.branches.set('staging', sha);
    stagingTheme.set(TPL, headered);
    const r = await promoter.promote([TPL]);
    expect(r.staging_cleanup?.performed).toBe(true);
  });

  it('reports updated vs unchanged and short-circuits when live already matches', async () => {
    const { promoter } = setup({ live: { [TPL]: oldLive }, staging: { [TPL]: draft } });
    const r = await promoter.promote([TPL]);
    expect(r.files[0].action).toBe('updated');
    const again = setup({ live: { [TPL]: draft }, staging: { [TPL]: JSON.stringify(JSON.parse(draft)) } }); // same JSON, different whitespace
    const r2 = await again.promoter.promote([TPL]);
    expect(r2.status).toBe('nothing_to_promote');
    expect(again.gh.calls.some((c) => c.startsWith('createCommit'))).toBe(false);
  });

  it('refuses non-template files, settings_data.json, and missing drafts', async () => {
    const { promoter } = setup();
    await expect(promoter.promote(['config/settings_data.json'])).rejects.toMatchObject({ code: 'PROMOTE_SCOPE' });
    await expect(promoter.promote(['sections/header.liquid'])).rejects.toMatchObject({ code: 'PROMOTE_SCOPE' });
    await expect(promoter.promote(['templates/../config/x.json'])).rejects.toMatchObject({ code: 'PROMOTE_SCOPE' });
    await expect(promoter.promote([TPL])).rejects.toMatchObject({ code: 'PROMOTE_MISSING_DRAFT' });
    await expect(promoter.promote([])).rejects.toMatchObject({ code: 'PROMOTE_EMPTY' });
  });

  it('tells the truth when the live theme never picks up the change', async () => {
    const { promoter } = setup({ staging: { [TPL]: draft }, liveSyncs: false });
    const r = await promoter.promote([TPL]);
    expect(r.status).toBe('promoted');
    expect(r.live_verified).toBe(false);
    expect(r.unverified_files).toEqual([TPL]);
    expect(r.note).toMatch(/had not picked up/);
  });
});

describe('Promoter.rollback', () => {
  it('restores modified files and deletes added ones, via a new merged PR', async () => {
    const { gh, promoter, stagingTheme } = setup({ live: { 'templates/page.about.json': oldLive }, staging: { [TPL]: draft, 'templates/page.about.json': draft } });
    const p = await promoter.promote([TPL, 'templates/page.about.json']);
    expect(gh.treeOf('main').get('templates/page.about.json')).toBe(draft);
    stagingTheme.clear();
    const r = await promoter.rollback(p.merge_commit_sha!);
    expect(r.status).toBe('rolled_back');
    expect(r.files).toEqual(expect.arrayContaining([{ filename: TPL, action: 'deleted' }, { filename: 'templates/page.about.json', action: 'restored' }]));
    expect(gh.treeOf('main').has(TPL)).toBe(false);
    expect(gh.treeOf('main').get('templates/page.about.json')).toBe(oldLive);
    expect(r.live_verified).toBe(true);
    expect(r.pull_request.number).toBe(2);
  });

  it('only reverts commits made by the page builder', async () => {
    const { gh, promoter } = setup();
    const sha = await gh.createCommit(gh.branches.get('main')!, [{ path: 'templates/page.x.json', content: '{}' }], 'manual edit');
    gh.branches.set('main', sha);
    await expect(promoter.rollback(sha)).rejects.toMatchObject({ code: 'ROLLBACK_SCOPE' });
  });
});

describe('Promoter.resetStaging', () => {
  it('force-resets staging to main only when they differ', async () => {
    const { gh, promoter } = setup();
    const r0 = await promoter.resetStaging('force');
    expect(r0.changed).toBe(false);
    const sha = await gh.createCommit(gh.branches.get('main')!, [{ path: 'config/settings_data.json', content: '{"current":"Merchant tweak"}' }], 'customizer');
    gh.branches.set('main', sha);
    const r1 = await promoter.resetStaging('force');
    expect(r1).toMatchObject({ changed: true, main_sha: sha, staging_sha_after: sha });
    expect(gh.calls).toContain('updateBranch:staging:true');
    expect(gh.treeOf('staging').get('config/settings_data.json')).toBe('{"current":"Merchant tweak"}');
  });

  it('merge strategy merges main into staging without force', async () => {
    const { gh, promoter } = setup();
    const sha = await gh.createCommit(gh.branches.get('main')!, [{ path: 'templates/page.json', content: '{"v":2}' }], 'edit');
    gh.branches.set('main', sha);
    const r = await promoter.resetStaging('merge');
    expect(r.changed).toBe(true);
    expect(gh.calls).toContain('mergeBranches:staging<-main');
    expect(gh.calls.some((c) => c.startsWith('updateBranch:staging'))).toBe(false);
    expect(gh.treeOf('staging').get('templates/page.json')).toBe('{"v":2}');
  });

  it('fails loudly when the staging branch is missing', async () => {
    const gh = new FakeGitHub({ 'templates/page.json': '{}' }, ['main']);
    const promoter = new Promoter({ gh: gh as unknown as GitHubClient, liveBranch: 'main', stagingBranch: 'staging', readStagingFile: async () => null, readLiveFile: async () => null, sleep: async () => {} });
    await expect(promoter.resetStaging('force')).rejects.toMatchObject({ code: 'NO_STAGING_BRANCH' });
  });
});

describe('GitHubThemeWriter (fallback write path)', () => {
  it('commits drafts to the staging branch and waits for the staging theme to sync', async () => {
    const { gh, promoter } = setup();
    const writer = new GitHubThemeWriter(gh as unknown as GitHubClient, 'staging', promoter, 5000);
    const r = await writer.writeStaging([{ filename: TPL, content: draft }]);
    expect(r.mode).toBe('github');
    expect(r.synced).toBe(true);
    expect(gh.treeOf('staging').get(TPL)).toBe(draft);
    expect(gh.treeOf('main').has(TPL)).toBe(false);
    expect(gh.calls).toContain('updateBranch:staging:false');
    const d = await writer.deleteStaging([TPL]);
    expect(d.commit_sha).toBeTruthy();
    expect(gh.treeOf('staging').has(TPL)).toBe(false);
  });
});

describe('sameContent', () => {
  it('compares JSON semantically and falls back to trimmed text', () => {
    expect(sameContent('{"a":1}', '{\n  "a": 1\n}\n')).toBe(true);
    expect(sameContent('{"a":1}', '{"a":2}')).toBe(false);
    expect(sameContent(null, null)).toBe(true);
    expect(sameContent(null, '{}')).toBe(false);
    expect(sameContent('x ', 'x')).toBe(true);
    const header = '/*\n * IMPORTANT: auto-generated\n */\n';
    expect(sameContent(header + '{"a":1}', '{"a":1}')).toBe(true); // Shopify-written vs server-written copies
  });
});
