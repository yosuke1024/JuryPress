import { describe, it, expect } from 'vitest';
import {
  buildRecentTensionGlances,
  countSharedTension,
  detectTensionConvergence,
  sharesTension,
  type DiaryTensionGlance
} from '../../src/lib/diary/tension';
import {
  DIARY_ENDING_DIRECTIONS,
  DIARY_PRESSURED_VALUES,
  DIARY_TENSION_CYCLE,
  DiaryEntrySchema,
  type DiaryEntry,
  type DiaryEntryFocus,
  type DiaryTheme
} from '../../src/schemas/diary';
import type { JudgeSlug } from '../../src/schemas/jury';
import {
  DIARY_CONVERGED_CYCLE_SAMPLE,
  DIARY_CYCLE_SAMPLE,
  FIXTURE_BODY_EN,
  FIXTURE_BODY_JA,
  createEntryFocus,
  type DiaryCycleSampleEntry
} from '../helpers/diary-fixtures';

/*
 * Issue #127: four consecutive entries, four jurors, four scenes, four sets of relationships —
 * and one conflict between them. A need for order, precision, symmetry or planning meets
 * imperfect reality and is softened by it.
 *
 * Every earlier measure passes that sequence. The centre comparison (#110) reads one juror's own
 * last two entries and these are four different jurors; the mode comparison (#113) sees three
 * entries with somebody else acting on the page; the arcs, subjects and objects all differ. What
 * recurs is the editorial function of the day, and four writers describing one function in four
 * private vocabularies share no word for it — so this module counts labels, and can do nothing
 * worse than produce a paragraph of prompt text and a warning.
 */

function entry(input: {
  date: string;
  jurorId: string;
  theme?: DiaryTheme;
  entryFocus?: DiaryEntryFocus | null;
}): DiaryEntry {
  return DiaryEntrySchema.parse({
    schema_version: '1.0',
    id: `diary-${input.date}-${input.jurorId}`,
    date: input.date,
    jurorId: input.jurorId,
    theme: input.theme ?? 'work',
    privateEventCategory: null,
    title: { en: 'A Title', ja: 'タイトル' },
    body: { en: FIXTURE_BODY_EN, ja: FIXTURE_BODY_JA },
    mood: { en: 'level', ja: '平静' },
    shareQuote: { en: 'A quote.', ja: '引用。' },
    relatedReviewSlugs: [],
    entryFocus: input.entryFocus ?? null,
    publishedAt: `${input.date}T09:00:00.000Z`,
    generation: { model: 'gemini-3.5-flash', promptVersion: 'diary-v9' }
  });
}

