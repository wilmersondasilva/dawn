import { ToolError } from '../util.js';

export interface GitHubClientOptions { owner: string; repo: string; token: string; fetch?: typeof fetch; apiBase?: string }
export interface CommitInfo { sha: string; parents: string[]; message: string; files: Array<{ filename: string; status: string; previous_filename?: string }> }
export interface PullInfo { number: number; html_url: string; head: string; base: string }
export interface FileChange { path: string; content: string | null } // null = delete

/** Minimal GitHub REST client (fetch-based, no SDK) covering exactly what the server needs. */
export class GitHubClient {
  private readonly fetchFn: typeof fetch;
  private readonly base: string;
  constructor(private readonly opts: GitHubClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.base = (opts.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
  }

  get repoSlug(): string { return `${this.opts.owner}/${this.opts.repo}`; }

  private async api<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; json: T }> {
    const res = await this.fetchFn(`${this.base}/repos/${this.repoSlug}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'shopify-page-builder-mcp',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok && !okStatuses.includes(res.status)) {
      const msg = (json as { message?: string })?.message ?? text.slice(0, 300);
      if (res.status === 401) throw new ToolError('GitHub rejected the server\'s access token.', 'The fine-grained token may have expired; create a new one and update GITHUB_TOKEN.', 'GITHUB_UNAUTHORIZED');
      if (res.status === 403 || res.status === 404) throw new ToolError(`GitHub refused ${method} ${path} (${res.status}: ${msg}).`, 'Check the token has Contents: read/write and Pull requests: read/write on this repository.', 'GITHUB_FORBIDDEN');
      throw new ToolError(`GitHub error on ${method} ${path}: ${res.status} ${msg}`, undefined, 'GITHUB_ERROR', json);
    }
    return { status: res.status, json: json as T };
  }

  async getBranchSha(branch: string): Promise<string> {
    const { json } = await this.api<{ object: { sha: string } }>('GET', `/git/ref/heads/${encodeURIComponent(branch)}`);
    return json.object.sha;
  }

  async branchExists(branch: string): Promise<boolean> {
    try { await this.getBranchSha(branch); return true; } catch (e) { if ((e as ToolError).code === 'GITHUB_FORBIDDEN') return false; throw e; }
  }

  async createBranch(branch: string, sha: string): Promise<void> {
    await this.api('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
  }

  async updateBranch(branch: string, sha: string, force: boolean): Promise<void> {
    await this.api('PATCH', `/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force });
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.api('DELETE', `/git/refs/heads/${encodeURIComponent(branch)}`, undefined, [404, 422]);
  }

  /** Merge `head` into `base` via GitHub's merge endpoint (creates a merge commit on base). Returns null if already up to date. */
  async mergeBranches(base: string, head: string, message: string): Promise<string | null> {
    const { status, json } = await this.api<{ sha?: string; message?: string }>('POST', '/merges', { base, head, commit_message: message }, [204, 409]);
    if (status === 204) return null;
    if (status === 409) throw new ToolError(`Branch "${base}" has conflicts with "${head}" and cannot be merged automatically.`, 'Set STAGING_RESET_STRATEGY=force so staging is reset to match main.', 'GITHUB_MERGE_CONFLICT');
    return json.sha ?? null;
  }

  async getFile(path: string, ref: string): Promise<{ content: string; sha: string } | null> {
    const { status, json } = await this.api<{ content: string; encoding: string; sha: string }>('GET', `/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, undefined, [404]);
    if (status === 404) return null;
    return { content: Buffer.from(json.content, json.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'), sha: json.sha };
  }

  /** Create a single commit on top of `parentSha` containing exactly `changes`; returns the new commit sha. Does not move any ref. */
  async createCommit(parentSha: string, changes: FileChange[], message: string): Promise<string> {
    const { json: parent } = await this.api<{ tree: { sha: string } }>('GET', `/git/commits/${parentSha}`);
    const tree: Array<{ path: string; mode: '100644'; type: 'blob'; sha: string | null }> = [];
    for (const c of changes) {
      if (c.content === null) { tree.push({ path: c.path, mode: '100644', type: 'blob', sha: null }); continue; }
      const { json: blob } = await this.api<{ sha: string }>('POST', '/git/blobs', { content: Buffer.from(c.content, 'utf8').toString('base64'), encoding: 'base64' });
      tree.push({ path: c.path, mode: '100644', type: 'blob', sha: blob.sha });
    }
    const { json: newTree } = await this.api<{ sha: string }>('POST', '/git/trees', { base_tree: parent.tree.sha, tree });
    const { json: commit } = await this.api<{ sha: string }>('POST', '/git/commits', { message, tree: newTree.sha, parents: [parentSha] });
    return commit.sha;
  }

  async createPull(input: { title: string; body: string; head: string; base: string }): Promise<PullInfo> {
    const { json } = await this.api<{ number: number; html_url: string; head: { ref: string }; base: { ref: string } }>('POST', '/pulls', input);
    return { number: json.number, html_url: json.html_url, head: json.head.ref, base: json.base.ref };
  }

  async mergePull(number: number, opts: { method: 'merge' | 'squash'; title: string; message?: string }): Promise<string> {
    const { status, json } = await this.api<{ sha?: string; merged?: boolean; message?: string }>('PUT', `/pulls/${number}/merge`, { merge_method: opts.method, commit_title: opts.title, commit_message: opts.message ?? '' }, [405, 409]);
    if (status === 405 || status === 409 || !json.sha) {
      throw new ToolError(`GitHub could not merge pull request #${number}: ${json.message ?? 'not mergeable'}.`, 'If branch protection is enabled on main, the token\'s account must be allowed to merge. Otherwise retry in a moment.', 'GITHUB_MERGE_FAILED');
    }
    return json.sha;
  }

  async getCommit(sha: string): Promise<CommitInfo> {
    const { json } = await this.api<{ sha: string; parents: Array<{ sha: string }>; commit: { message: string }; files?: CommitInfo['files'] }>('GET', `/commits/${sha}`);
    return { sha: json.sha, parents: json.parents.map((p) => p.sha), message: json.commit.message, files: json.files ?? [] };
  }

  async listCommits(branch: string, perPage = 30): Promise<Array<{ sha: string; message: string; date: string | null }>> {
    const { json } = await this.api<Array<{ sha: string; commit: { message: string; committer?: { date?: string } | null } }>>('GET', `/commits?sha=${encodeURIComponent(branch)}&per_page=${Math.min(100, perPage)}`);
    return json.map((c) => ({ sha: c.sha, message: c.commit.message, date: c.commit.committer?.date ?? null }));
  }

  async compare(base: string, head: string): Promise<{ ahead_by: number; behind_by: number; files: string[] }> {
    const { json } = await this.api<{ ahead_by: number; behind_by: number; files?: Array<{ filename: string }> }>('GET', `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    return { ahead_by: json.ahead_by, behind_by: json.behind_by, files: (json.files ?? []).map((f) => f.filename) };
  }
}
