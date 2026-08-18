import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  DIARY_CONTEXT_BUDGET,
  buildDiaryContext,
  extractClosing,
  extractOpening
} from '../../src/lib/diary/context';
import {
  DiaryEntrySchema,
  type DiaryEntry,
  type DiaryEntryFocus,
  type DiaryProjectUpdate,
  type DiaryTheme
} from '../../src/schemas/diary';
import { getJudge } from '../../src/lib/jury';
import {
  DIARY_CYCLE_SAMPLE,
  FIXTURE_BODY_EN,
  FIXTURE_BODY_JA,
  createEntryFocus,
  createJurorStates
} from '../helpers/diary-fixtures';
import { DIARY_RECENT_CYCLE } from '../../src/schemas/diary';

/*
 * Arc glances exist because of issue #105: five diarists, one narrative shape — prop,
 * professional metaphor, tidy lesson. The shape lives at the two ends of a body, so the
 * context reduces recent entries to their first and last sentences. Peer glances could not
 * carry this: they excerpt only the start, which shows how everyone opens and hides how
 * everyone ends — and the tidy-lesson habit lives at the end.
 */

/** A content root that does not exist: review reading is fail-soft, so none is needed. */
const MISSING_ROOT = path.join(os.tmpdir(), 'jurypress-diary-context-test-no-root');

function entry(overrides: {
  date: string;
  jurorId: string;
  theme?: DiaryTheme;
  bodyEn?: string;
  /** Omitted on purpose by the tests covering entries written before focus existed. */
  entryFocus?: DiaryEntryFocus;
  /** Likewise for entries written before project continuity existed (issue #111). */
  projectUpdates?: DiaryProjectUpdate[];
}): DiaryEntry {
  return DiaryEntrySchema.parse({
    schema_version: '1.0',
    id: `diary-${overrides.date}-${overrides.jurorId}`,
    date: overrides.date,
    jurorId: overrides.jurorId,
    theme: overrides.theme ?? 'private',
    privateEventCategory: 'rest',
    title: { en: 'A Title', ja: 'タイトル' },
    body: { en: overrides.bodyEn ?? FIXTURE_BODY_EN, ja: FIXTURE_BODY_JA },
    mood: { en: 'level', ja: '平静' },
    shareQuote: { en: 'A quote.', ja: '引用。' },
    relatedReviewSlugs: [],
    entryFocus: overrides.entryFocus ?? null,
    projectUpdates: overrides.projectUpdates ?? [],
    publishedAt: `${overrides.date}T09:00:00.000Z`,
    generation: { model: 'gemini-3.5-flash', promptVersion: 'diary-v3' }
  });
}

/** The archive is always handed over newest-first, as the entry store returns it. */
function archive(...entries: DiaryEntry[]): DiaryEntry[] {
  return [...entries].sort((a, b) => b.date.localeCompare(a.date));
}

function build(input: { date: string; jurorId: 'alex' | 'david'; entries: DiaryEntry[] }) {
  return buildDiaryContext({
    contentRoot: MISSING_ROOT,
    juror: getJudge(input.jurorId),
    date: input.date,
    theme: 'private',
    privateEventCategory: 'rest',
    states: createJurorStates(input.jurorId),
    entries: input.entries
  });
}

describe('extractOpening', () => {
  it('returns a short body whole', () => {
    expect(extractOpening('One line, no more.', 220)).toBe('One line, no more.');
  });

  it('keeps whole leading sentences within the cap', () => {
    const body = `First sentence here. Second sentence follows after. ${'x'.repeat(300)}.`;
    expect(extractOpening(body, 60)).toBe('First sentence here. Second sentence follows after.');
  });

  it('respects a closing quote after the terminator', () => {
    const body = `"Is that so?" she asked. ${'x'.repeat(300)}.`;
    expect(extractOpening(body, 30)).toBe('"Is that so?" she asked.');
  });

  it('hard-truncates when the first sentence alone exceeds the cap', () => {
    const body = `${'a'.repeat(100)}. And then more.`;
    expect(extractOpening(body, 40)).toBe(`${'a'.repeat(40)}…`);
  });
});

