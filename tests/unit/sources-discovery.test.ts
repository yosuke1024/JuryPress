import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GitHubAdapter, NEW_AND_RISING_QUERY } from '../../src/lib/sources/github';
import { HuggingFaceAdapter } from '../../src/lib/sources/hugging_face';

/**
 * Discovery policy v2.1: sources must rank by recency-bounded velocity, not by
 * absolute popularity. These tests pin the query construction and the ranking
 * behavior against mocked API responses.
 */

const RUN_DATE = new Date('2026-07-26T00:00:00Z');

const ghRepo = (overrides: any = {}) => ({
  id: 1,
  full_name: 'owner/repo',
  html_url: 'https://github.com/owner/repo',
  stargazers_count: 100,
  created_at: '2026-07-01T00:00:00Z',
  description: 'desc',
  language: 'TypeScript',
  forks_count: 5,
  ...overrides
});

describe('GitHubAdapter (discovery v2.1)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [] })
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('replaces {DATE:N} tokens with the run date minus N days', async () => {
    const adapter = new GitHubAdapter('test', 'created:>{DATE:14} pushed:>{DATE:30} stars:10..500');
    await adapter.fetchCandidates(RUN_DATE);

    const url = decodeURIComponent(fetchMock.mock.calls[0][0]);
    expect(url).toContain('created:>2026-07-12');
    expect(url).toContain('pushed:>2026-06-26');
    expect(url).toContain('stars:10..500');
  });

  it('keeps legacy {DATE} token meaning run date minus 7 days', async () => {
    const adapter = new GitHubAdapter('test', 'created:>{DATE}');
    await adapter.fetchCandidates(RUN_DATE);
    expect(decodeURIComponent(fetchMock.mock.calls[0][0])).toContain('created:>2026-07-19');
  });

  it('requests 100 results per page', async () => {
    const adapter = new GitHubAdapter('test', 'stars:>1');
    await adapter.fetchCandidates(RUN_DATE);
    expect(fetchMock.mock.calls[0][0]).toContain('per_page=100');
  });

  it('ranks by stars per day, not absolute stars, when rankBy is stars_per_day', async () => {
    // old-big: 3000★ over 300 days = 10★/day; young-riser: 200★ over 4 days = 50★/day.
    const items = [
      ghRepo({ id: 1, full_name: 'org/old-big', stargazers_count: 3000, created_at: '2025-09-29T00:00:00Z' }),
      ghRepo({ id: 2, full_name: 'org/young-riser', stargazers_count: 200, created_at: '2026-07-22T00:00:00Z' })
    ];
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items }) });

    const adapter = new GitHubAdapter('test', 'stars:>1', { rankBy: 'stars_per_day' });
    const candidates = await adapter.fetchCandidates(RUN_DATE);

    expect(candidates[0].name).toBe('org/young-riser');
    expect(candidates[0].sourceRank).toBe(1);
    expect(candidates[1].name).toBe('org/old-big');
    expect((candidates[0].metadata as any).stars_per_day).toBeGreaterThan(
      (candidates[1].metadata as any).stars_per_day
    );
  });

  it('preserves API star order when rankBy is default stars', async () => {
    const items = [
      ghRepo({ id: 1, full_name: 'org/first', stargazers_count: 3000 }),
      ghRepo({ id: 2, full_name: 'org/second', stargazers_count: 200 })
    ];
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ items }) });

    const adapter = new GitHubAdapter('test', 'stars:>1');
    const candidates = await adapter.fetchCandidates(RUN_DATE);
    expect(candidates.map(c => c.name)).toEqual(['org/first', 'org/second']);
  });

  it('New & Rising query bounds both recency and star band', () => {
    expect(NEW_AND_RISING_QUERY).toContain('created:>{DATE:14}');
    expect(NEW_AND_RISING_QUERY).toContain('stars:20..3000');
    expect(NEW_AND_RISING_QUERY).toContain('archived:false');
    expect(NEW_AND_RISING_QUERY).toContain('fork:false');
  });
});

describe('HuggingFaceAdapter (Rising)', () => {
  const hfSpace = (overrides: any = {}) => ({
    id: 'author/space',
    likes: 100,
    createdAt: '2026-07-01T00:00:00Z',
    author: 'author',
    sdk: 'gradio',
    ...overrides
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetchWith = (likesList: any[], createdList: any[] | Error) => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('sort=likes')) {
        return { ok: true, json: async () => likesList };
      }
      if (createdList instanceof Error) {
        return { ok: false, status: 400 };
      }
      return { ok: true, json: async () => createdList };
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('excludes all-time leaderboard entries: too old, too liked, or timestamp-less', async () => {
    stubFetchWith([
      hfSpace({ id: 'a/ancient', createdAt: '2024-01-01T00:00:00Z', likes: 500 }),
      hfSpace({ id: 'b/mega', likes: 16000 }),
      hfSpace({ id: 'c/no-timestamp', createdAt: undefined }),
      hfSpace({ id: 'd/too-quiet', likes: 5 }),
      hfSpace({ id: 'e/valid', likes: 300 })
    ], []);

    const adapter = new HuggingFaceAdapter('huggingface_spaces');
    const candidates = await adapter.fetchCandidates(RUN_DATE);

    expect(candidates.map(c => c.sourceId)).toEqual(['e/valid']);
  });

  it('ranks by likes per day since creation', async () => {
    stubFetchWith([
      hfSpace({ id: 'a/slow', likes: 900, createdAt: '2026-04-27T00:00:00Z' }),  // ~10/day
      hfSpace({ id: 'b/fast', likes: 200, createdAt: '2026-07-22T00:00:00Z' })   // ~50/day
    ], []);

    const adapter = new HuggingFaceAdapter('huggingface_spaces');
    const candidates = await adapter.fetchCandidates(RUN_DATE);

    expect(candidates.map(c => c.sourceId)).toEqual(['b/fast', 'a/slow']);
    expect(candidates[0].sourceRank).toBe(1);
  });

  it('unions the likes and createdAt pools without duplicates', async () => {
    stubFetchWith(
      [hfSpace({ id: 'a/shared', likes: 100 }), hfSpace({ id: 'b/from-likes', likes: 50 })],
      [hfSpace({ id: 'a/shared', likes: 100 }), hfSpace({ id: 'c/from-created', likes: 40 })]
    );

    const adapter = new HuggingFaceAdapter('huggingface_spaces');
    const candidates = await adapter.fetchCandidates(RUN_DATE);
    expect(candidates.map(c => c.sourceId).sort()).toEqual(['a/shared', 'b/from-likes', 'c/from-created']);
  });

  it('survives a failing createdAt sort using the likes pool only', async () => {
    stubFetchWith([hfSpace({ id: 'a/valid', likes: 100 })], new Error('unsupported'));

    const adapter = new HuggingFaceAdapter('huggingface_spaces');
    const candidates = await adapter.fetchCandidates(RUN_DATE);
    expect(candidates.map(c => c.sourceId)).toEqual(['a/valid']);
  });

  it('returns an empty pool (fallback trigger) rather than degrading to all-time ranking', async () => {
    stubFetchWith([
      hfSpace({ id: 'a/ancient', createdAt: '2023-01-01T00:00:00Z', likes: 12000 }),
      hfSpace({ id: 'b/no-timestamp', createdAt: undefined, likes: 9000 })
    ], []);

    const adapter = new HuggingFaceAdapter('huggingface_spaces');
    const candidates = await adapter.fetchCandidates(RUN_DATE);
    expect(candidates).toEqual([]);
  });
});
