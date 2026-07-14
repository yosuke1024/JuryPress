export interface JudgeRange {
  min: number;
  max: number;
}

export interface ConsensusInfo {
  label: string;
  className: string;
}

export function getConsensus(judgeRange: JudgeRange): ConsensusInfo {
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