describe('extractClosing', () => {
  it('returns a short body whole', () => {
    expect(extractClosing('One line, no more.', 220)).toBe('One line, no more.');
  });

  it('keeps the longest run of whole trailing sentences that fits', () => {
    const body = `${'x'.repeat(300)}. Penultimate sentence sits here. The very last sentence.`;
    expect(extractClosing(body, 220)).toBe('Penultimate sentence sits here. The very last sentence.');
    expect(extractClosing(body, 30)).toBe('The very last sentence.');
  });

  it('hard-truncates when the last sentence alone exceeds the cap', () => {
    const body = `Short start. ${'z'.repeat(100)}`;
    expect(extractClosing(body, 40)).toBe(`…${'z'.repeat(40)}`);
  });
});

describe('diary context — recent arcs', () => {
  it('reduces the newest entries to opening and closing, own entries included', () => {
    const opener = 'The kettle failed again this morning.';
    const closer = 'I still have not called anyone about it.';
    const body = `${opener} ${'Filler sentence in the middle. '.repeat(20)}${closer}`;
    const entries = archive(
      entry({ date: '2026-08-07', jurorId: 'david', theme: 'work', bodyEn: body }),
      entry({ date: '2026-08-06', jurorId: 'alex' })
    );

    const context = build({ date: '2026-08-08', jurorId: 'alex', entries });

    expect(context.recentArcs.map((arc) => `${arc.date}-${arc.jurorId}`)).toEqual([
      '2026-08-07-david',
      '2026-08-06-alex'
    ]);
    // The duty juror's own previous entry is surveyed too: the repeated arc is a property of
    // the whole diary, not of the other four.
    expect(context.recentArcs.some((arc) => arc.jurorId === 'alex')).toBe(true);

    const david = context.recentArcs[0];
    expect(david.theme).toBe('work');
    expect(david.opening.startsWith(opener)).toBe(true);
    expect(david.closing.endsWith(closer)).toBe(true);
    expect(david.opening.length).toBeLessThanOrEqual(DIARY_CONTEXT_BUDGET.arcOpeningChars + 1);
    expect(david.closing.length).toBeLessThanOrEqual(DIARY_CONTEXT_BUDGET.arcClosingChars + 1);
  });

  it('caps the survey at arcGlanceCount and ignores today and later', () => {
    const jurors = ['alex', 'david', 'lisa', 'sarah', 'marcus'] as const;
    const past = Array.from({ length: 8 }, (_, i) =>
      entry({ date: `2026-08-0${8 - i}`, jurorId: jurors[i % jurors.length] })
    );
    const entries = archive(...past, entry({ date: '2026-08-09', jurorId: 'david' }));

    const context = build({ date: '2026-08-09', jurorId: 'david', entries });

    expect(context.recentArcs).toHaveLength(DIARY_CONTEXT_BUDGET.arcGlanceCount);
    // Newest strictly-earlier entry first; the entry dated today is not part of the past.
    expect(context.recentArcs[0].date).toBe('2026-08-08');
    expect(context.recentArcs.every((arc) => arc.date < '2026-08-09')).toBe(true);
  });

  it('yields no arcs on an empty archive', () => {
    const context = build({ date: '2026-08-08', jurorId: 'alex', entries: [] });
    expect(context.recentArcs).toEqual([]);
  });
});

/*
 * Issue #110: three consecutive Alex entries centred on the same typewriter ribbon and the
 * same friction thesis. The context could not have noticed — it carried the bodies but nothing
 * saying what any of them had been *about*.
 */
