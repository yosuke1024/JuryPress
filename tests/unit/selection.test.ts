import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Selector } from '../../src/lib/selection/selector';
import { getSourceAdapter } from '../../src/lib/sources';
import * as fs from 'fs';

vi.mock('../../src/lib/sources', () => ({
  getSourceAdapter: vi.fn()
}));

vi.mock('../../src/lib/evidence/collector', () => {
  return {
    EvidenceCollector: class {
      collect = vi.fn().mockResolvedValue([
        {
          evidence_id: 'ev-1',
          type: 'official_site',
          url: 'https://example.com',
          title: 'Mock Site',
          summary: 'A very long mock text that easily exceeds fifteen hundred characters to pass the selection criteria and qualify this candidate. '.repeat(15),
          claims: []
        },
        {
          evidence_id: 'ev-2',
          type: 'readme',
          url: 'https://example.com/readme',
          title: 'Mock Readme',
          summary: 'Another long piece of text that helps build out the required characters count for the mock selection run. '.repeat(15),
          claims: []
        }
      ]);
    }
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn()
  };
});

describe('Selector Integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (fs.readFileSync as any).mockImplementation((p: string) => {
      if (p.includes('sources.yml')) {
        return `
timezone: Asia/Tokyo
schedule:
  monday:
    primary: source-a
    fallback: [source-b]
`;
      }
      if (p.includes('season.json')) {
        return JSON.stringify({ season: 1 });
      }
      return '{}';
    });
    
    (fs.existsSync as any).mockReturnValue(false); // No history by default
  });

  const getMockCandidate = (overrides: any = {}) => ({
    sourceId: 'source-a',
    id: '123',
    name: 'Show HN: Valid Product',
    url: 'https://example.com/item/123',
    canonicalUrl: 'https://valid-product.com',
    sourceRank: 1,
    popularityValue: 100,
    popularityUnit: 'points',
    publishedAt: new Date().toISOString(),
    author: 'author',
    description: 'desc',
    metadata: {},
    sourceUrl: 'https://example.com/item/123',
    ...overrides
  });

  it('should rank by sourceRank asc, popularity desc, url asc', async () => {
    const candidates = [
      getMockCandidate({ canonicalUrl: 'https://z.com', sourceRank: 2, popularityValue: 100 }),
      getMockCandidate({ canonicalUrl: 'https://a.com', sourceRank: 1, popularityValue: 50 }),
      getMockCandidate({ canonicalUrl: 'https://b.com', sourceRank: 1, popularityValue: 100 }),
      getMockCandidate({ canonicalUrl: 'https://c.com', sourceRank: 1, popularityValue: 100 })
    ];

    (getSourceAdapter as any).mockReturnValue({
      fetchCandidates: vi.fn().mockResolvedValue(candidates)
    });

    const selector = new Selector();
    // 2026-07-13 is a Monday
    const result = await selector.selectForDate(new Date('2026-07-13T00:00:00Z'));
    
    // Expected order:
    // 1. b.com (rank 1, pop 100, string b)
    // 2. c.com (rank 1, pop 100, string c)
    // 3. a.com (rank 1, pop 50)
    // 4. z.com (rank 2)
    expect(result.candidate.canonicalUrl).toBe('https://b.com');
  });

  it('should exclude candidates based on heuristic rules (jobs, news)', async () => {
    const candidates = [
      getMockCandidate({ name: 'Show HN: GoodNewsApp', canonicalUrl: 'https://goodnewsapp.com' }), // should be selected
      getMockCandidate({ canonicalUrl: 'https://nytimes.com/article' }), // newspaper domain
      getMockCandidate({ name: 'Show HN: My new blog post', canonicalUrl: 'https://personalblog.com' }), // has 'blog' word
      getMockCandidate({ name: 'Acme is hiring engineers', canonicalUrl: 'https://acme.com' }), // hiring
      getMockCandidate({ name: 'Show HN: Learn Astro tutorial', canonicalUrl: 'https://astro-tutorial.com' }), // tutorial
      getMockCandidate({ name: 'PDF reader tool', canonicalUrl: 'https://example.com/doc.pdf' }) // ends in .pdf
    ];

    (getSourceAdapter as any).mockReturnValue({
      fetchCandidates: vi.fn().mockResolvedValue(candidates)
    });

    const selector = new Selector();
    const result = await selector.selectForDate(new Date('2026-07-13T00:00:00Z'));
    
    expect(result.candidate.canonicalUrl).toBe('https://goodnewsapp.com');
  });

  it('should fallback to secondary source if primary fails', async () => {
    (getSourceAdapter as any).mockImplementation((id: string) => {
      if (id === 'source-a') {
        return { fetchCandidates: vi.fn().mockRejectedValue(new Error('API Down')) };
      }
      return {
        fetchCandidates: vi.fn().mockResolvedValue([getMockCandidate({ sourceId: 'source-b', canonicalUrl: 'https://fallback.com' })])
      };
    });

    const selector = new Selector();
    const result = await selector.selectForDate(new Date('2026-07-13T00:00:00Z'));
    
    expect(result.candidate.sourceId).toBe('source-b');
    expect(result.candidate.canonicalUrl).toBe('https://fallback.com');
  });

  it('should ensure same inputs yield same deterministic output', async () => {
    const candidates = [
      getMockCandidate({ canonicalUrl: 'https://z.com', sourceRank: 1, popularityValue: 100 }),
      getMockCandidate({ canonicalUrl: 'https://a.com', sourceRank: 1, popularityValue: 100 })
    ];

    (getSourceAdapter as any).mockReturnValue({
      fetchCandidates: vi.fn().mockResolvedValue(candidates)
    });

    const selector = new Selector();
    const run1 = await selector.selectForDate(new Date('2026-07-13T00:00:00Z'));
    const run2 = await selector.selectForDate(new Date('2026-07-13T00:00:00Z'));
    
    expect(run1.candidate.canonicalUrl).toBe('https://a.com');
    expect(run2.candidate.canonicalUrl).toBe('https://a.com');
    expect(run1.selection.run_key).toBe(run2.selection.run_key);
  });
});
