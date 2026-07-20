import { describe, it, expect } from 'vitest';
import {
  CURRENT_COHORT,
  getRankingEligibility,
  getRankedReviews,
  isHistoricalMethodology,
  isEditoriallyWithdrawn,
  findSupersededReview
} from '../../src/lib/ranking-eligibility';
import type { EditorialWithdrawal } from '../../src/schemas/editorial-withdrawal';
import { validateProjectUniqueness } from '../../src/lib/data';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function withdrawal(overrides: Partial<EditorialWithdrawal> = {}): EditorialWithdrawal {
  return {
    schema_version: '1.0.0',
    slug: 'withdrawn',
    article_hash: HASH_A,
    withdrawn_at: '2026-07-20T02:00:00.000Z',
    reason_code: 'material-evidence-gap',
    reason: 'Superseded evaluation pending after material evidence gaps were identified.',
    superseded_by: null,
    ...overrides
  };
}

interface EntryOptions {
  withdrawalState?: 'active' | 'stale' | null;
  withdrawalRecord?: EditorialWithdrawal;
  evidenceMapStatus?: 'complete' | 'partial';
  relationship?: string;
}

function makeEntry(slug: string, options: EntryOptions = {}): any {
  const state = options.withdrawalState ?? null;
  return {
    slug,
    review: {
      slug,
      schema_version: '3.0.0',
      season: CURRENT_COHORT.season,
      rubric_id: CURRENT_COHORT.rubricId,
      rubric_version: CURRENT_COHORT.rubricVersion,
      evaluation_status: 'complete',
      ranking_eligible: true,
      relationship: options.relationship ?? 'independent',
      jury_score: 80,
      evidence_map_status: options.evidenceMapStatus ?? 'complete',
      provenance: { validated_content_hash: HASH_A }
    },
    selection: {},
    evidence: [],
    evidenceMap: { claims: [] },
    editorialWithdrawal: state
      ? { status: state, record: options.withdrawalRecord ?? withdrawal({ slug }) }
      : null
  };
}

describe('editorial withdrawal and ranking eligibility', () => {
  it('leaves reviews without a withdrawal completely unaffected', () => {
    expect(getRankingEligibility(makeEntry('normal')))
      .toEqual({ eligible: true, reason: null });
  });

  it('excludes a withdrawn review even though its base eligibility is still true', () => {
    // The review is independent, complete and ranking_eligible: true — the schema requires
    // all three. Withdrawal has to work without contradicting any of them.
    const entry = makeEntry('withdrawn', { withdrawalState: 'active' });
    expect(entry.review.ranking_eligible).toBe(true);
    expect(getRankingEligibility(entry))
      .toEqual({ eligible: false, reason: 'editorially-withdrawn' });
  });

  it('keeps a stale withdrawal in force', () => {
    // A hash mismatch means the article was republished after the withdrawal was written.
    // Treating that as "no longer withdrawn" would restore a ranking nobody re-approved.
    const entry = makeEntry('withdrawn', { withdrawalState: 'stale' });
    expect(getRankingEligibility(entry).reason).toBe('editorially-withdrawn');
    expect(isEditoriallyWithdrawn(entry)).toBe(true);
  });

  it('reports withdrawal rather than the mapping reason when both would apply', () => {
    const entry = makeEntry('both', { withdrawalState: 'active', evidenceMapStatus: 'partial' });
    expect(getRankingEligibility(entry).reason).toBe('editorially-withdrawn');
  });

  it('does not classify a withdrawal as historical methodology', () => {
    // Different things: one is a judgement about this review, the other about the method that
    // produced it. Conflating them would misstate why the review is unranked.
    const entry = makeEntry('withdrawn', { withdrawalState: 'active' });
    expect(isHistoricalMethodology(entry)).toBe(false);
  });

  it('removes a withdrawn review from the ranked population', () => {
    const entries = [makeEntry('ranked'), makeEntry('withdrawn', { withdrawalState: 'active' })];
    expect(getRankedReviews(entries).map(e => e.slug)).toEqual(['ranked']);
  });

  it('derives the successor link from the withdrawal alone', () => {
    const old = makeEntry('old', {
      withdrawalState: 'active',
      withdrawalRecord: withdrawal({ slug: 'old', superseded_by: 'new' })
    });
    const fresh = makeEntry('new');
    expect(findSupersededReview([old, fresh], 'new')?.slug).toBe('old');
    expect(findSupersededReview([old, fresh], 'old')).toBeNull();
  });

  it('exposes a distinct reason from every other exclusion', () => {
    const reasons = new Set([
      getRankingEligibility(makeEntry('w', { withdrawalState: 'active' })).reason,
      getRankingEligibility(makeEntry('h', { evidenceMapStatus: 'partial' })).reason,
      getRankingEligibility(makeEntry('c', { relationship: 'related-party' })).reason
    ]);
    expect(reasons).toEqual(
      new Set(['editorially-withdrawn', 'evidence-map-partial', 'outside-current-cohort'])
    );
  });

  it('distinguishes a stale hash from a matching one', () => {
    const stale = withdrawal({ article_hash: HASH_B });
    expect(stale.article_hash).not.toBe(HASH_A);
  });
});

describe('one current review per project', () => {
  const project = (slug: string, withdrawn: boolean, url = 'https://github.com/owner/repo'): any => ({
    slug,
    // Distinct per review, so these cases isolate the canonical-URL rule.
    selection: { source_id: `id-${slug}`, canonical_url: url },
    editorialWithdrawal: withdrawn ? { status: 'active', record: withdrawal({ slug }) } : null
  });

  it('accepts a successor published beside a withdrawn review', () => {
    // The case this rule exists for: a review is withdrawn, re-evaluated against a wider
    // evidence base, and the replacement covers the same repository.
    expect(() => validateProjectUniqueness([project('old', true), project('new', false)]))
      .not.toThrow();
  });

  it('still rejects a project reviewed twice by accident', () => {
    expect(() => validateProjectUniqueness([project('a', false), project('b', false)]))
      .toThrow(/canonical URL/);
  });

  it('names the live reviews in the error so the duplicate is findable', () => {
    expect(() => validateProjectUniqueness([project('a', false), project('b', false)]))
      .toThrow(/a, b/);
  });

  it('allows every review of a project to be withdrawn', () => {
    // Nothing requires a replacement to exist; a project may end up with no current review.
    expect(() => validateProjectUniqueness([project('a', true), project('b', true)]))
      .not.toThrow();
  });

  it('leaves distinct projects alone', () => {
    expect(() =>
      validateProjectUniqueness([
        project('a', false, 'https://github.com/owner/one'),
        project('b', false, 'https://github.com/owner/two')
      ])
    ).not.toThrow();
  });

  it('applies the same rule to content ids', () => {
    const a = project('a', false, 'https://github.com/owner/one');
    const b = project('b', false, 'https://github.com/owner/two');
    b.selection.source_id = a.selection.source_id;   // same project, different URLs recorded
    expect(() => validateProjectUniqueness([a, b])).toThrow(/content ID/);
  });
});
