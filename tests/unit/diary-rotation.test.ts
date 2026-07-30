import { describe, it, expect } from 'vitest';
import {
  addDays,
  daysSinceStart,
  isDateKey,
  resolveDutyJuror,
  resolveNextDuty,
  toEpochDay,
  upcomingDuty
} from '../../src/lib/diary/rotation';
import { DiaryConfigSchema } from '../../src/schemas/diary-state';
import { TimezoneUtil } from '../../src/lib/timezone';
import { createDiaryConfig } from '../helpers/diary-fixtures';

describe('diary rotation', () => {
  const config = createDiaryConfig({ startDate: '2026-08-01' });

  it('assigns the first juror to the start date and walks the rotation from there', () => {
    expect(resolveDutyJuror(config, '2026-08-01')).toBe('alex');
    expect(resolveDutyJuror(config, '2026-08-02')).toBe('david');
    expect(resolveDutyJuror(config, '2026-08-03')).toBe('lisa');
    expect(resolveDutyJuror(config, '2026-08-04')).toBe('sarah');
    expect(resolveDutyJuror(config, '2026-08-05')).toBe('marcus');
  });

  it('returns to the same juror every five days, across month and year boundaries', () => {
    for (let offset = 0; offset < 400; offset += 1) {
      const date = addDays('2026-08-01', offset);
      const fiveLater = addDays('2026-08-01', offset + 5);
      expect(resolveDutyJuror(config, fiveLater)).toBe(resolveDutyJuror(config, date));
    }
  });

  it('covers all five jurors within any five-day window', () => {
    const window = [0, 1, 2, 3, 4].map((offset) =>
      resolveDutyJuror(config, addDays('2026-11-27', offset))
    );
    expect(new Set(window).size).toBe(5);
  });

  it('refuses dates before the configured start', () => {
    expect(() => resolveDutyJuror(config, '2026-07-31')).toThrow(/precedes the configured start/);
    expect(daysSinceStart(config, '2026-07-31')).toBe(-1);
  });

  /**
   * The duty day is decided from a JST calendar key, so the machine's local timezone cannot
   * change whose turn it is. This pins both halves: the JST key derived from an instant, and
   * the rotation derived from that key.
   */
  it('does not shift duty with the timezone of the host', () => {
    const lastMomentOfJstDay = TimezoneUtil.getJSTDateKey('2026-08-02T14:59:00Z');
    const firstMomentOfNextJstDay = TimezoneUtil.getJSTDateKey('2026-08-02T15:00:00Z');

    expect(lastMomentOfJstDay).toBe('2026-08-02');
    expect(firstMomentOfNextJstDay).toBe('2026-08-03');

    expect(resolveDutyJuror(config, lastMomentOfJstDay)).toBe('david');
    expect(resolveDutyJuror(config, firstMomentOfNextJstDay)).toBe('lisa');
  });

  /**
   * A failed day is left as a gap. The next day belongs to whoever the calendar says, which is
   * exactly what makes a missing entry readable as an outage rather than a reshuffle.
   */
  it('keeps the rotation on the calendar when a day is skipped', () => {
    // Suppose 2026-08-03 (lisa) never generated. The following day is still sarah's.
    expect(resolveDutyJuror(config, '2026-08-04')).toBe('sarah');
    expect(resolveNextDuty(config, '2026-08-03')).toEqual({ date: '2026-08-04', jurorId: 'sarah' });
  });

  it('rejects dates that are not real calendar days', () => {
    expect(isDateKey('2026-02-30')).toBe(false);
    expect(isDateKey('2026-13-01')).toBe(false);
    expect(isDateKey('20260801')).toBe(false);
    expect(isDateKey('2026-08-01')).toBe(true);
    expect(() => toEpochDay('2026-02-30')).toThrow(/Not a real calendar date/);
  });

  it('walks dates across a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2028-02-28', 2)).toBe('2028-03-01');
    expect(toEpochDay('2028-03-01') - toEpochDay('2028-02-28')).toBe(2);
  });

  it('lists upcoming duty and skips days before the start date', () => {
    const roster = upcomingDuty(createDiaryConfig({ startDate: '2026-08-03' }), '2026-08-01', 4);
    expect(roster).toEqual([
      { date: '2026-08-03', jurorId: 'alex' },
      { date: '2026-08-04', jurorId: 'david' }
    ]);
  });

  it('requires the configured rotation to name each juror exactly once', () => {
    expect(() =>
      DiaryConfigSchema.parse({
        schema_version: '1.0',
        startDate: '2026-08-01',
        rotation: ['alex', 'alex', 'lisa', 'sarah', 'marcus'],
        timezone: 'Asia/Tokyo'
      })
    ).toThrow(/exactly once/);

    expect(() =>
      DiaryConfigSchema.parse({
        schema_version: '1.0',
        startDate: '2026-08-01',
        rotation: ['alex', 'david'],
        timezone: 'Asia/Tokyo'
      })
    ).toThrow(/exactly once/);
  });
});
