import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getAllReviews, loadEditorialWithdrawal } from '../../src/lib/data';
import { EditorialWithdrawalSchema } from '../../src/schemas/editorial-withdrawal';

/**
 * The integrity half of editorial withdrawal, kept OUT of the site build on purpose.
 *
 * At render time a stale withdrawal stays in force and the site publishes normally: one
 * out-of-date bookkeeping file must not be able to stop the daily publish that renders every
 * other review. The cost of that choice is that staleness would otherwise go unnoticed, so it
 * is caught here instead — in the CI that gates changes, not in the build that serves readers.
 *
 * Two layers:
 *   1. Always: the loader's contract, exercised against synthetic content roots. This is what
 *      runs in the public repo's CI, which has no access to the private content repository.
 *   2. When JURYPRESS_CONTENT_ROOT is set: every real withdrawal must be `active`. This is
 *      what content-repository workflows run.
 */

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('editorial withdrawal file contract', () => {
  it('accepts a well-formed record', () => {
    const parsed = EditorialWithdrawalSchema.safeParse({
      schema_version: '1.0.0',
      slug: 'some-review',
      article_hash: HASH_A,
      withdrawn_at: '2026-07-20T02:00:00.000Z',
      reason_code: 'material-evidence-gap',
      reason: 'Superseded evaluation pending.',
      superseded_by: null
    });
    expect(parsed.success).toBe(true);
  });

  it.each([
    ['a non-hex article_hash', { article_hash: 'not-a-hash' }],
    ['an unknown reason code', { reason_code: 'because-i-said-so' }],
    ['an empty reason', { reason: '' }],
    ['a non-ISO withdrawn_at', { withdrawn_at: 'yesterday' }]
  ])('rejects %s', (_label, overrides) => {
    const parsed = EditorialWithdrawalSchema.safeParse({
      schema_version: '1.0.0',
      slug: 'some-review',
      article_hash: HASH_A,
      withdrawn_at: '2026-07-20T02:00:00.000Z',
      reason_code: 'material-evidence-gap',
      reason: 'Superseded evaluation pending.',
      superseded_by: null,
      ...(overrides as Record<string, unknown>)
    });
    expect(parsed.success).toBe(false);
  });
});

describe('real content withdrawals', () => {
  const contentRoot = process.env.JURYPRESS_CONTENT_ROOT;

  it.skipIf(!contentRoot)('has no stale withdrawal in the content repository', () => {
    // A stale record still withdraws the review, so nothing is broken for readers — but the
    // article was republished after the withdrawal was written, and article_hash must be
    // refreshed against the new review.provenance.validated_content_hash.
    const originalMode = process.env.JURYPRESS_DATA_MODE;
    process.env.JURYPRESS_DATA_MODE = 'production';
    try {
      const stale = getAllReviews()
        .filter(entry => entry.editorialWithdrawal?.status === 'stale')
        .map(entry => entry.slug);
      expect(
        stale,
        `Stale editorial withdrawal(s): ${stale.join(', ')}. The review was republished after ` +
          'the withdrawal was written. Update article_hash in editorial-withdrawal.json to the ' +
          "review's current provenance.validated_content_hash."
      ).toEqual([]);
    } finally {
      process.env.JURYPRESS_DATA_MODE = originalMode;
    }
  });

  it.skipIf(!contentRoot)('resolves every superseded_by to a published review', () => {
    const originalMode = process.env.JURYPRESS_DATA_MODE;
    process.env.JURYPRESS_DATA_MODE = 'production';
    try {
      const entries = getAllReviews();
      const slugs = new Set(entries.map(e => e.slug));
      const dangling = entries
        .map(e => e.editorialWithdrawal?.record.superseded_by)
        .filter((s): s is string => Boolean(s) && !slugs.has(s as string));
      expect(dangling, `superseded_by points at unpublished review(s): ${dangling.join(', ')}`)
        .toEqual([]);
    } finally {
      process.env.JURYPRESS_DATA_MODE = originalMode;
    }
  });
});

describe('loader failure modes', () => {
  function seed(contents: string | Record<string, unknown>, slug = 'a-review') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-withdrawal-'));
    fs.writeFileSync(
      path.join(dir, 'editorial-withdrawal.json'),
      typeof contents === 'string' ? contents : JSON.stringify(contents)
    );
    return { dir, slug, review: { provenance: { validated_content_hash: HASH_A } } };
  }

  const valid = (overrides: Record<string, unknown> = {}, slug = 'a-review') => ({
    schema_version: '1.0.0',
    slug,
    article_hash: HASH_A,
    withdrawn_at: '2026-07-20T02:00:00.000Z',
    reason_code: 'material-evidence-gap',
    reason: 'Superseded evaluation pending.',
    superseded_by: null,
    ...overrides
  });

  it('returns null when no file is present', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-withdrawal-'));
    expect(loadEditorialWithdrawal(dir, { provenance: {} }, 'a-review')).toBeNull();
  });

  it('reports active when the article hash matches', () => {
    const { dir, slug, review } = seed(valid());
    expect(loadEditorialWithdrawal(dir, review, slug)?.status).toBe('active');
  });

  it('reports stale on a hash mismatch instead of throwing', () => {
    // Staleness must never reach the build as an exception: the review stays withdrawn and
    // the site keeps publishing. Only the dedicated content check above complains.
    const { dir, slug, review } = seed(valid({ article_hash: HASH_B }));
    const state = loadEditorialWithdrawal(dir, review, slug);
    expect(state?.status).toBe('stale');
    expect(state?.record.article_hash).toBe(HASH_B);
  });

  it('throws on unparseable JSON rather than silently un-withdrawing', () => {
    const { dir, slug, review } = seed('{ not json');
    expect(() => loadEditorialWithdrawal(dir, review, slug)).toThrow(/not valid JSON/);
  });

  it('throws when the record is filed under a different slug', () => {
    const { dir, review } = seed(valid({}, 'some-other-review'));
    expect(() => loadEditorialWithdrawal(dir, review, 'a-review')).toThrow(/declares slug/);
  });

  it('throws when the record does not match the schema', () => {
    const { dir, slug, review } = seed(valid({ reason_code: 'because-i-said-so' }));
    expect(() => loadEditorialWithdrawal(dir, review, slug)).toThrow(/does not match the schema/);
  });
});