describe('buildDiaryContext — recent focuses (issue #110)', () => {
  const ribbon = createEntryFocus({
    dominantSubject: 'replacing the ribbon on the Hermes Baby',
    anchorObject: 'the Hermes Baby typewriter',
    centralTension: 'Manual friction gives a hobby its soul but has no place in software.',
    endingState: 'settled into a lesson'
  });

  it("carries the writer's own last two entries, newest first", () => {
    const context = build({
      date: '2026-08-11',
      jurorId: 'alex',
      entries: archive(
        entry({ date: '2026-08-01', jurorId: 'alex', entryFocus: ribbon }),
        entry({ date: '2026-08-06', jurorId: 'alex', entryFocus: ribbon }),
        entry({ date: '2026-08-09', jurorId: 'david', entryFocus: ribbon })
      )
    });

    expect(context.recentFocuses.map((glance) => glance.date)).toEqual(['2026-08-06', '2026-08-01']);
    expect(context.recentFocuses[0].focus.anchorObject).toBe('the Hermes Baby typewriter');
  });

  /*
   * A subject dominating one persona's story is that persona's to move on from. Two diarists
   * both writing about their own kitchens is not a recurrence, and treating it as one would
   * push the five of them apart rather than letting each accumulate.
   */
  it('ignores what the other diarists have been writing about', () => {
    const context = build({
      date: '2026-08-11',
      jurorId: 'alex',
      entries: archive(
        entry({ date: '2026-08-09', jurorId: 'david', entryFocus: ribbon }),
        entry({ date: '2026-08-10', jurorId: 'david', entryFocus: ribbon })
      )
    });

    expect(context.recentFocuses).toEqual([]);
    expect(context.recurringFocus).toBeNull();
  });

  it('reports the shared centre when the last two entries agree on one', () => {
    const context = build({
      date: '2026-08-11',
      jurorId: 'alex',
      entries: archive(
        entry({ date: '2026-08-01', jurorId: 'alex', entryFocus: ribbon }),
        entry({ date: '2026-08-06', jurorId: 'alex', entryFocus: ribbon })
      )
    });

    expect(context.recurringFocus?.sharedSubjectTerms).toContain('ribbon');
  });

  /*
   * Every entry published before this shipped carries no focus. The context must show what it
   * has and claim nothing about what it does not — a juror whose only focus record is one day
   * old has not repeated anything yet.
   */
  it('skips entries written before focus existed, without inventing one', () => {
    const context = build({
      date: '2026-08-11',
      jurorId: 'alex',
      entries: archive(
        entry({ date: '2026-08-01', jurorId: 'alex' }),
        entry({ date: '2026-08-06', jurorId: 'alex', entryFocus: ribbon })
      )
    });

    expect(context.recentFocuses).toHaveLength(1);
    expect(context.recentFocuses[0].date).toBe('2026-08-06');
    expect(context.recurringFocus).toBeNull();
  });

  it('looks no further back than the two entries the question needs', () => {
    const context = build({
      date: '2026-08-16',
      jurorId: 'alex',
      entries: archive(
        entry({ date: '2026-08-01', jurorId: 'alex', entryFocus: ribbon }),
        entry({ date: '2026-08-06', jurorId: 'alex', entryFocus: ribbon }),
        entry({ date: '2026-08-11', jurorId: 'alex', entryFocus: ribbon })
      )
    });

    expect(context.recentFocuses).toHaveLength(DIARY_CONTEXT_BUDGET.ownRecentFocusCount);
    expect(context.recentFocuses.map((glance) => glance.date)).toEqual(['2026-08-11', '2026-08-06']);
  });
});

/*
 * Issue #111. The context's job here is narrow: hand the prompt the writer's own open projects
 * with the stage the archive last left them at. The matching and the cap are lib/diary/projects'
 * problem and are tested there; what this pins is that the ledger is built from the published
 * archive, for this juror, out of days that already happened.
 */
describe('buildDiaryContext — ongoing projects (issue #111)', () => {
  const VARNISH = [
    { project: 'the cedar bookcase', stage: 'third coat of varnish applied', movement: 'advanced' }
  ];

  it('carries this juror\'s own projects at the stage their last entry left them', () => {
    const context = build({
      date: '2026-08-12',
      jurorId: 'david',
      entries: archive(
        entry({ date: '2026-08-02', jurorId: 'david', projectUpdates: VARNISH }),
        entry({ date: '2026-08-07', jurorId: 'david', projectUpdates: [] })
      )
    });

    expect(context.projectLedger).toEqual([
      {
        project: 'the cedar bookcase',
        stage: 'third coat of varnish applied',
        movement: 'advanced',
        date: '2026-08-02'
      }
    ]);
  });

  it('leaves out other jurors and the day being written', () => {
    const context = build({
      date: '2026-08-12',
      jurorId: 'david',
      entries: archive(
        entry({ date: '2026-08-12', jurorId: 'david', projectUpdates: VARNISH }),
        entry({
          date: '2026-08-11',
          jurorId: 'alex',
          projectUpdates: [
            { project: 'the Hermes Baby', stage: 'ribbon replaced', movement: 'completed' }
          ]
        })
      )
    });

    expect(context.projectLedger).toEqual([]);
  });

  /* Every entry in the archive on the day this ships was written without the field. */
  it('is empty on an archive that predates project updates', () => {
    const context = build({
      date: '2026-08-12',
      jurorId: 'david',
      entries: archive(entry({ date: '2026-08-02', jurorId: 'david' }))
    });

    expect(context.projectLedger).toEqual([]);
  });
});

