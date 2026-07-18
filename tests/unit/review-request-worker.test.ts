import { describe, it, expect } from 'vitest';
import { handleReviewRequestApi, type ReviewRequestWorkerEnv } from '../../src/worker/review-requests';

/**
 * Worker API tests. All outbound calls (Turnstile siteverify, GitHub) are mocked through
 * the injectable fetch; no network is ever touched.
 */

const API_URL = 'https://pixapps.ai/jurypress/api/review-requests';
const ORIGIN = 'https://pixapps.ai';
const SECRET = 'turnstile-secret-value';
const TOKEN = 'github-token-value';

const validPayload = {
  product_name: 'Great Tool',
  canonical_repository_url: 'https://github.com/owner/great-tool',
  purpose: 'A command-line tool that automates dependency updates safely.',
  requester_relationship: 'user',
  consent_public_issue: true,
  consent_no_guarantee: true,
  turnstile_token: 'tok-abc',
  website: ''
};

interface MockCall {
  url: string;
  init?: RequestInit;
}

function makeEnv(overrides: Partial<ReviewRequestWorkerEnv> = {}): ReviewRequestWorkerEnv {
  return {
    ASSETS: { fetch: async () => new Response('asset') },
    TURNSTILE_SECRET_KEY: SECRET,
    JURYPRESS_ISSUE_TOKEN: TOKEN,
    ...overrides
  };
}

