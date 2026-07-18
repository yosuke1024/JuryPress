/**
 * Minimal GitHub Issues REST client shared by the Cloudflare Worker (issue creation) and
 * the operator CLI (issue read/label/comment/close).
 *
 * Deliberately conservative:
 *   - single attempt per call — the workflow re-run (or the reader retrying the form) is
 *     the retry path; unbounded API retries are forbidden,
 *   - the token only ever appears in the Authorization header,
 *   - upstream response bodies are never propagated into thrown errors verbatim; callers
 *     get the HTTP status and a short static description.
 */

export class GitHubApiError extends Error {
  public readonly status: number;

  constructor(status: number, context: string) {
    super(`GitHub API ${context} failed with status ${status}`);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export interface GitHubIssue {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  title: string;
  body: string | null;
  labels: string[];
  is_pull_request: boolean;
}

export interface GitHubIssueComment {
  id: number;
  body: string;
}

export interface GitHubIssuesClientOptions {
  token: string;
  /** `owner/name`. */
  repo: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}

export class GitHubIssuesClient {
  private readonly token: string;
  private readonly repo: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBase: string;
  private readonly timeoutMs: number;

  constructor(options: GitHubIssuesClientOptions) {
    if (!options.token) {
      throw new Error('GitHubIssuesClient requires a token.');
    }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repo)) {
      throw new Error(`GitHubIssuesClient requires an owner/name repo, got "${options.repo}".`);
    }
    this.token = options.token;
    this.repo = options.repo;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 10000;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'JuryPress-Review-Requests/1.0',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async createIssue(input: { title: string; body: string; labels: string[] }): Promise<{ number: number; htmlUrl: string }> {
    const res = await this.request('POST', `/repos/${this.repo}/issues`, {
      title: input.title,
      body: input.body,
      labels: input.labels
    });
    if (res.status !== 201) {
      throw new GitHubApiError(res.status, 'issue creation');
    }
    const data: any = await res.json();
    if (typeof data?.number !== 'number' || typeof data?.html_url !== 'string') {
      throw new GitHubApiError(502, 'issue creation (unexpected response shape)');
    }
    return { number: data.number, htmlUrl: data.html_url };
  }

  async getIssue(issueNumber: number): Promise<GitHubIssue | null> {
    const res = await this.request('GET', `/repos/${this.repo}/issues/${issueNumber}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new GitHubApiError(res.status, 'issue fetch');
    }
    const data: any = await res.json();
    return {
      number: data.number,
      html_url: data.html_url,
      state: data.state,
      title: data.title ?? '',
      body: data.body ?? null,
      labels: Array.isArray(data.labels)
        ? data.labels.map((l: any) => (typeof l === 'string' ? l : l?.name)).filter((l: any) => typeof l === 'string')
        : [],
      is_pull_request: Boolean(data.pull_request)
    };
  }

  async listComments(issueNumber: number): Promise<GitHubIssueComment[]> {
    const res = await this.request('GET', `/repos/${this.repo}/issues/${issueNumber}/comments?per_page=100`);
    if (!res.ok) {
      throw new GitHubApiError(res.status, 'comment listing');
    }
    const data: any = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map((c: any) => ({ id: c.id, body: c.body ?? '' }));
  }

  async createComment(issueNumber: number, body: string): Promise<void> {
    const res = await this.request('POST', `/repos/${this.repo}/issues/${issueNumber}/comments`, { body });
    if (res.status !== 201) {
      throw new GitHubApiError(res.status, 'comment creation');
    }
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    const res = await this.request('POST', `/repos/${this.repo}/issues/${issueNumber}/labels`, { labels });
    if (!res.ok) {
      throw new GitHubApiError(res.status, 'label addition');
    }
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const res = await this.request('DELETE', `/repos/${this.repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`);
    // 404 means the label was not on the issue (or does not exist) — an acceptable no-op
    // for idempotent re-runs.
    if (!res.ok && res.status !== 404) {
      throw new GitHubApiError(res.status, 'label removal');
    }
  }

  async closeIssue(issueNumber: number, stateReason: 'completed' | 'not_planned'): Promise<void> {
    const res = await this.request('PATCH', `/repos/${this.repo}/issues/${issueNumber}`, {
      state: 'closed',
      state_reason: stateReason
    });
    if (!res.ok) {
      throw new GitHubApiError(res.status, 'issue close');
    }
  }
}
