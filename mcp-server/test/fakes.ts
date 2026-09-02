import { createHash } from 'node:crypto';
import type { FileChange } from '../src/github/client.js';

interface FakeCommit { sha: string; parents: string[]; tree: Map<string, string>; message: string; changed: Array<{ filename: string; status: string }> }

/** In-memory stand-in for GitHubClient covering the methods the server uses. */
export class FakeGitHub {
  branches = new Map<string, string>();
  commits = new Map<string, FakeCommit>();
  pulls: Array<{ number: number; head: string; base: string; title: string; merged?: string }> = [];
  calls: string[] = [];
  private n = 0;
  repoSlug = 'acme/theme';

  constructor(initial: Record<string, string>, branches: string[] = ['main', 'staging']) {
    const root = this.addCommit([], new Map(Object.entries(initial)), 'root', []);
    for (const b of branches) this.branches.set(b, root);
  }

  private sha(s: string): string { return createHash('sha1').update(s + this.n++).digest('hex'); }
  private addCommit(parents: string[], tree: Map<string, string>, message: string, changed: FakeCommit['changed']): string {
    const sha = this.sha(message);
    this.commits.set(sha, { sha, parents, tree, message, changed });
    return sha;
  }
  treeOf(branch: string): Map<string, string> { return this.commits.get(this.branches.get(branch)!)!.tree; }

  async getBranchSha(b: string) { this.calls.push(`getBranchSha:${b}`); const s = this.branches.get(b); if (!s) throw Object.assign(new Error('nf'), { code: 'GITHUB_FORBIDDEN' }); return s; }
  async branchExists(b: string) { return this.branches.has(b); }
  async createBranch(b: string, sha: string) { this.calls.push(`createBranch:${b}`); this.branches.set(b, sha); }
  async updateBranch(b: string, sha: string, force: boolean) { this.calls.push(`updateBranch:${b}:${force}`); this.branches.set(b, sha); }
  async deleteBranch(b: string) { this.calls.push(`deleteBranch:${b}`); this.branches.delete(b); }
  async mergeBranches(base: string, head: string, message: string) {
    this.calls.push(`mergeBranches:${base}<-${head}`);
    const baseSha = this.branches.get(base)!; const headSha = this.branches.get(head)!;
    if (baseSha === headSha) return null;
    const tree = new Map([...this.commits.get(baseSha)!.tree, ...this.commits.get(headSha)!.tree]);
    const sha = this.addCommit([baseSha, headSha], tree, message, []);
    this.branches.set(base, sha);
    return sha;
  }
  async getFile(path: string, ref: string) {
    const sha = this.branches.get(ref) ?? ref;
    const c = this.commits.get(sha); if (!c) return null;
    const content = c.tree.get(path);
    return content === undefined ? null : { content, sha: 'blob' };
  }
  async createCommit(parentSha: string, changes: FileChange[], message: string) {
    this.calls.push(`createCommit:${changes.map((c) => c.path).join('|')}`);
    const parent = this.commits.get(parentSha)!;
    const tree = new Map(parent.tree);
    const changed: FakeCommit['changed'] = [];
    for (const c of changes) {
      const existed = tree.has(c.path);
      if (c.content === null) { tree.delete(c.path); changed.push({ filename: c.path, status: 'removed' }); }
      else { tree.set(c.path, c.content); changed.push({ filename: c.path, status: existed ? 'modified' : 'added' }); }
    }
    return this.addCommit([parentSha], tree, message, changed);
  }
  async createPull(input: { title: string; body: string; head: string; base: string }) {
    const number = this.pulls.length + 1;
    this.pulls.push({ number, head: input.head, base: input.base, title: input.title });
    return { number, html_url: `https://github.com/acme/theme/pull/${number}`, head: input.head, base: input.base };
  }
  async mergePull(number: number, opts: { method: string; title: string }) {
    const pr = this.pulls[number - 1];
    const headSha = this.branches.get(pr.head)!; const baseSha = this.branches.get(pr.base)!;
    const head = this.commits.get(headSha)!;
    const sha = this.addCommit([baseSha, headSha], new Map(head.tree), `Merge: ${opts.title}`, head.changed);
    this.branches.set(pr.base, sha);
    pr.merged = sha;
    this.calls.push(`mergePull:${number}`);
    return sha;
  }
  async getCommit(sha: string) { const c = this.commits.get(sha)!; return { sha, parents: c.parents, message: c.message.replace(/^Merge: /, ''), files: c.changed }; }
  async compare(base: string, head: string) {
    const bt = this.treeOf(base); const ht = this.treeOf(head);
    const files: string[] = [];
    for (const k of new Set([...bt.keys(), ...ht.keys()])) if (bt.get(k) !== ht.get(k)) files.push(k);
    return { ahead_by: 0, behind_by: 0, files };
  }
  async listCommits(branch: string) {
    const out: Array<{ sha: string; message: string; date: string | null }> = [];
    let sha: string | undefined = this.branches.get(branch);
    while (sha) { const c = this.commits.get(sha)!; out.push({ sha, message: c.message.replace(/^Merge: /, ''), date: null }); sha = c.parents[0]; }
    return out;
  }
}

/** Minimal fetch mock: queue of responders or a router function. */
export function mockFetch(router: (url: string, init?: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> } | Promise<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const r = await router(url, init);
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}