/*
 * Issue #113: the essay mode is what Sarah's 08-14 and Marcus's 08-15 entries had in common
 * when they had nothing else in common. It belongs to the rotation rather than to a persona,
 * so unlike the focus glances above, this window is read across all five diarists.
 */
describe('buildDiaryContext — the recent cycle (issue #113)', () => {
  function sampleEntries(): DiaryEntry[] {
    return archive(
      ...DIARY_CYCLE_SAMPLE.map((sample) =>
        entry({
          date: sample.date,
          jurorId: sample.jurorId,
          theme: sample.theme,
          entryFocus: sample.focus
        })
      )
    );
  }

  it('carries every diarist’s latest, newest first', () => {
    const context = build({ date: '2026-08-26', jurorId: 'alex', entries: sampleEntries() });

    expect(context.recentCycle.map((glance) => glance.jurorId)).toEqual([
      'marcus',
      'sarah',
      'lisa',
      'david',
      'alex'
    ]);
    expect(context.recentCycle).toHaveLength(DIARY_CONTEXT_BUDGET.sceneGlanceCount);
    expect(DIARY_CONTEXT_BUDGET.sceneGlanceCount).toBe(DIARY_RECENT_CYCLE.entryCount);
  });

  it('reduces each entry to what happened in it, not to what it was about', () => {
    const context = build({ date: '2026-08-26', jurorId: 'alex', entries: sampleEntries() });
    const sarah = context.recentCycle.find((glance) => glance.jurorId === 'sarah');

    expect(sarah?.sceneEvent).toMatch(/retention figure/);
    expect(sarah?.interactionLevel).toBe('direct');
    expect(sarah?.abstractionLevel).toBe('mixed');
    expect(sarah?.endingState).toMatch(/conceded/);
  });

  /* Two of five is the sample's own count, and one short of the threshold. */
  it('reports no run for a cycle that mostly had days in it', () => {
    const context = build({ date: '2026-08-26', jurorId: 'alex', entries: sampleEntries() });

    expect(context.essayRun).toBeNull();
  });

  it('reports the run once a majority of the cycle argued with nothing happening', () => {
    const argued = createEntryFocus({
      sceneEvent: null,
      interactionLevel: 'none',
      abstractionLevel: 'argument'
    });
    const context = build({
      date: '2026-08-26',
      jurorId: 'alex',
      entries: archive(
        entry({ date: '2026-08-21', jurorId: 'alex', entryFocus: argued }),
        entry({ date: '2026-08-22', jurorId: 'david', entryFocus: argued }),
        entry({ date: '2026-08-23', jurorId: 'lisa', entryFocus: argued }),
        entry({ date: '2026-08-24', jurorId: 'sarah', entryFocus: createEntryFocus() })
      )
    });

    expect(context.essayRun?.count).toBe(3);
    expect(context.essayRun?.total).toBe(4);
    expect(context.essayRun?.jurorIds).toEqual(['lisa', 'david', 'alex']);
  });

  /*
   * Every entry published before this shipped predates the scene fields, and an entry written
   * under diary-v5 or v6 carries the other four. Neither may appear as a row of blanks.
   */
  it('ignores entries whose scene half was never stated', () => {
    const context = build({
      date: '2026-08-26',
      jurorId: 'alex',
      entries: archive(
        entry({ date: '2026-08-24', jurorId: 'sarah' }),
        entry({
          date: '2026-08-23',
          jurorId: 'lisa',
          entryFocus: createEntryFocus({
            sceneEvent: null,
            interactionLevel: '',
            abstractionLevel: ''
          })
        })
      )
    });

    expect(context.recentCycle).toEqual([]);
    expect(context.essayRun).toBeNull();
  });
});
