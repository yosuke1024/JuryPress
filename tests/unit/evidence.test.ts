import { describe, it, expect, vi } from 'vitest';
import { EvidenceCollector } from '../../src/lib/evidence/collector';

describe('EvidenceCollector', () => {
  it('should not add duplicate URLs', async () => {
    const collector = new EvidenceCollector();
    // mock safeFetch
    (collector as any).safeFetch = vi.fn().mockImplementation((url) => Promise.resolve(`<html><body>Test ${url}</body></html>`));

    const candidate = {
      name: 'Test',
      canonicalUrl: 'https://github.com/user/repo',
      sourceUrl: 'https://github.com/user/repo',
      source: 'GitHub',
      sourceId: '123',
      sourceRank: 1,
      popularityValue: 100,
      popularityUnit: 'stars',
      collectedAt: new Date().toISOString(),
      metadata: {}
    };

    const evs = await collector.collect(candidate);
    // Because canonicalUrl and sourceUrl are the same, it shouldn't fetch the second one.
    // However, the fallback for github will fetch the API.
    // So there should be exactly 3 distinct pieces of evidence (official + API + README)
    expect(evs.length).toBe(3);
    expect(evs[0].url).toBe('https://github.com/user/repo');
    expect(evs[1].url).toBe('https://api.github.com/repos/user/repo');
    expect(evs[2].url).toBe('https://raw.githubusercontent.com/user/repo/HEAD/README.md');
  });
});
