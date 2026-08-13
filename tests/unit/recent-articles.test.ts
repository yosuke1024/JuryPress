import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildRecentArticleBlock,
  readRecentArticleOpenings,
  readRecentReviewIntensity,
  RECENT_ARTICLE_COUNT
} from '../../src/lib/evaluation/recent-articles';

/**
 * The observed drift, two consecutive reviews apart:
 *
 *   "A brilliant visual permission matrix wrapped in a fragile, single-file frontend."
 *   "A brilliant terminal interface chained to a closed corporate monorepo."
 */

function seed(root: string, reviews: Array<{ slug: string; publishedAt: string; article: unknown; judges?: unknown }>) {
  for (const review of reviews) {
    const dir = path.join(root, 'reviews', review.publishedAt.slice(0, 4), '07', review.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'review.json'),
      JSON.stringify({
        slug: review.slug,
        published_at: review.publishedAt,
        evaluation: { article: review.article, judges: review.judges ?? [] }
      })
    );
  }
}

function withRoot<T>(fn: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-recent-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('readRecentArticleOpenings', () => {
  it('returns the newest reviews first', () => {
    withRoot(root => {
      seed(root, [
        { slug: 'older', publishedAt: '2026-07-14T10:00:00Z', article: { headline: 'Older headline' } },
        { slug: 'newest', publishedAt: '2026-07-19T10:00:00Z', article: { headline: 'Newest headline' } },
        { slug: 'middle', publishedAt: '2026-07-16T10:00:00Z', article: { headline: 'Middle headline' } }
      ]);
      expect(readRecentArticleOpenings(root).map(o => o.headline))
        .toEqual(['Newest headline', 'Middle headline', 'Older headline']);
    });
  });

  it('takes only the configured number of reviews', () => {
    withRoot(root => {
      seed(
        root,
        Array.from({ length: 8 }, (_, i) => ({
          slug: `review-${i}`,
          publishedAt: `2026-07-${String(10 + i).padStart(2, '0')}T10:00:00Z`,
          article: { headline: `Headline ${i}` }
        }))
      );
      expect(readRecentArticleOpenings(root)).toHaveLength(RECENT_ARTICLE_COUNT);
    });
  });

  it('takes the first sentence of the standfirst and verdict, not the whole field', () => {
    withRoot(root => {
      seed(root, [
        {
          slug: 'one',
          publishedAt: '2026-07-19T10:00:00Z',
          article: {
            headline: 'A headline',
            standfirst: 'First sentence here. Second sentence should not appear.',
            final_verdict: 'Adopt this if you live in a terminal. Everything after is detail.'
          }
        }
      ]);
      const [opening] = readRecentArticleOpenings(root);
      expect(opening.standfirstOpening).toBe('First sentence here.');
      expect(opening.verdictOpening).toBe('Adopt this if you live in a terminal.');
    });
  });

  it('skips a review with no headline rather than emitting a blank entry', () => {
    withRoot(root => {
      seed(root, [
        { slug: 'blank', publishedAt: '2026-07-19T10:00:00Z', article: { headline: '   ' } },
        { slug: 'real', publishedAt: '2026-07-18T10:00:00Z', article: { headline: 'A real headline' } }
      ]);
      expect(readRecentArticleOpenings(root).map(o => o.headline)).toEqual(['A real headline']);
    });
  });

  it('survives an unreadable review without losing the others', () => {
    withRoot(root => {
      seed(root, [{ slug: 'good', publishedAt: '2026-07-19T10:00:00Z', article: { headline: 'Good' } }]);
      const badDir = path.join(root, 'reviews', '2026', '07', 'bad');
      fs.mkdirSync(badDir, { recursive: true });
      fs.writeFileSync(path.join(badDir, 'review.json'), '{ not json');
      expect(readRecentArticleOpenings(root).map(o => o.headline)).toEqual(['Good']);
    });
  });

  it('returns nothing when the archive is missing, rather than throwing', () => {
    // Nothing depends on this block, so generation must never fail because of it.
    expect(readRecentArticleOpenings('/nonexistent/path/for/test')).toEqual([]);
  });

  it('carries the marked intensity words that review spent, issue #109', () => {
    withRoot(root => {
      seed(root, [
        {
          slug: 'spent',
          publishedAt: '2026-08-09T10:00:00Z',
          article: { headline: 'A headline with nothing marked in it' },
          judges: [{ judge_id: 'marcus', criteria: [{ reasoning: 'This is a masterclass in exploiting hardware characteristics for AI inference.' }] }]
        },
        { slug: 'quiet', publishedAt: '2026-08-08T10:00:00Z', article: { headline: 'A perfectly ordinary headline' } }
      ]);
      const [spent, quiet] = readRecentArticleOpenings(root);
      expect(spent.intensityWords).toEqual(['masterclass']);
      expect(quiet.intensityWords).toEqual([]);
    });
  });
});

describe('readRecentReviewIntensity', () => {
  function seedIntensity(root: string, reviews: Array<{ slug: string; publishedAt: string; word: string }>) {
    seed(root, reviews.map(review => ({
      slug: review.slug,
      publishedAt: review.publishedAt,
      article: { headline: `${review.slug} headline` },
      judges: [{ judge_id: 'marcus', strengths: [`This sentence is an absolute ${review.word} of engineering, full stop.`] }]
    })));
  }

  it('reads the newest reviews first, each with its own marked words', () => {
    withRoot(root => {
      seedIntensity(root, [
        { slug: 'older', publishedAt: '2026-08-05T10:00:00Z', word: 'masterclass' },
        { slug: 'newest', publishedAt: '2026-08-10T10:00:00Z', word: 'triumph' }
      ]);
      const entries = readRecentReviewIntensity(root);
      expect(entries.map(e => e.slug)).toEqual(['newest', 'older']);
      expect(entries[0].words).toEqual(['triumph']);
      expect(entries[1].words).toEqual(['masterclass']);
    });
  });

  it('excludes the record being revalidated, so it never self-matches', () => {
    withRoot(root => {
      seedIntensity(root, [
        { slug: 'self', publishedAt: '2026-08-10T10:00:00Z', word: 'masterclass' },
        { slug: 'other', publishedAt: '2026-08-09T10:00:00Z', word: 'triumph' }
      ]);
      const entries = readRecentReviewIntensity(root, { excludeSlug: 'self' });
      expect(entries.map(e => e.slug)).toEqual(['other']);
    });
  });

  it('respects a custom limit and defaults to RECENT_ARTICLE_COUNT', () => {
    withRoot(root => {
      seedIntensity(
        root,
        Array.from({ length: 5 }, (_, i) => ({
          slug: `review-${i}`,
          publishedAt: `2026-08-${String(10 + i).padStart(2, '0')}T10:00:00Z`,
          word: 'masterclass'
        }))
      );
      expect(readRecentReviewIntensity(root)).toHaveLength(RECENT_ARTICLE_COUNT);
      expect(readRecentReviewIntensity(root, { limit: 2 })).toHaveLength(2);
    });
  });

  it('returns nothing when the archive is missing, rather than throwing', () => {
    expect(readRecentReviewIntensity('/nonexistent/path/for/test')).toEqual([]);
  });
});

describe('buildRecentArticleBlock', () => {
  it('emits nothing at all when there are no previous reviews', () => {
    // The first review of a season gets no empty heading.
    expect(buildRecentArticleBlock([])).toBe('');
  });

  it('lists the openings and forbids reusing their structure', () => {
    const block = buildRecentArticleBlock([
      {
        headline: 'A brilliant visual permission matrix wrapped in a fragile, single-file frontend.',
        standfirstOpening: 'A small tool with a clear view.',
        verdictOpening: 'Adopt this if you already live in a terminal.',
        intensityWords: []
      }
    ]);
    expect(block).toContain('A brilliant visual permission matrix');
    expect(block).toContain('Do not reuse their syntax, contrast pattern, opening phrase, or rhetorical structure.');
    // Must be unmistakably contrast material, or the writer treats it as evidence.
    expect(block).toContain('They say nothing about the project you are reviewing');
  });

  it('omits standfirst and verdict lines when they are empty', () => {
    const block = buildRecentArticleBlock([
      { headline: 'Only a headline', standfirstOpening: '', verdictOpening: '', intensityWords: [] }
    ]);
    expect(block).toContain('Only a headline');
    expect(block).not.toContain('Standfirst opened:');
    expect(block).not.toContain('Verdict opened:');
  });

  it('lists intensity words spent, per opening, and states the convention only over a real list (#109)', () => {
    const withWords = buildRecentArticleBlock([
      { headline: 'A headline', standfirstOpening: '', verdictOpening: '', intensityWords: ['masterclass', 'brilliant'] }
    ]);
    expect(withWords).toContain('Intensity spent: masterclass, brilliant');
    expect(withWords).toContain('Two different projects cannot both be a masterclass in the same week');

    const withoutWords = buildRecentArticleBlock([
      { headline: 'A headline', standfirstOpening: '', verdictOpening: '', intensityWords: [] }
    ]);
    // No words to point at means no "Intensity spent" lines AND no closing paragraph about
    // them: a rule about "the intensity words listed above" over a list that names none is
    // boilerplate, and boilerplate teaches the writer to skim the section.
    expect(withoutWords).not.toContain('Intensity spent:');
    expect(withoutWords).not.toContain('Two different projects cannot both be a masterclass in the same week');
  });
});