function makeRequest(body: unknown, init: { method?: string; origin?: string | null; contentType?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (init.origin !== null) headers['Origin'] = init.origin ?? ORIGIN;
  headers['Content-Type'] = init.contentType ?? 'application/json';
  return new Request(API_URL, {
    method: init.method ?? 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

function mockFetch(handlers: {
  turnstile?: (init?: RequestInit) => Response | Promise<Response>;
  github?: (init?: RequestInit) => Response | Promise<Response>;
}, calls: MockCall[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const hostname = new URL(url).hostname;
    if (hostname === 'challenges.cloudflare.com') {
      if (!handlers.turnstile) throw new Error('unexpected turnstile call');
      return handlers.turnstile(init);
    }
    if (hostname === 'api.github.com') {
      if (!handlers.github) throw new Error('unexpected github call');
      return handlers.github(init);
    }
    throw new Error(`unexpected outbound call: ${url}`);
  }) as typeof fetch;
}

const turnstileOk = () => new Response(JSON.stringify({
  success: true,
  hostname: 'pixapps.ai',
  action: 'review-request'
}), { status: 200 });

const githubCreated = () => new Response(JSON.stringify({
  number: 123,
  html_url: 'https://github.com/yosuke1024/JuryPress/issues/123'
}), { status: 201 });

describe('handleReviewRequestApi', () => {
  it('creates an issue and returns only the issue number and URL', async () => {
    const calls: MockCall[] = [];
    const res = await handleReviewRequestApi(makeRequest(validPayload), makeEnv(), {
      fetchImpl: mockFetch({ turnstile: turnstileOk, github: githubCreated }, calls),
      randomUUID: () => '7f9c1c3a-2f6e-4a44-9d3c-2b1f5a8e9d10'
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({
      issueNumber: 123,
      issueUrl: 'https://github.com/yosuke1024/JuryPress/issues/123'
    });

    // The GitHub call carries the machine block, labels, and the escaped title.
    const githubCall = calls.find(c => c.url.includes('api.github.com'))!;
    const issuePayload = JSON.parse(String(githubCall.init?.body));
    expect(githubCall.url).toBe('https://api.github.com/repos/yosuke1024/JuryPress/issues');
    expect(issuePayload.title).toBe('[Review Request] Great Tool');
    expect(issuePayload.labels).toEqual(['review-request', 'review:awaiting-operator']);
    expect(issuePayload.body).toContain('jurypress-review-request:v1');
    expect(issuePayload.body).toContain('https://github.com/owner/great-tool');
  });

  it('rejects non-POST methods', async () => {
    const res = await handleReviewRequestApi(new Request(API_URL, { method: 'GET' }), makeEnv(), {
      fetchImpl: mockFetch({})
    });
    expect(res.status).toBe(405);
  });

  it('fails closed with 503 when secrets are missing, before any outbound call', async () => {
    const calls: MockCall[] = [];
    const noSecret = await handleReviewRequestApi(makeRequest(validPayload), makeEnv({ TURNSTILE_SECRET_KEY: '' }), {
      fetchImpl: mockFetch({}, calls)
    });
    expect(noSecret.status).toBe(503);

    const noToken = await handleReviewRequestApi(makeRequest(validPayload), makeEnv({ JURYPRESS_ISSUE_TOKEN: '' }), {
      fetchImpl: mockFetch({}, calls)
    });
    expect(noToken.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('rejects cross-origin and origin-less requests', async () => {
    const cross = await handleReviewRequestApi(makeRequest(validPayload, { origin: 'https://evil.dev' }), makeEnv(), {
      fetchImpl: mockFetch({})
    });
    expect(cross.status).toBe(403);

    const none = await handleReviewRequestApi(makeRequest(validPayload, { origin: null }), makeEnv(), {
      fetchImpl: mockFetch({})
    });
    expect(none.status).toBe(403);
  });

  it('rejects wrong content types', async () => {
    const res = await handleReviewRequestApi(makeRequest(validPayload, { contentType: 'text/plain' }), makeEnv(), {
      fetchImpl: mockFetch({})
    });
    expect(res.status).toBe(415);
  });

  it('rejects oversized bodies', async () => {
    const res = await handleReviewRequestApi(makeRequest(JSON.stringify({ x: 'y'.repeat(40000) })), makeEnv(), {
      fetchImpl: mockFetch({})
    });
    expect(res.status).toBe(413);
  });

  it('rejects invalid JSON', async () => {
    const res = await handleReviewRequestApi(makeRequest('{ not json'), makeEnv(), {
      fetchImpl: mockFetch({})
    });
    expect(res.status).toBe(400);
  });

  it('rejects a filled honeypot without calling Turnstile or GitHub', async () => {
    const calls: MockCall[] = [];
    const res = await handleReviewRequestApi(
      makeRequest({ ...validPayload, website: 'https://spam.dev' }),
      makeEnv(),
      { fetchImpl: mockFetch({}, calls) }
    );
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('rejects schema-invalid payloads', async () => {
    const res = await handleReviewRequestApi(
      makeRequest({ ...validPayload, canonical_repository_url: 'https://gitlab.com/x/y' }),
      makeEnv(),
      { fetchImpl: mockFetch({}) }
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
  });

  it('rejects failed, expired, and re-used Turnstile tokens', async () => {
    const failed = () => new Response(JSON.stringify({
      success: false,
      'error-codes': ['timeout-or-duplicate']
    }), { status: 200 });

    const res = await handleReviewRequestApi(makeRequest(validPayload), makeEnv(), {
      fetchImpl: mockFetch({ turnstile: failed })
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('turnstile_failed');
  });

  it('rejects a Turnstile verdict for the wrong hostname or action', async () => {
    const wrongHost = () => new Response(JSON.stringify({
      success: true, hostname: 'evil.dev', action: 'review-request'
    }), { status: 200 });
    const res1 = await handleReviewRequestApi(makeRequest(validPayload), makeEnv(), {
      fetchImpl: mockFetch({ turnstile: wrongHost })
    });
    expect(res1.status).toBe(400);

    const wrongAction = () => new Response(JSON.stringify({
      success: true, hostname: 'pixapps.ai', action: 'login'
    }), { status: 200 });
    const res2 = await handleReviewRequestApi(makeRequest(validPayload), makeEnv(), {
      fetchImpl: mockFetch({ turnstile: wrongAction })
    });
    expect(res2.status).toBe(400);
  });

  it('returns 503 when Turnstile verification is unreachable', async () => {
    const res = await handleReviewRequestApi(makeRequest(validPayload), makeEnv(), {
      fetchImpl: mockFetch({ turnstile: () => { throw new Error('network down'); } })
    });
    expect(res.status).toBe(503);
  });

  it('maps GitHub 403/429 to a public rate-limit error and 422/5xx to unavailability', async () => {
    for (const [githubStatus, expected] of [[403, 429], [429, 429], [422, 503], [500, 503]] as const) {
      const res = await handleReviewRequestApi(makeRequest(validPayload), makeEnv(), {
        fetchImpl: mockFetch({
          turnstile: turnstileOk,
          github: () => new Response(JSON.stringify({ message: 'upstream detail that must not leak' }), { status: githubStatus })
        })
      });
      expect(res.status).toBe(expected);
      const text = await res.text();
      expect(text).not.toContain('upstream detail');
    }
  });

  it('never leaks the token or upstream bodies in any response', async () => {
    const cases: Array<Promise<Response>> = [
      handleReviewRequestApi(makeRequest(validPayload), makeEnv(), {
        fetchImpl: mockFetch({ turnstile: turnstileOk, github: () => new Response('secret upstream body', { status: 502 }) })
      }),
      handleReviewRequestApi(makeRequest(validPayload), makeEnv(), {
        fetchImpl: mockFetch({ turnstile: turnstileOk, github: githubCreated })
      })
    ];
    for (const resPromise of cases) {
      const res = await resPromise;
      const text = await res.text();
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('secret upstream body');
    }
  });
});
