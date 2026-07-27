import { describe, it, expect, vi } from 'vitest';
import {
  checkEligibilityGate,
  NON_PRODUCT_TOPICS,
  NAME_EXCLUSIONS
} from '../../src/lib/selection/eligibility';
import { EvidenceCollector } from '../../src/lib/evidence/collector';
import type { Candidate } from '../../src/schemas/selection';
import type { Evidence } from '../../src/schemas/evidence';

/**
 * Telling a software product apart from a collection of material.
 *
 * The signal is the maintainer-declared topic list, matched exactly. It replaces substring
 * matching on `owner/repo`, which was measured to be inverted: it rejected 9 of 12 real
 * products and admitted 9 of 10 genuine collections. Every case below uses the topics those
 * repositories actually carry on GitHub.
 */

function candidate(name: string): Candidate {
  return {
    source: 'github_oss',
    sourceId: '1',
    name,
    canonicalUrl: `https://github.com/${name}`,
    sourceUrl: `https://github.com/${name}`,
    sourceRank: 1,
    popularityValue: 5000,
    popularityUnit: 'stars',
    collectedAt: '2026-07-27T00:00:00.000Z',
    metadata: {}
  } as Candidate;
}

/** Shaped like the collector's api_metadata summary, which is what the gate parses. */
function evidences(topics: string[]): Evidence[] {
  return [
    {
      type: 'api_metadata',
      url: 'https://api.github.com/repos/owner/repo',
      summary: JSON.stringify({
        stargazers_count: 5000,
        license_spdx: 'MIT',
        pushed_at: '2026-07-20T00:00:00.000Z',
        topics
      })
    },
    {
      type: 'readme',
      url: 'https://raw.githubusercontent.com/owner/repo/main/README.md',
      summary: 'Install with npm install. Usage and features are described here. '.repeat(4)
    }
  ] as unknown as Evidence[];
}

const rejected = (name: string, topics: string[]) =>
  checkEligibilityGate(candidate(name), evidences(topics)).includes('not_software_product');

describe('material collections are not software products', () => {
  it.each([
    ['sindresorhus/awesome', ['awesome', 'awesome-list', 'lists', 'resources', 'unicorns']],
    ['vinta/awesome-python', ['awesome', 'collections', 'python', 'python-frameworks']],
    ['donnemartin/system-design-primer', ['design', 'development', 'interview', 'interview-practice']],
    ['jwasham/coding-interview-university', ['algorithm', 'coding-interview', 'data-structures']],
    ['getify/You-Dont-Know-JS', ['async', 'book', 'book-series', 'closures', 'education']],
    ['ossu/computer-science', ['awesome-list', 'computer-science', 'courses', 'curriculum']]
  ])('rejects %s on its declared topics', (name, topics) => {
    expect(rejected(name, topics)).toBe(true);
  });

  it.each([
    ['public-apis/public-apis', ['api', 'apis', 'dataset', 'development', 'free', 'list']],
    ['TheAlgorithms/Python', ['algorithm', 'algos', 'community-driven', 'education']],
    ['EbookFoundation/free-programming-books', ['books', 'education', 'list', 'resource']]
  ])('is known to miss %s, whose only signal is an ambiguous topic', (name, topics) => {
    // Pinned deliberately, not aspirationally. Catching these needs `list`, `education` or
    // `books`, each of which a real product declares. Publishing one weak review costs less
    // than silently removing a real project, and a weak review can still be withdrawn.
    expect(rejected(name, topics)).toBe(false);
  });
});

describe('real products whose names the old substring rule caught', () => {
  /**
   * Each of these was rejected as not_software_product before topics replaced the bare
   * keywords: `book` is inside `facebook`, `learn` inside `scikit-learn`, `course` inside
   * `concourse`, `guide` inside `styleguide`.
   */
  it.each([
    ['facebook/react', ['declarative', 'frontend', 'javascript', 'library', 'ui']],
    ['facebook/rocksdb', ['database', 'storage-engine']],
    ['scikit-learn/scikit-learn', ['data-science', 'machine-learning', 'python', 'statistics']],
    ['deeplearning4j/deeplearning4j', ['deeplearning', 'java', 'neural-nets']],
    ['concourse/concourse', ['ci', 'ci-cd', 'containers', 'continuous-delivery']],
    ['google/styleguide', ['styleguide', 'style-guide']],
    ['bookstackapp/bookstack', ['php', 'wiki', 'documentation']]
  ])('admits %s', (name, topics) => {
    expect(rejected(name, topics)).toBe(false);
  });
});

