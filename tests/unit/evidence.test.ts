import { describe, it, expect, vi } from 'vitest';
import { EvidenceCollector } from '../../src/lib/evidence/collector';

describe('EvidenceCollector', () => {
  it('should not add duplicate URLs', async () => {
    const collector = new EvidenceCollector();
    // mock safeFetch
    (collector as any).safeFetch = vi.fn().mockImplementation((url) => {
      if (url.includes('api.github.com/repos/')) {
        if (url.includes('/contents/')) {
          return Promise.resolve(JSON.stringify([]));
        }
        if (url.includes('/releases')) {
          return Promise.resolve(JSON.stringify([]));
        }
        return Promise.resolve(JSON.stringify({
          stargazers_count: 100,
          forks_count: 10,
          license: { spdx_id: 'MIT' },
          created_at: '2026-01-01',
          updated_at: '2026-07-01',
          pushed_at: '2026-07-14',
          default_branch: 'main'
        }));
      }
      return Promise.resolve(`<html><body>Test ${url}</body></html>`);
    });

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
    const urls = evs.map(e => e.url);
    expect(urls).toContain('https://github.com/user/repo');
    expect(urls).toContain('https://api.github.com/repos/user/repo');
    expect(urls).toContain('https://raw.githubusercontent.com/user/repo/main/README.md');
  });
});
