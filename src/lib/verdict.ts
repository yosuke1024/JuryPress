export interface JudgeRange {
  min: number | null | undefined;
  max: number | null | undefined;
}

export interface ConsensusInfo {
  label: string;
  className: string;
}

/**
 * What a numeral slot shows when there is no score to show.
 *
 * An `evidence_limited` review publishes with jury_score null, judge_score_range null on both
 * ends, and every judge_score null — methodology §5: one unassessable criterion nulls the
 * whole score. That is a documented editorial state, not missing data, so the numeral renders
 * an em dash. It must never fall back to 0: zero is the jury's harshest verdict, and printing
 * it where the jury declined to reach one states the opposite of what happened.
 */
export const UNSCORED_DISPLAY = '—';

/** A score for a numeral slot, or the unscored placeholder when the jury did not reach one. */
export function formatScore(score: number | null | undefined): string {
  return typeof score === 'number' ? score.toFixed(1) : UNSCORED_DISPLAY;
}

/** A judge-score range for a numeral slot. Unscored unless BOTH ends are real scores. */
export function formatScoreRange(judgeRange: JudgeRange): string {
  if (typeof judgeRange.min !== 'number' || typeof judgeRange.max !== 'number') {
    return UNSCORED_DISPLAY;
  }
  return `${judgeRange.min.toFixed(1)}–${judgeRange.max.toFixed(1)}`;
}

export function getConsensus(judgeRange: JudgeRange): ConsensusInfo {
  if (judgeRange.min === null || judgeRange.min === undefined || judgeRange.max === null || judgeRange.max === undefined) {
    return { label: 'No Consensus', className: 'consensus-none' };
  }
  const diff = judgeRange.max - judgeRange.min;
  if (diff <= 5.0) {
    return { label: 'Strong Consensus', className: 'consensus-strong' };
  } else if (diff <= 12.0) {
    return { label: 'General Agreement', className: 'consensus-general' };
  } else if (diff <= 20.0) {
    return { label: 'Split Decision', className: 'consensus-split' };
  } else {
    return { label: 'Highly Divisive', className: 'consensus-divisive' };
  }
}