/** The sample rotations as an archive, newest first — what the context builder reads. */
function archiveOf(sample: readonly DiaryCycleSampleEntry[]): DiaryEntry[] {
  return sample
    .map((row) => entry({ date: row.date, jurorId: row.jurorId, theme: row.theme, entryFocus: row.focus }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** A glance built by hand, for the counting tests that do not need an archive. */
function glance(
  jurorId: JudgeSlug,
  date: string,
  pressuredValue: string,
  endingDirection: string
): DiaryTensionGlance {
  return {
    jurorId,
    date,
    theme: 'private',
    centralTension: `something about ${pressuredValue}`,
    beliefChallenged: `that ${pressuredValue} is worth defending`,
    pressuredValue,
    endingDirection
  };
}

describe('sharesTension', () => {
  it('matches two entries that pressed one value and gave way the same way', () => {
    expect(
      sharesTension(
        createEntryFocus({ pressuredValue: 'order', endingDirection: 'change' }),
        createEntryFocus({ pressuredValue: 'order', endingDirection: 'change' })
      )
    ).toBe(true);
  });

  /*
   * The case issue #127 says must stay allowed. Two diarists arguing with their own standards in
   * one week is a shared theme; one giving way and the other refusing to is two lives, and this
   * is the pair the advisory may never fire on.
   */
  it('leaves a shared value alone when the entries end differently', () => {
    expect(
      sharesTension(
        createEntryFocus({ pressuredValue: 'order', endingDirection: 'change' }),
        createEntryFocus({ pressuredValue: 'order', endingDirection: 'refusal' })
      )
    ).toBe(false);
  });

  it('leaves a shared ending alone when the entries pressed different values', () => {
    expect(
      sharesTension(
        createEntryFocus({ pressuredValue: 'order', endingDirection: 'change' }),
        createEntryFocus({ pressuredValue: 'loyalty', endingDirection: 'change' })
      )
    ).toBe(false);
  });

  /*
   * A blank agrees with nothing. Every entry published before diary-v9 has an unstated tension
   * half, and reading two of those as a match would make the whole existing archive look like
   * one long convergence.
   */
  it('never matches an entry that named no value', () => {
    const unstated = createEntryFocus({ pressuredValue: '', endingDirection: '' });

    expect(sharesTension(unstated, unstated)).toBe(false);
    expect(
      sharesTension(unstated, createEntryFocus({ pressuredValue: 'order', endingDirection: 'change' }))
    ).toBe(false);
  });

  it('reads a value the writer capitalized as the same value', () => {
    expect(
      sharesTension(
        createEntryFocus({ pressuredValue: 'Order', endingDirection: 'Change' }),
        createEntryFocus({ pressuredValue: 'order', endingDirection: 'change' })
      )
    ).toBe(true);
  });
});

describe('countSharedTension', () => {
  it('counts the entries of the shown cycle that wrote this entry’s pair', () => {
    const cycle = [
      glance('alex', '2026-08-21', 'order', 'change'),
      glance('david', '2026-08-22', 'order', 'change'),
      glance('lisa', '2026-08-23', 'order', 'refusal'),
      glance('sarah', '2026-08-24', 'loyalty', 'change')
    ];

    expect(
      countSharedTension(cycle, createEntryFocus({ pressuredValue: 'order', endingDirection: 'change' }))
    ).toBe(2);
  });

  it('counts nothing for an entry that named no value', () => {
    const cycle = [glance('alex', '2026-08-21', 'order', 'change')];

    expect(
      countSharedTension(cycle, createEntryFocus({ pressuredValue: '', endingDirection: 'change' }))
    ).toBe(0);
  });
});

describe('buildRecentTensionGlances', () => {
  it('reads one rotation of other diarists, newest first', () => {
    const glances = buildRecentTensionGlances({
      entries: archiveOf(DIARY_CYCLE_SAMPLE),
      before: '2026-08-26'
    });

    expect(glances).toHaveLength(DIARY_TENSION_CYCLE.entryCount);
    expect(glances.map((row) => row.jurorId)).toEqual(['marcus', 'sarah', 'lisa', 'david']);
  });

  /*
   * Strictly earlier days only, for the reason every other diary window has: a re-run of a day
   * must see the past its first attempt saw, and an entry dated today means the day is written.
   */
  it('ignores today and anything after it', () => {
    const glances = buildRecentTensionGlances({
      entries: archiveOf(DIARY_CYCLE_SAMPLE),
      before: '2026-08-23'
    });

    expect(glances.map((row) => row.date)).toEqual(['2026-08-22', '2026-08-21']);
  });

  /*
   * The archive starts empty here, as it did for every measure before this one. Entries written
   * under diary-v8 and earlier carry a centre and a mode and no vocabulary for their conflict,
   * and showing them as a row of blanks would tell the next writer nothing while looking like
   * data. `centralTension` alone does not rescue such a row: it has been on the record since
   * diary-v5, and the whole finding of #127 is that it shows nothing across four jurors.
   */
  it('skips an entry whose tension half is unstated, and one with no focus at all', () => {
    const glances = buildRecentTensionGlances({
      entries: [
        entry({
          date: '2026-08-22',
          jurorId: 'david',
          entryFocus: createEntryFocus({
            centralTension: 'A conflict nobody labelled.',
            beliefChallenged: '',
            pressuredValue: '',
            endingDirection: ''
          })
        }),
        entry({ date: '2026-08-21', jurorId: 'alex', entryFocus: null }),
        entry({
          date: '2026-08-20',
          jurorId: 'marcus',
          entryFocus: createEntryFocus({ pressuredValue: 'ambition', endingDirection: 'refusal' })
        })
      ],
      before: '2026-08-23'
    });

    expect(glances.map((row) => row.jurorId)).toEqual(['marcus']);
  });

  /* A writer who named only what was under pressure still has something to show the room. */
  it('keeps an entry that stated part of its tension half', () => {
    const glances = buildRecentTensionGlances({
      entries: [
        entry({
          date: '2026-08-22',
          jurorId: 'david',
          entryFocus: createEntryFocus({
            beliefChallenged: 'that the shelf should be level',
            pressuredValue: '',
            endingDirection: ''
          })
        })
      ],
      before: '2026-08-23'
    });

    expect(glances).toHaveLength(1);
    expect(glances[0].beliefChallenged).toBe('that the shelf should be level');
    expect(glances[0].pressuredValue).toBe('');
  });
});

describe('detectTensionConvergence', () => {
  /*
   * The prompt's side of the count. It is shown the four entries before today and has not
   * written the fifth, so three already agreeing is the state in which today would complete the
   * run — which is why the default threshold is one short of DIARY_TENSION_CYCLE.convergentRun.
   */
  it('names the run when today would complete it', () => {
    const glances = buildRecentTensionGlances({
      entries: archiveOf(DIARY_CONVERGED_CYCLE_SAMPLE),
      before: '2026-08-25'
    });
    const convergence = detectTensionConvergence(glances);

    expect(convergence).not.toBeNull();
    expect(convergence?.pressuredValue).toBe('order');
    expect(convergence?.endingDirection).toBe('change');
    expect(convergence?.count).toBe(DIARY_TENSION_CYCLE.convergentRun - 1);
    expect(convergence?.total).toBe(DIARY_TENSION_CYCLE.entryCount);
    // The finding is that it is not one persona repeating itself.
    expect(convergence?.jurorIds).toEqual(['lisa', 'david', 'alex']);
  });

  /*
   * The documented rotation, which the guidance leaves alone. Four values and three endings
   * across five entries, and — the part that matters — David and Lisa both pressing `order` with
   * different answers to it.
   */
  it('says nothing about the rotation whose entries disagree', () => {
    const glances = buildRecentTensionGlances({
      entries: archiveOf(DIARY_CYCLE_SAMPLE),
      before: '2026-08-26'
    });

    expect(detectTensionConvergence(glances)).toBeNull();
  });

  /*
   * The explicit form of the same protection: a whole cycle may care about one thing, provided
   * the cycle does not agree about what to do with it. This is a shared theme, not a moral.
   */
  it('says nothing when every entry presses one value and each ends its own way', () => {
    const glances = [
      glance('alex', '2026-08-21', 'order', 'change'),
      glance('david', '2026-08-22', 'order', 'refusal'),
      glance('lisa', '2026-08-23', 'order', 'escalation'),
      glance('sarah', '2026-08-24', 'order', 'unresolved')
    ];

    expect(detectTensionConvergence(glances)).toBeNull();
  });

  it('says nothing when a cycle ends one way for four different reasons', () => {
    const glances = [
      glance('alex', '2026-08-21', 'order', 'change'),
      glance('david', '2026-08-22', 'loyalty', 'change'),
      glance('lisa', '2026-08-23', 'competence', 'change'),
      glance('sarah', '2026-08-24', 'care', 'change')
    ];

    expect(detectTensionConvergence(glances)).toBeNull();
  });

  it('says nothing about a cycle that named no values at all', () => {
    const glances = [
      glance('alex', '2026-08-21', '', ''),
      glance('david', '2026-08-22', '', ''),
      glance('lisa', '2026-08-23', '', ''),
      glance('sarah', '2026-08-24', '', '')
    ];

    expect(detectTensionConvergence(glances)).toBeNull();
  });

  /* Ties go to the group the writer read most recently, which is the one worth naming. */
  it('names the newest of two equally common pairs', () => {
    const glances = [
      glance('alex', '2026-08-24', 'ambition', 'refusal'),
      glance('david', '2026-08-23', 'ambition', 'refusal'),
      glance('lisa', '2026-08-22', 'order', 'change'),
      glance('sarah', '2026-08-21', 'order', 'change')
    ];

    expect(detectTensionConvergence(glances, 2)?.pressuredValue).toBe('ambition');
  });
});

/*
 * The two documented samples, held to what issue #127 asks a rotation to look like. They are the
 * worked example in docs/current/jurydiary.md, and a fixture that drifted out of the accepted
 * vocabularies would be documenting a pipeline that does not exist.
 */
describe('the documented rotations', () => {
  it('gives the healthy sample three central tensions, three endings and no repeated pair', () => {
    const values = new Set(DIARY_CYCLE_SAMPLE.map((row) => row.focus.pressuredValue));
    const directions = new Set(DIARY_CYCLE_SAMPLE.map((row) => row.focus.endingDirection));
    const tensions = new Set(DIARY_CYCLE_SAMPLE.map((row) => row.focus.centralTension));
    const pairs = DIARY_CYCLE_SAMPLE.map(
      (row) => `${row.focus.pressuredValue} ${row.focus.endingDirection}`
    );

    expect(DIARY_CYCLE_SAMPLE).toHaveLength(5);
    expect(tensions.size).toBe(5);
    expect(values.size).toBeGreaterThanOrEqual(3);
    expect(directions.size).toBeGreaterThanOrEqual(3);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  /* The case that has to survive: a value two entries share, answered two ways. */
  it('has the healthy sample share one value across two entries that disagree', () => {
    const order = DIARY_CYCLE_SAMPLE.filter((row) => row.focus.pressuredValue === 'order');

    expect(order.length).toBeGreaterThanOrEqual(2);
    expect(new Set(order.map((row) => row.focus.endingDirection)).size).toBe(order.length);
  });

  it('gives the converged sample four entries with one value and one ending', () => {
    const pairs = DIARY_CONVERGED_CYCLE_SAMPLE.map(
      (row) => `${row.focus.pressuredValue} ${row.focus.endingDirection}`
    );
    const softened = pairs.filter((pair) => pair === 'order change');

    expect(DIARY_CONVERGED_CYCLE_SAMPLE).toHaveLength(5);
    expect(softened).toHaveLength(DIARY_TENSION_CYCLE.convergentRun);
  });

  it('keeps both samples inside the accepted vocabularies', () => {
    for (const row of [...DIARY_CYCLE_SAMPLE, ...DIARY_CONVERGED_CYCLE_SAMPLE]) {
      expect(DIARY_PRESSURED_VALUES).toContain(row.focus.pressuredValue);
      expect(DIARY_ENDING_DIRECTIONS).toContain(row.focus.endingDirection);
      expect(row.focus.beliefChallenged.length).toBeGreaterThan(0);
    }
  });
});
