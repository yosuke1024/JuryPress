import { describe, it, expect } from 'vitest';
import {
  checkEligibilityGate,
  MAX_POPULARITY_STARS,
  OSS_LICENSE_ALLOWLIST
} from '../../src/lib/selection/eligibility';
import type { Candidate } from '../../src/schemas/selection';
import type { Evidence } from '../../src/schemas/evidence';

/**
 * The popularity ceiling and the licence allowlist, both exercised through the real gate.
 *
 * The gate is shared by autonomous selection and reader requests, so a rule proved here is
 * proved for both paths at once — that is the whole reason it lives in eligibility.ts rather
 * than in a source query.
 */

function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    source: 'github_oss',
    sourceId: '1',
    name: 'owner/repo',
    canonicalUrl: 'https://github.com/owner/repo',
    sourceUrl: 'https://github.com/owner/repo',
    sourceRank: 1,
    popularityValue: 1200,
    popularityUnit: 'stars',
    collectedAt: '2026-07-27T00:00:00.000Z',
    metadata: {},
    ...overrides
  } as Candidate;
}

/**
 * A candidate that clears every other check, so a failing gate names exactly one reason.
 * pushed_at is recent enough to stay inside the 18-month freshness window.
 */
function evidences(meta: Record<string, unknown> = {}): Evidence[] {
  const githubMeta = {
    description: 'A tool that does a thing.',
    license: { key: 'mit', spdx_id: 'MIT' },
    homepage: 'https://example.com',
    size: 4096,
    language: 'TypeScript',
    archived: false,
    fork: false,
    pushed_at: '2026-07-20T00:00:00.000Z',
    stargazers_count: 1200,
    ...meta
  };
  return [
    {
      type: 'api_metadata',
      url: 'https://api.github.com/repos/owner/repo',
      summary: JSON.stringify(githubMeta)
    },
    {
      type: 'readme',
      url: 'https://raw.githubusercontent.com/owner/repo/main/README.md',
      summary: 'Install with npm install. Usage and features are described here. '.repeat(4)
    }
  ] as unknown as Evidence[];
}

describe('popularity ceiling', () => {
  it('admits a project at the ceiling and rejects one above it', () => {
    expect(
      checkEligibilityGate(candidate(), evidences({ stargazers_count: MAX_POPULARITY_STARS }))
    ).not.toContain('above_popularity_ceiling');

    expect(
      checkEligibilityGate(candidate(), evidences({ stargazers_count: MAX_POPULARITY_STARS + 1 }))
    ).toContain('above_popularity_ceiling');
  });

  it('rejects the project that prompted the rule', () => {
    // react/react, 246,713 stars at selection time on 2026-07-25.
    const reasons = checkEligibilityGate(
      candidate({ name: 'react/react', popularityValue: 246713 }),
      evidences({ stargazers_count: 246713 })
    );
    expect(reasons).toContain('above_popularity_ceiling');
  });

  it('prefers the API snapshot over the figure the source listing carried', () => {
    // The listing is stale or, for a cross-source candidate, a blended score. The snapshot
    // fetched during collection is the number the ceiling must be applied to.
    const reasons = checkEligibilityGate(
      candidate({ popularityValue: 50 }),
      evidences({ stargazers_count: 400000 })
    );
    expect(reasons).toContain('above_popularity_ceiling');
  });

  it('does not exempt a candidate shaped like a reader request', () => {
    // The gate is source-agnostic by construction; this pins that it stays that way. It does
    // not prove the reader-request pipeline calls the gate — that wiring lives in
    // scripts/run-daily.ts and is not what this file covers.
    const reasons = checkEligibilityGate(
      candidate({ source: 'reader_request', sourceRank: 0, popularityValue: 246713 }),
      evidences({ stargazers_count: 246713 })
    );
    expect(reasons).toContain('above_popularity_ceiling');
  });

  it('fails closed when the metadata snapshot cannot be read', () => {
    // Unparseable api_metadata used to leave githubMeta null while hasMetadata stayed true,
    // which disabled the ceiling along with the archived/fork/licence/freshness checks. A
    // non-star popularity unit removes the fallback, so this is the exact hole: without the
    // unreadable-metadata reason, a 400k-star repository would be admitted with no reason.
    const broken = [
      { type: 'api_metadata', url: 'https://api.github.com/repos/owner/repo', summary: '{not json' },
      evidences()[1]
    ] as unknown as Evidence[];
    const reasons = checkEligibilityGate(
      candidate({ popularityUnit: 'points', popularityValue: 400000 }),
      broken
    );
    expect(reasons).toContain('insufficient_evidence');
    expect(reasons.length).toBeGreaterThan(0);
  });

  it('never compares a non-star popularity unit against a star threshold', () => {
    // Hacker News points and Hugging Face likes live on unrelated scales. With no GitHub
    // metadata to fall back on, the ceiling must simply not apply.
    const noMeta = [evidences()[1]] as Evidence[];
    for (const unit of ['points', 'likes', 'combined points/stars']) {
      const reasons = checkEligibilityGate(
        candidate({ popularityUnit: unit, popularityValue: 999999 }),
        noMeta
      );
      expect(reasons).not.toContain('above_popularity_ceiling');
    }
  });

  it('falls back to the candidate figure when it is stars and no snapshot exists', () => {
    const noMeta = [evidences()[1]] as Evidence[];
    const reasons = checkEligibilityGate(
      candidate({ popularityUnit: 'stars', popularityValue: 246713 }),
      noMeta
    );
    expect(reasons).toContain('above_popularity_ceiling');
  });
});

describe('open source licence allowlist', () => {
  /**
   * GitHub's licences API returns the disjunctive SPDX id — `agpl-3.0`, never
   * `agpl-3.0-only`. Accepting only the explicit forms rejected every GPL-family project;
   * juggler-ai/juggler (AGPL-3.0) is the production rejection that exposed it.
   */
  it.each([
    ['gpl-2.0', 'GPL-2.0'],
    ['gpl-3.0', 'GPL-3.0'],
    ['lgpl-2.1', 'LGPL-2.1'],
    ['lgpl-3.0', 'LGPL-3.0'],
    ['agpl-3.0', 'AGPL-3.0']
  ])('accepts the disjunctive id GitHub actually returns: %s', (key, spdxId) => {
    const reasons = checkEligibilityGate(
      candidate(),
      evidences({ license: { key, spdx_id: spdxId } })
    );
    expect(reasons).not.toContain('unsupported_license');
  });

  it('still accepts the explicit -only and -or-later forms', () => {
    for (const key of ['gpl-3.0-only', 'gpl-3.0-or-later', 'agpl-3.0-or-later']) {
      expect(OSS_LICENSE_ALLOWLIST).toContain(key);
    }
  });

  it('still rejects licences that are not open source software licences', () => {
    for (const [key, spdxId] of [
      ['cc-by-4.0', 'CC-BY-4.0'],
      ['cc0-1.0', 'CC0-1.0'],
      ['odbl-1.0', 'ODbL-1.0'],
      ['other', 'NOASSERTION']
    ]) {
      const reasons = checkEligibilityGate(
        candidate(),
        evidences({ license: { key, spdx_id: spdxId } })
      );
      expect(reasons).toContain('unsupported_license');
    }
  });
});