describe('topic matching is exact', () => {
  it('does not treat a topic that merely contains a listed word as a match', () => {
    // The failure mode the whole change exists to prevent: `machine-learning` is not
    // `learning`, `notebook` is not `book`, `coursera-clone` is not `courses`.
    expect(rejected('o/r', ['machine-learning'])).toBe(false);
    expect(rejected('o/r', ['notebook'])).toBe(false);
    expect(rejected('o/r', ['bookkeeping'])).toBe(false);
    expect(rejected('o/r', ['roadmapper'])).toBe(false);
  });

  it('matches regardless of the case the maintainer typed', () => {
    expect(rejected('o/r', ['Awesome-List'])).toBe(true);
  });

  it('is unaffected by a repository with no topics at all', () => {
    expect(rejected('o/r', [])).toBe(false);
  });
});

describe('surviving name fragments', () => {
  it('keeps only compounds that cannot occur inside a real product name', () => {
    // Every measured false positive came from a bare word. None may return.
    for (const bare of ['tutorial', 'course', 'book', 'guide', 'learn']) {
      expect(NAME_EXCLUSIONS).not.toContain(bare);
    }
    expect(NAME_EXCLUSIONS).toContain('tutorial-copy');
    expect(NAME_EXCLUSIONS).toContain('job opening');
  });

  it('still rejects a recruiting post by name', () => {
    expect(rejected('acme/we-are-hiring', [])).toBe(true);
  });
});

describe('topic list hygiene', () => {
  it('holds only lowercase entries, since matching lowercases the topic', () => {
    for (const topic of NON_PRODUCT_TOPICS) {
      expect(topic).toBe(topic.toLowerCase());
    }
  });

  it('excludes topics that name a domain a real product can serve', () => {
    // Each of these is declared by a real software product: `roadmap` by opf/openproject,
    // `ebooks` by Librum-Reader/Librum, `book`/`books` by library managers, `tutorial` by
    // tutorial-authoring tools, `interview` by interview-scheduling software. Admitting any
    // of them would reintroduce the false positives this change exists to remove.
    for (const ambiguous of [
      'roadmap', 'ebook', 'ebooks', 'book', 'books',
      'tutorial', 'tutorials', 'interview', 'courses', 'cheatsheet', 'education'
    ]) {
      expect(NON_PRODUCT_TOPICS.has(ambiguous)).toBe(false);
    }
  });
});

describe('the collector actually supplies the topics the gate reads', () => {
  /**
   * Without this the feature can be disabled in production while every other test above
   * stays green: they hand the gate a hand-written summary, so deleting the collector's
   * forwarding would break nothing. This drives the real collector and feeds its real
   * output into the real gate.
   */
  it('carries topics from the GitHub API through to a gate rejection', async () => {
    const collector = new EvidenceCollector();
    (collector as any).safeFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('api.github.com/repos/')) {
        if (url.includes('/contents/') || url.includes('/releases') || url.includes('/commits')) {
          return Promise.resolve(JSON.stringify([]));
        }
        return Promise.resolve(JSON.stringify({
          stargazers_count: 100,
          forks_count: 10,
          license: { spdx_id: 'MIT' },
          created_at: '2026-01-01',
          updated_at: '2026-07-01',
          pushed_at: '2026-07-14',
          default_branch: 'main',
          topics: ['awesome', 'awesome-list', 'resources']
        }));
      }
      return Promise.resolve('<html><body>Install and usage instructions. License MIT.</body></html>');
    });

    const c = candidate('user/repo');
    const collected = await collector.collect({ ...c, canonicalUrl: 'https://github.com/user/repo', sourceUrl: 'https://github.com/user/repo' } as any);

    const apiEvidence = collected.find(e => e.type === 'api_metadata');
    expect(apiEvidence, 'collector produced no api_metadata evidence').toBeDefined();
    expect(JSON.parse(apiEvidence!.summary).topics).toEqual(['awesome', 'awesome-list', 'resources']);

    expect(checkEligibilityGate(c, collected)).toContain('not_software_product');
  });
});
