import { describe, it, expect } from 'vitest';
import {
  buildDiaryProjectLedger,
  detectRepeatedProjectStages
} from '../../src/lib/diary/projects';
import {
  DIARY_PROJECT_LEDGER,
  DiaryEntrySchema,
  type DiaryEntry,
  type DiaryProjectUpdate
} from '../../src/schemas/diary';
import { FIXTURE_BODY_EN, FIXTURE_BODY_JA, createProjectUpdate } from '../helpers/diary-fixtures';

/*
 * Issue #111, in David's own words. On 2026-08-02 he "sat in my garage workshop, applying the
 * third coat of varnish to the cedar bookcase". On 08-07 he wrote about Marcus and his spice
 * jars. On 08-12 he was "on the third coat of varnish on the cedar bookcase", weighing a bubble
 * in the second layer as a live decision the third coat had not yet sealed.
 *
 * Nothing said the finish had been stripped. The project un-advanced itself between two good
 * entries, and neither of them is the defect on its own — the sequence is.
 *
 * This module answers that with a ledger and a report, and with nothing else: no rejection, no
 * ban on woodworking, and no reading of the bodies. A bookcase leaned against in passing is
 * invisible here, exactly as a typewriter merely on the desk is invisible to lib/diary/focus.ts.
 */

const BOOKCASE = 'the cedar bookcase';

function entry(overrides: {
  date: string;
  jurorId?: string;
  projectUpdates?: DiaryProjectUpdate[];
}): DiaryEntry {
  return DiaryEntrySchema.parse({
    schema_version: '1.0',
    id: `diary-${overrides.date}-${overrides.jurorId ?? 'david'}`,
    date: overrides.date,
    jurorId: overrides.jurorId ?? 'david',
    theme: 'private',
    privateEventCategory: 'hobby',
    title: { en: 'A Title', ja: 'タイトル' },
    body: { en: FIXTURE_BODY_EN, ja: FIXTURE_BODY_JA },
    mood: { en: 'level', ja: '平静' },
    shareQuote: { en: 'A quote.', ja: '引用。' },
    relatedReviewSlugs: [],
    // Omitted on purpose where a test covers entries written before this field existed.
    ...(overrides.projectUpdates ? { projectUpdates: overrides.projectUpdates } : {}),
    publishedAt: `${overrides.date}T09:00:00.000Z`,
    generation: { model: 'gemini-3.5-flash', promptVersion: 'diary-v6' }
  });
}

function ledgerOf(entries: DiaryEntry[], before = '2026-08-12', jurorId = 'david') {
  return buildDiaryProjectLedger({ entries, jurorId, before });
}

describe('buildDiaryProjectLedger', () => {
  it('carries a project forward with the stage the last entry left it at', () => {
    const ledger = ledgerOf([
      entry({
        date: '2026-08-02',
        projectUpdates: [
          { project: BOOKCASE, stage: 'third coat of varnish applied', movement: 'advanced' }
        ]
      }),
      entry({ date: '2026-08-07', projectUpdates: [] })
    ]);

    expect(ledger).toEqual([
      {
        project: BOOKCASE,
        stage: 'third coat of varnish applied',
        movement: 'advanced',
        date: '2026-08-02'
      }
    ]);
  });

  it('takes the newest statement of a project and drops the older ones', () => {
    const ledger = ledgerOf([
      entry({
        date: '2026-08-07',
        projectUpdates: [
          { project: 'the cedar bookcase', stage: 'hardware fitted', movement: 'completed' }
        ]
      }),
      entry({
        date: '2026-08-02',
        projectUpdates: [
          { project: 'the cedar bookcase', stage: 'third coat of varnish applied', movement: 'advanced' }
        ]
      })
    ]);

    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ stage: 'hardware fitted', date: '2026-08-07' });
  });

  /*
   * A finished project is exactly the thing a later entry can silently put back on the
   * workbench, so it stays in the ledger. Dropping it would leave that return unanchored — the
   * same failure one stage further on.
   */
  it('keeps a completed project, because a completed project can still come back', () => {
    const ledger = ledgerOf([
      entry({
        date: '2026-08-07',
        projectUpdates: [{ project: BOOKCASE, stage: 'finished and in the study', movement: 'completed' }]
      })
    ]);

    expect(ledger).toHaveLength(1);
    expect(ledger[0].movement).toBe('completed');
  });

  it('reads only this juror, and only days before the one being written', () => {
    const ledger = ledgerOf([
      entry({
        date: '2026-08-12',
        projectUpdates: [{ project: BOOKCASE, stage: 'today, which has not happened yet', movement: 'advanced' }]
      }),
      entry({
        date: '2026-08-11',
        jurorId: 'alex',
        projectUpdates: [{ project: 'the Hermes Baby', stage: 'ribbon replaced', movement: 'completed' }]
      }),
      entry({
        date: '2026-08-02',
        projectUpdates: [{ project: BOOKCASE, stage: 'third coat of varnish applied', movement: 'advanced' }]
      })
    ]);

    expect(ledger.map((row) => row.date)).toEqual(['2026-08-02']);
  });

  it('stops at the project cap and at the lookback', () => {
    /* Ten unrelated projects, one per entry, newest first once the builder sorts them. */
    const names = [
      'the cedar bookcase',
      'the spice jars',
      'the garage door runners',
      'a repair manual for the lathe',
      'the kitchen light',
      'a sourdough starter',
      'the hall skirting',
      'a set of chisels',
      'the fence post by the gate',
      'a bird table'
    ];
    const many = names.map((name, index) =>
      entry({
        date: `2026-08-${String(20 - index).padStart(2, '0')}`,
        projectUpdates: [{ project: name, stage: `stage ${index}`, movement: 'advanced' }]
      })
    );

    const ledger = buildDiaryProjectLedger({ entries: many, jurorId: 'david', before: '2026-09-01' });
    expect(ledger).toHaveLength(DIARY_PROJECT_LEDGER.maxProjects);
    expect(DIARY_PROJECT_LEDGER.maxProjects).toBeLessThanOrEqual(DIARY_PROJECT_LEDGER.ownEntryLookback);
    // Newest first, so the lookback trims the oldest entries rather than the newest.
    expect(ledger[0].date).toBe('2026-08-20');
    expect(ledger.map((row) => row.project)).toEqual(names.slice(0, DIARY_PROJECT_LEDGER.maxProjects));
  });

  /* The archive on the day this ships: seventeen entries, none carrying a project update. */
  it('is empty when no entry has reported a project', () => {
    expect(ledgerOf([entry({ date: '2026-08-02' }), entry({ date: '2026-08-07' })])).toEqual([]);
  });
});

