import { describe, it, expect } from 'vitest';
import { EvidenceCollector } from '../../src/lib/evidence/collector';
import { factClassForEvidence } from '../../src/lib/evaluation/public-claims';
import type { Evidence } from '../../src/schemas/evidence';
import {
  buildOfficialDocUrls,
  isSameOfficialHost,
  resolveOfficialOrigin,
  OFFICIAL_DOCS_FETCH_CAP
} from '../../src/lib/evidence/official-docs';

/**
 * The security property under test: the subject of a review cannot choose what JuryPress
 * reads about it. The official host comes from the GitHub API's homepage field; the README —
 * written by the project — may only point at paths inside a host already confirmed that way.
 */

describe('resolveOfficialOrigin', () => {
  it('accepts an https homepage', () => {
    expect(resolveOfficialOrigin('https://example.com/')?.hostname).toBe('example.com');
  });

  it.each([
    ['plain http', 'http://example.com'],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a non-URL', 'not a url'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a file: URL', 'file:///etc/passwd'],
    ['null', null],
    ['a number', 42]
  ])('rejects %s', (_label, value) => {
    expect(resolveOfficialOrigin(value)).toBeNull();
  });

  it.each([
    'https://github.com/owner/repo',
    'https://gitlab.com/owner/repo',
    'https://huggingface.co/spaces/x',
    'https://pypi.org/project/x',
    'https://crates.io/crates/x'
  ])('rejects the code-hosting domain %s', homepage => {
    // Already collected through their own paths; a homepage pointing back at the repository
    // would spend the budget re-reading what has been read.
    expect(resolveOfficialOrigin(homepage)).toBeNull();
  });
});

describe('isSameOfficialHost', () => {
  const origin = new URL('https://x.ai/');

  it('accepts the same host', () => {
    expect(isSameOfficialHost('https://x.ai/docs/cli', origin)).toBe(true);
  });

  it.each([
    ['a suffix lookalike', 'https://evil-x.ai/docs'],
    ['a subdomain', 'https://docs.x.ai/cli'],
    ['a host containing the name', 'https://x.ai.attacker.com/docs'],
    ['plain http on the same host', 'http://x.ai/docs'],
    ['a different host entirely', 'https://attacker.example/docs']
  ])('rejects %s', (_label, candidate) => {
    expect(isSameOfficialHost(candidate, origin)).toBe(false);
  });
});

describe('buildOfficialDocUrls', () => {
  it('returns nothing when the repository declares no homepage', () => {
    expect(buildOfficialDocUrls({ homepage: null })).toEqual([]);
    expect(buildOfficialDocUrls({ homepage: undefined })).toEqual([]);
  });

  it('tries the homepage and the conventional documentation paths', () => {
    const urls = buildOfficialDocUrls({ homepage: 'https://x.ai/' });
    expect(urls[0]).toBe('https://x.ai/');
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://x.ai/docs',
        'https://x.ai/changelog',
        'https://x.ai/pricing',
        'https://x.ai/news'
      ])
    );
  });

  it('follows a README link only when it is on the confirmed host', () => {
    const urls = buildOfficialDocUrls({
      homepage: 'https://x.ai/',
      readmeText: 'See https://x.ai/build/cli/reference for details.'
    });
    expect(urls).toContain('https://x.ai/build/cli/reference');
  });

  it('ignores README links to any other host', () => {
    // The core rule: a README can suggest a path, never introduce a host.
    const urls = buildOfficialDocUrls({
      homepage: 'https://x.ai/',
      readmeText: [
        'Docs: https://attacker.example/docs',
        'Mirror: https://evil-x.ai/docs',
        'Internal: http://169.254.169.254/latest/meta-data/',
        'Local: http://localhost:8080/admin'
      ].join('\n')
    });
    expect(urls.some(u => u.includes('attacker.example'))).toBe(false);
    expect(urls.some(u => u.includes('evil-x.ai'))).toBe(false);
    expect(urls.some(u => u.includes('169.254'))).toBe(false);
    expect(urls.some(u => u.includes('localhost'))).toBe(false);
  });

  it('cannot be made to fetch anything when the homepage itself is absent', () => {
    // Without a confirmed origin the README's links are worth nothing, however many there are.
    const urls = buildOfficialDocUrls({
      homepage: null,
      readmeText: 'Docs: https://attacker.example/docs and https://x.ai/docs'
    });
    expect(urls).toEqual([]);
  });

  it('caps the number of pages it will fetch', () => {
    const readmeText = Array.from({ length: 50 }, (_, i) => `https://x.ai/page-${i}`).join('\n');
    const urls = buildOfficialDocUrls({ homepage: 'https://x.ai/', readmeText });
    expect(urls.length).toBeLessThanOrEqual(OFFICIAL_DOCS_FETCH_CAP);
  });

  it('does not fetch the same page twice', () => {
    const urls = buildOfficialDocUrls({
      homepage: 'https://x.ai/',
      readmeText: 'https://x.ai/docs and https://x.ai/docs/ again'
    });
    const normalised = urls.map(u => u.replace(/\/$/, ''));
    expect(new Set(normalised).size).toBe(normalised.length);
  });

  it('strips trailing punctuation from a link in prose', () => {
    const urls = buildOfficialDocUrls({
      homepage: 'https://x.ai/',
      readmeText: 'Full reference at https://x.ai/build/reference.'
    });
    expect(urls).toContain('https://x.ai/build/reference');
  });
});

describe('fact class for official documentation', () => {
  const asEvidence = (type: string): Evidence =>
    ({ evidence_id: 'ev-1', type, url: 'https://x.ai/docs', title: 't', retrieved_at: '', content_hash: '', summary: '', claims: [] }) as unknown as Evidence;

  it('records official documentation as a creator claim, not a confirmed fact', () => {
    // Documentation stating that a tool runs locally is evidence that the claim exists, not
    // that the behaviour was observed. Promoting it would repeat, in the opposite direction,
    // the error this collection exists to prevent.
    expect(factClassForEvidence(asEvidence('official_docs'))).toBe('creator_claim');
  });

  it('agrees with the collector\'s own classification', () => {
    // The mapping lives in two places; a type missing from either silently becomes
    // 'unverified' and the evidence stops counting for anything.
    const collectorFactClass = (new EvidenceCollector() as any).factClassForEvidence.bind(
      new EvidenceCollector()
    );
    for (const type of [
      'api_metadata',
      'readme',
      'official_site',
      'official_docs',
      'additional_evidence',
      'source_discussion',
      'source_code',
      'test_file',
      'ci_workflow',
      'dependency_manifest'
    ]) {
      expect(collectorFactClass(type), `collector disagrees for ${type}`)
        .toBe(factClassForEvidence(asEvidence(type)));
    }
  });
});
