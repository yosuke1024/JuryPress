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

/**
 * Root-manifest presence, the primary runnability attestation. Production run
 * season-2-2026-08-29-daily (YangJiiii/3105) failed the publication gate as unrunnable: a
 * native iOS app carries no npm/pip-style manifest, so the narrower list reported
 * `package_manifest: false` for a repository whose root holds an Xcode project.
 */
describe('EvidenceCollector — root build manifest presence', () => {
  function collectorWithRootListing(names: string[]) {
    const collector = new EvidenceCollector();
    (collector as any).safeFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('api.github.com/repos/')) {
        if (url.includes('/contents/')) {
          return Promise.resolve(JSON.stringify(names.map(name => ({ name, path: name }))));
        }
        if (url.includes('/releases') || url.includes('/commits')) {
          return Promise.resolve(JSON.stringify([]));
        }
        return Promise.resolve(JSON.stringify({
          stargazers_count: 498,
          forks_count: 57,
          license: { spdx_id: 'GPL-3.0' },
          created_at: '2026-08-14',
          updated_at: '2026-08-28',
          pushed_at: '2026-08-25',
          default_branch: 'main'
        }));
      }
      return Promise.resolve(`<html><body>Test ${url}</body></html>`);
    });
    return collector;
  }

  async function presenceFor(names: string[]) {
    const collector = collectorWithRootListing(names);
    const evs = await collector.collect({
      name: 'Test',
      canonicalUrl: 'https://github.com/user/repo',
      sourceUrl: 'https://github.com/user/repo',
      source: 'GitHub',
      sourceId: '123',
      sourceRank: 1,
      popularityValue: 498,
      popularityUnit: 'stars',
      collectedAt: new Date().toISOString(),
      metadata: {}
    });
    const api = evs.find(e => e.type === 'api_metadata');
    return JSON.parse(api!.summary).presence;
  }

  it('attests an Xcode project directory at the root (3105 shape)', async () => {
    expect((await presenceFor(['ThreeOneOSFive.xcodeproj', 'README.md', 'LICENSE'])).package_manifest).toBe(true);
  });

  it('attests an Xcode workspace, a SwiftPM manifest and a Podfile', async () => {
    expect((await presenceFor(['App.xcworkspace'])).package_manifest).toBe(true);
    expect((await presenceFor(['Package.swift'])).package_manifest).toBe(true);
    expect((await presenceFor(['Podfile'])).package_manifest).toBe(true);
  });

  it('keeps reporting no manifest for a repository that carries none', async () => {
    expect((await presenceFor(['README.md', 'LICENSE', 'docs'])).package_manifest).toBe(false);
  });
});