describe('detectRepeatedProjectStages', () => {
  const ledger = ledgerOf([
    entry({
      date: '2026-08-02',
      projectUpdates: [
        { project: BOOKCASE, stage: 'third coat of varnish applied', movement: 'advanced' }
      ]
    }),
    entry({ date: '2026-08-07', projectUpdates: [] })
  ]);

  /* The issue, exactly: the same stage, ten days and one unrelated entry later. */
  it('flags a stage restated after an entry that said nothing about it', () => {
    const repeats = detectRepeatedProjectStages(
      [{ project: BOOKCASE, stage: 'third coat of varnish', movement: 'advanced' }],
      ledger
    );

    expect(repeats).toHaveLength(1);
    expect(repeats[0].previous.date).toBe('2026-08-02');
    expect(repeats[0].previous.stage).toBe('third coat of varnish applied');
  });

  it('accepts a return that says what undid it', () => {
    expect(
      detectRepeatedProjectStages(
        [{ project: BOOKCASE, stage: 'third coat of varnish', movement: 'restarted' }],
        ledger
      )
    ).toEqual([]);
    expect(
      detectRepeatedProjectStages(
        [
          {
            project: BOOKCASE,
            stage: 'finish stripped back to bare cedar after the coat blistered',
            movement: 'restarted'
          }
        ],
        ledger
      )
    ).toEqual([]);
    expect(
      detectRepeatedProjectStages(
        [{ project: BOOKCASE, stage: 'third coat of varnish', movement: 'failed' }],
        ledger
      )
    ).toEqual([]);
  });

  it('says nothing about a project that actually moved', () => {
    expect(
      detectRepeatedProjectStages(
        [{ project: BOOKCASE, stage: 'fourth coat of varnish applied', movement: 'advanced' }],
        ledger
      )
    ).toEqual([]);
    expect(
      detectRepeatedProjectStages(
        [{ project: BOOKCASE, stage: 'bubble sanded out of the second layer', movement: 'advanced' }],
        ledger
      )
    ).toEqual([]);
  });

  /*
   * Containment is checked in one direction only. A stage that reports work the old one did not
   * mention is a day of work even when it restates the old stage whole, and an advisory that
   * fires on that is an advisory nobody reads (lib/diary/focus.ts makes the same argument about
   * shared vocabulary).
   */
  it('does not flag a stage that carries the old one plus new work', () => {
    expect(
      detectRepeatedProjectStages(
        [
          {
            project: BOOKCASE,
            stage: 'third coat of varnish applied and the top bezel wet-sanded',
            movement: 'advanced'
          }
        ],
        ledger
      )
    ).toEqual([]);
  });

  it('is silent about a project the ledger has never seen', () => {
    expect(
      detectRepeatedProjectStages(
        [{ project: 'the spice jars', stage: 'labels printed and dated', movement: 'started' }],
        ledger
      )
    ).toEqual([]);
    expect(detectRepeatedProjectStages([createProjectUpdate()], [])).toEqual([]);
  });

  /*
   * Two projects that share only grammar are two projects. Without this the ledger reports a
   * repeat on the first pair of entries that both contain "the", which is the same failure mode
   * the focus detector's stop list exists to prevent.
   */
  it('does not read shared grammar as the same project or the same stage', () => {
    expect(
      detectRepeatedProjectStages(
        [{ project: 'the spice jars in the pantry', stage: 'all of them labelled', movement: 'completed' }],
        ledgerOf([
          entry({
            date: '2026-08-02',
            projectUpdates: [
              { project: 'the cedar bookcase', stage: 'all of the shelves cut', movement: 'advanced' }
            ]
          })
        ])
      )
    ).toEqual([]);
  });

  it('treats a plural and its singular as the same project', () => {
    const repeats = detectRepeatedProjectStages(
      [{ project: 'the spice jar labels', stage: 'printing labels', movement: 'advanced' }],
      ledgerOf([
        entry({
          date: '2026-08-07',
          projectUpdates: [
            { project: 'the spice jars', stage: 'printing the labels', movement: 'started' }
          ]
        })
      ])
    );

    expect(repeats).toHaveLength(1);
  });

  it('reports each repeated project once, and leaves the moved ones out', () => {
    const repeats = detectRepeatedProjectStages(
      [
        { project: BOOKCASE, stage: 'third coat of varnish', movement: 'advanced' },
        { project: 'the spice jars', stage: 'labels printed', movement: 'started' }
      ],
      ledger
    );

    expect(repeats.map((repeat) => repeat.project)).toEqual([BOOKCASE]);
  });
});
