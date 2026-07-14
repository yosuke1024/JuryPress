import { describe, it, expect } from 'vitest';

function getConsensusLabel(min: number, max: number): string {
  const diff = max - min;
  if (diff <= 5.0) return 'Strong Consensus';
  if (diff <= 12.0) return 'General Agreement';
  if (diff <= 20.0) return 'Split Decision';
  return 'Highly Divisive';
}

describe('Consensus Label Calculation', () => {
  it('should correctly classify consensus level based on judge score range', () => {
    // 0.0 - 5.0 -> Strong Consensus
    expect(getConsensusLabel(80.0, 83.5)).toBe('Strong Consensus');
    expect(getConsensusLabel(80.0, 85.0)).toBe('Strong Consensus');

    // 5.1 - 12.0 -> General Agreement
    expect(getConsensusLabel(74.0, 81.8)).toBe('General Agreement'); // diff = 7.8
    expect(getConsensusLabel(74.0, 86.0)).toBe('General Agreement'); // diff = 12.0

    // 12.1 - 20.0 -> Split Decision
    expect(getConsensusLabel(76.0, 89.2)).toBe('Split Decision'); // diff = 13.2
    expect(getConsensusLabel(70.0, 90.0)).toBe('Split Decision'); // diff = 20.0

    // 20.1+ -> Highly Divisive
    expect(getConsensusLabel(60.0, 81.0)).toBe('Highly Divisive'); // diff = 21.0
  });
});
