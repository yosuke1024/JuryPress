import { describe, it, expect } from 'vitest';
import {
  unassessableCriteria,
  hasUnassessableCriteria,
  evidenceContextOf,
  technicalQualityConfidenceCeiling,
  capConfidence,
  TECHNICAL_QUALITY
} from '../../src/lib/evaluation/evidence-requirements';
import { getRankingEligibility, CURRENT_COHORT } from '../../src/lib/ranking-eligibility';

/**
 * The invariant, from the Grok Build review that scored technical quality at high confidence
 * with zero source-code evidence: with no source evidence, technical quality cannot be scored,
 * whatever the model reports.
 */

describe('unassessableCriteria', () => {
  it('marks technical quality unassessable when no source evidence was collected', () => {
    expect(unassessableCriteria({ coreSourceCount: 0 }).map(c => c.criterionId))
      .toEqual([TECHNICAL_QUALITY]);
  });

  it('assesses technical quality once at least one source file is present', () => {
    expect(unassessableCriteria({ coreSourceCount: 1 })).toEqual([]);
    expect(hasUnassessableCriteria({ coreSourceCount: 3 })).toBe(false);
  });

  it('treats a negative or missing count as zero', () => {
    expect(hasUnassessableCriteria({ coreSourceCount: -1 })).toBe(true);
    expect(evidenceContextOf({}).coreSourceCount).toBe(0);
    expect(evidenceContextOf({ core_source_evidence: { source_count: 4 } }).coreSourceCount).toBe(4);
  });
});

describe('retroactive ranking exclusion', () => {
  const entry = (sourceCount: number): any => ({
    slug: 's',
    review: {
      season: CURRENT_COHORT.season,
      rubric_id: CURRENT_COHORT.rubricId,
      rubric_version: CURRENT_COHORT.rubricVersion,
      evaluation_status: 'complete',
      ranking_eligible: true,
      relationship: 'independent',
      jury_score: 78.4, // a real, non-null score — this review passed the cohort check
      evidence_map_status: 'complete',
      evaluation: { core_source_evidence: { source_count: sourceCount } }
    },
    evidenceMap: { claims: [] },
    editorialWithdrawal: null
  });

  it('removes a review scored without source evidence, keeping its score intact', () => {
    // The score is immutable and stays on the page; only the ranking eligibility changes.
    const result = getRankingEligibility(entry(0));
    expect(result).toEqual({ eligible: false, reason: 'insufficient-evidence' });
    expect(entry(0).review.jury_score).toBe(78.4);
  });

  it('ranks a review that does have source evidence', () => {
    expect(getRankingEligibility(entry(2))).toEqual({ eligible: true, reason: null });
  });

  it('leaves an unmapped review as historical methodology, not insufficient-evidence', () => {
    // Regression: refined reviews of more than one schema version carry core_source_evidence,
    // so an evidence-sufficiency check ahead of the mapping check would relabel every unmapped
    // refined review 'insufficient-evidence' and drop it off the Methodology History page.
    // Mapping is judged first; only a complete-map review reaches the evidence check.
    const unmapped: any = {
      slug: 's',
      review: {
        season: CURRENT_COHORT.season,
        rubric_id: CURRENT_COHORT.rubricId,
        rubric_version: CURRENT_COHORT.rubricVersion,
        evaluation_status: 'complete',
        ranking_eligible: true,
        relationship: 'independent',
        jury_score: 88.3,
        // No evidence_map_status field: predates statement-level mapping (a 2.1.0 refined
        // review), yet still records core_source_evidence with source_count 0.
        evaluation: { core_source_evidence: { source_count: 0 } }
      },
      evidenceMap: null,
      editorialWithdrawal: null
    };
    expect(getRankingEligibility(unmapped).reason).toBe('evidence-map-unavailable');
  });
});

describe('technical quality confidence ceiling (coverage calibration)', () => {
  it('caps at medium when the collected source is a thin sample of a large codebase', () => {
    // moonshine: 1 source file of 59. A high-confidence claim about the architecture would
    // rest on files never read.
    expect(technicalQualityConfidenceCeiling({ coreSourceCount: 1, totalSourceCount: 59 })).toBe('medium');
  });

  it('does not cap when the collected source essentially covers the codebase', () => {
    // minio-dash: 1 source file of 1 — the collected file IS the whole implementation.
    expect(technicalQualityConfidenceCeiling({ coreSourceCount: 1, totalSourceCount: 1 })).toBeNull();
    expect(technicalQualityConfidenceCeiling({ coreSourceCount: 3, totalSourceCount: 4 })).toBeNull();
  });

  it('does not cap when coverage is unknown (tree unavailable) — fail open', () => {
    expect(technicalQualityConfidenceCeiling({ coreSourceCount: 1 })).toBeNull();
    expect(technicalQualityConfidenceCeiling({ coreSourceCount: 1, totalSourceCount: 0 })).toBeNull();
  });

  it('leaves the no-source case to the Not Assessable rule, not the ceiling', () => {
    expect(technicalQualityConfidenceCeiling({ coreSourceCount: 0, totalSourceCount: 59 })).toBeNull();
  });
});

describe('capConfidence', () => {
  it('lowers a confidence above the ceiling and leaves one at or below it', () => {
    expect(capConfidence('high', 'medium')).toBe('medium');
    expect(capConfidence('medium', 'medium')).toBe('medium');
    expect(capConfidence('low', 'medium')).toBe('low');
  });

  it('never raises confidence', () => {
    expect(capConfidence('low', 'high')).toBe('low');
  });

  it('leaves an unrecognised confidence string untouched rather than raising it', () => {
    expect(capConfidence('bogus', 'medium')).toBe('bogus');
  });
});
