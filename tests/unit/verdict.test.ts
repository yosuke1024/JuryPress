import { describe, it, expect } from 'vitest';
import { formatScore, formatScoreRange, getConsensus, UNSCORED_DISPLAY } from '../../src/lib/verdict';

/**
 * The numeral slots an `evidence_limited` review lands in. Such a review publishes with
 * jury_score null, both ends of judge_score_range null, and every judge_score null — one
 * unassessable criterion nulls the whole score (methodology §5). The site rendered its first
 * one on 2026-08-29 ("AI 短劇編劇") and every score slot threw on `null.toFixed`.
 */
describe('Score display for an unscored review', () => {
  it('renders a real score unchanged', () => {
    expect(formatScore(81.8)).toBe('81.8');
    expect(formatScore(0)).toBe('0.0');
    expect(formatScoreRange({ min: 74, max: 90 })).toBe('74.0–90.0');
  });

  it('renders a dash rather than a zero when the jury reached no score', () => {
    // Zero is the harshest verdict the jury can reach. Printing it where the jury declined to
    // reach one states the opposite of what happened, so null must never fall back to 0.
    expect(formatScore(null)).toBe(UNSCORED_DISPLAY);
    expect(formatScore(undefined)).toBe(UNSCORED_DISPLAY);
    expect(formatScore(null)).not.toBe('0.0');
  });

  it('treats a half-null range as unscored rather than printing one end', () => {
    expect(formatScoreRange({ min: null, max: null })).toBe(UNSCORED_DISPLAY);
    expect(formatScoreRange({ min: 74, max: null })).toBe(UNSCORED_DISPLAY);
    expect(formatScoreRange({ min: null, max: 90 })).toBe(UNSCORED_DISPLAY);
  });

  it('keeps the consensus label consistent with the unscored range', () => {
    expect(getConsensus({ min: null, max: null }).label).toBe('No Consensus');
  });
});
