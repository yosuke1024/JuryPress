import { describe, it, expect } from 'vitest';
import { TimezoneUtil } from '../../src/lib/timezone';

describe('TimezoneUtil', () => {
  it('should return JST year and month correctly', () => {
    // 2026-07-31T16:00:00.000Z in UTC is 2026-08-01T01:00:00 JST
    const date = new Date('2026-07-31T16:00:00.000Z');
    const { year, month } = TimezoneUtil.getJSTYearMonth(date);
    expect(year).toBe('2026');
    expect(month).toBe('08');
  });

  it('should return JST string correctly', () => {
    const date = new Date('2026-07-31T16:00:00.000Z');
    const str = TimezoneUtil.getJSTString(date);
    expect(str).toContain('2026-08-01');
  });
});
