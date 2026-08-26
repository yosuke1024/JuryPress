import { describe, it, expect } from 'vitest';
import {
  buildDiaryScheduleLedger,
  coveredWindow,
  detectRetimedCommitments,
  detectScheduleConflicts,
  detectUnexplainedScheduleChanges
} from '../../src/lib/diary/schedule';
import {
  DIARY_SCHEDULE_LEDGER,
  DiaryEntrySchema,
  type DiaryEntry,
  type DiaryScheduledEvent
} from '../../src/schemas/diary';
import { FIXTURE_BODY_EN, FIXTURE_BODY_JA, createScheduledEvent } from '../helpers/diary-fixtures';

/*
 * Issue #120, in Alex's own words. On 2026-08-16 Leo said his mother wanted them "next month" to
 * clear out the attic. On 08-21 — five calendar days later — they were clearing it, and the entry
 * said nothing about the visit having been brought forward, about anything urgent, or about
 * "next month" having been wrong.
 *
 * Both entries read well. What they cannot both be is true. This module answers that with a
 * ledger of standing plans and an advisory, and with nothing else: no rejection, no obligation
 * to keep a plan, and no reading of the bodies.
 */

const ATTIC = 'clearing out the attic at his mother’s house';

function entry(overrides: {
  date: string;
  jurorId?: string;
  scheduledEvents?: DiaryScheduledEvent[];
}): DiaryEntry {
  const jurorId = overrides.jurorId ?? 'alex';
  return DiaryEntrySchema.parse({
    schema_version: '1.0',
    id: `diary-${overrides.date}-${jurorId}`,
    date: overrides.date,
    jurorId,
    theme: 'private',
    privateEventCategory: 'family',
    title: { en: 'A Title', ja: 'タイトル' },
    body: { en: FIXTURE_BODY_EN, ja: FIXTURE_BODY_JA },
    mood: { en: 'level', ja: '平静' },
    shareQuote: { en: 'A quote.', ja: '引用。' },
    relatedReviewSlugs: [],
    // Omitted on purpose where a test covers entries written before this field existed.
    ...(overrides.scheduledEvents ? { scheduledEvents: overrides.scheduledEvents } : {}),
    publishedAt: `${overrides.date}T09:00:00.000Z`,
    generation: { model: 'gemini-3.5-flash', promptVersion: 'diary-v8' }
  });
}

function ledgerOf(entries: DiaryEntry[], before = '2026-08-21', jurorId = 'alex') {
  return buildDiaryScheduleLedger({ entries, jurorId, before });
}

/** The archive as it stood when Alex sat down to write 08-21. */
const ATTIC_ARCHIVE = [
  entry({
    date: '2026-08-16',
    scheduledEvents: [createScheduledEvent({ event: ATTIC, when: 'next month' })]
  })
];

describe('buildDiaryScheduleLedger', () => {
  it('carries a plan forward with the words it was given and the days they resolve to', () => {
    expect(ledgerOf(ATTIC_ARCHIVE)).toEqual([
      {
        event: ATTIC,
        participants: 'Leo and his mother',
        when: 'next month',
        window: { start: '2026-09-01', end: '2026-09-30' },
        movement: 'made',
        date: '2026-08-16',
        diaryId: 'diary-2026-08-16-alex'
      }
    ]);
  });

  /*
   * The difference from the project ledger, and the one acceptance criterion that is about the
   * ledger rather than the check. A finished bookcase stays on the project ledger because it can
   * be quietly put back on the workbench; a visit that has happened is not a plan any more, and
   * carrying it forward as one is how a writer gets told to keep an appointment it already kept.
   */
  it('drops a plan once it has been kept', () => {
    expect(
      ledgerOf([
        entry({
          date: '2026-08-21',
          scheduledEvents: [
            createScheduledEvent({
              event: ATTIC,
              when: null,
              movement: 'kept',
              changeReason: 'the roof started leaking and it could not wait'
            })
          ]
        }),
        ...ATTIC_ARCHIVE
      ], '2026-08-26')
    ).toEqual([]);
  });

  it('drops a plan once it has been called off', () => {
    expect(
      ledgerOf([
        entry({
          date: '2026-08-21',
          scheduledEvents: [
            createScheduledEvent({
              event: ATTIC,
              when: null,
              movement: 'dropped',
              changeReason: 'his mother decided to keep the boxes where they are'
            })
          ]
        }),
        ...ATTIC_ARCHIVE
      ], '2026-08-26')
    ).toEqual([]);
  });

  it('keeps a rescheduled plan, at its new time', () => {
    const ledger = ledgerOf([
      entry({
        date: '2026-08-21',
        scheduledEvents: [
          createScheduledEvent({
            event: ATTIC,
            when: 'next weekend',
            movement: 'moved',
            changeReason: 'Leo is away for the first half of September'
          })
        ]
      }),
      ...ATTIC_ARCHIVE
    ], '2026-08-26');

    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      when: 'next weekend',
      window: { start: '2026-08-29', end: '2026-08-30' },
      date: '2026-08-21'
    });
  });

  /* Newest statement wins, and an older statement cannot reopen what a newer one closed. */
  it('does not let an older entry reopen a plan a newer one resolved', () => {
    expect(
      ledgerOf([
        entry({
          date: '2026-08-21',
          scheduledEvents: [
            createScheduledEvent({ event: ATTIC, when: null, movement: 'kept', changeReason: null })
          ]
        }),
        entry({
          date: '2026-08-16',
          scheduledEvents: [createScheduledEvent({ event: ATTIC, when: 'next month' })]
        }),
        entry({
          date: '2026-08-11',
          scheduledEvents: [createScheduledEvent({ event: ATTIC, when: 'in two months' })]
        })
      ], '2026-08-26')
    ).toEqual([]);
  });

  it('keeps a plan whose stated time resolves to nothing, with no window on it', () => {
    const ledger = ledgerOf([
      entry({
        date: '2026-08-16',
        scheduledEvents: [createScheduledEvent({ event: ATTIC, when: 'once the weather turns' })]
      })
    ]);

    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ when: 'once the weather turns', window: null });
  });

  it('keeps a plan given no time at all', () => {
    const ledger = ledgerOf([
      entry({
        date: '2026-08-16',
        scheduledEvents: [createScheduledEvent({ event: ATTIC, when: null })]
      })
    ]);

    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ when: null, window: null });
  });

  it('reads only this juror, and only days before the one being written', () => {
    const ledger = ledgerOf([
      entry({
        date: '2026-08-21',
        scheduledEvents: [
          createScheduledEvent({ event: 'today, which has not been written yet', when: 'next month' })
        ]
      }),
      entry({
        date: '2026-08-20',
        jurorId: 'david',
        scheduledEvents: [
          createScheduledEvent({ event: 'taking the lathe apart', when: 'next month' })
        ]
      }),
      ...ATTIC_ARCHIVE
    ]);

    expect(ledger.map((row) => row.event)).toEqual([ATTIC]);
  });

  it('stops at the event cap and at the lookback', () => {
    const events = [
      'clearing out the attic',
      'the dentist appointment',
      'driving Leo to the airport',
      'the neighbours’ barbecue',
      'renewing the tenancy',
      'a weekend in the hills',
      'the eye test'
    ];
    const many = events.map((event, index) =>
      entry({
        date: `2026-08-${String(20 - index).padStart(2, '0')}`,
        scheduledEvents: [createScheduledEvent({ event, when: 'next month' })]
      })
    );

    const ledger = buildDiaryScheduleLedger({ entries: many, jurorId: 'alex', before: '2026-09-01' });
    expect(ledger).toHaveLength(DIARY_SCHEDULE_LEDGER.maxEvents);
    expect(DIARY_SCHEDULE_LEDGER.maxEvents).toBeLessThanOrEqual(DIARY_SCHEDULE_LEDGER.ownEntryLookback);
    // Newest first, so the lookback trims the oldest entries rather than the newest.
    expect(ledger[0].date).toBe('2026-08-20');
    expect(ledger.map((row) => row.event)).toEqual(events.slice(0, DIARY_SCHEDULE_LEDGER.maxEvents));
  });

  /*
   * A lookback long enough to still be holding a "next month" plan when next month arrives. At
   * one duty day in five, twelve own entries is about nine weeks; the plan comes due inside seven.
   */
  it('is still holding a "next month" plan when next month arrives', () => {
    const archive = [
      entry({
        date: '2026-08-16',
        scheduledEvents: [createScheduledEvent({ event: ATTIC, when: 'next month' })]
      }),
      // Ten duty days of silence about the attic, up to the end of the stated window.
      ...Array.from({ length: 10 }, (_, index) =>
        entry({ date: addFive('2026-08-21', index), scheduledEvents: [] })
      )
    ];

    const ledger = ledgerOf(archive, '2026-09-30');
    expect(ledger.map((row) => row.event)).toEqual([ATTIC]);
  });

  /* The archive on the day this ships: every published entry predates the field. */
  it('is empty when no entry has stated a plan', () => {
    expect(ledgerOf([entry({ date: '2026-08-16' }), entry({ date: '2026-08-11' })])).toEqual([]);
  });
});

function addFive(from: string, steps: number): string {
  const base = new Date(`${from}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + steps * 5);
  return base.toISOString().slice(0, 10);
}

describe('coveredWindow', () => {
  /*
   * Duty comes round every fifth day, so an entry is never only about the date at the top of it.
   * Judging a plan kept "tomorrow" against that date alone would report a contradiction on
   * almost every short plan a diarist ever makes.
   */
  it('spans the days since the writer’s own last entry', () => {
    expect(coveredWindow('2026-08-21', '2026-08-16')).toEqual({
      start: '2026-08-17',
      end: '2026-08-21'
    });
  });

  it('narrows to the single day when there is no previous entry', () => {
    expect(coveredWindow('2026-08-21', null)).toEqual({ start: '2026-08-21', end: '2026-08-21' });
  });
});

describe('detectScheduleConflicts', () => {
  const ledger = ledgerOf(ATTIC_ARCHIVE);

  /* The issue, exactly: "next month" on 08-16, and the attic cleared on 08-21. */
  it('flags a plan kept before the window it was given opens', () => {
    const conflicts = detectScheduleConflicts({
      events: [createScheduledEvent({ event: ATTIC, when: null, movement: 'kept' })],
      ledger,
      entryDate: '2026-08-21',
      previousEntryDate: '2026-08-16'
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('early');
    expect(conflicts[0].previous.date).toBe('2026-08-16');
    expect(conflicts[0].previous.when).toBe('next month');
    expect(conflicts[0].covered).toEqual({ start: '2026-08-17', end: '2026-08-21' });
  });

  /* The second acceptance criterion: the same day, allowed, because the entry says it moved. */
  it('accepts the same day when the entry says the plan was brought forward', () => {
    expect(
      detectScheduleConflicts({
        events: [
          createScheduledEvent({
            event: ATTIC,
            when: null,
            movement: 'kept',
            changeReason: 'his mother found water coming through the roof and it could not wait'
          })
        ],
        ledger,
        entryDate: '2026-08-21',
        previousEntryDate: '2026-08-16'
      })
    ).toEqual([]);
  });

  it('says nothing about a plan kept inside its window', () => {
    expect(
      detectScheduleConflicts({
        events: [createScheduledEvent({ event: ATTIC, when: null, movement: 'kept' })],
        ledger,
        entryDate: '2026-09-06',
        previousEntryDate: '2026-09-01'
      })
    ).toEqual([]);
  });

  it('flags a plan kept long after its window closed', () => {
    const conflicts = detectScheduleConflicts({
      events: [createScheduledEvent({ event: ATTIC, when: null, movement: 'kept' })],
      ledger,
      entryDate: '2026-11-10',
      previousEntryDate: '2026-11-05'
    });

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].kind).toBe('late');
  });

  /*
   * The window has to overlap the days the entry covers, not contain the entry's own date. A
   * plan for "tomorrow" is kept the day after it is made, off-page, and told four days later.
   */
  it('accepts a plan kept on a day the entry is catching up on', () => {
    const tomorrow = ledgerOf([
      entry({
        date: '2026-08-16',
        scheduledEvents: [createScheduledEvent({ event: ATTIC, when: 'tomorrow' })]
      })
    ]);

    expect(
      detectScheduleConflicts({
        events: [createScheduledEvent({ event: ATTIC, when: null, movement: 'kept' })],
        ledger: tomorrow,
        entryDate: '2026-08-21',
        previousEntryDate: '2026-08-16'
      })
    ).toEqual([]);
  });

  it('is silent about a plan the ledger has never seen', () => {
    expect(
      detectScheduleConflicts({
        events: [
          createScheduledEvent({ event: 'the dentist appointment', when: null, movement: 'kept' })
        ],
        ledger,
        entryDate: '2026-08-21',
        previousEntryDate: '2026-08-16'
      })
    ).toEqual([]);
    expect(
      detectScheduleConflicts({
        events: [createScheduledEvent({ movement: 'kept', when: null })],
        ledger: [],
        entryDate: '2026-08-21'
      })
    ).toEqual([]);
  });

  /* No window, no accusation. Inventing one is the failure mode this must not have. */
  it('is silent about a plan whose stated time never resolved', () => {
    const vague = ledgerOf([
      entry({
        date: '2026-08-16',
        scheduledEvents: [createScheduledEvent({ event: ATTIC, when: 'once the weather turns' })]
      })
    ]);

    expect(
      detectScheduleConflicts({
        events: [createScheduledEvent({ event: ATTIC, when: null, movement: 'kept' })],
        ledger: vague,
        entryDate: '2026-08-21',
        previousEntryDate: '2026-08-16'
      })
    ).toEqual([]);
  });

  it('checks only the plans this entry says it kept', () => {
    for (const movement of ['made', 'moved', 'dropped']) {
      expect(
        detectScheduleConflicts({
          events: [
            createScheduledEvent({
              event: ATTIC,
              when: 'next week',
              movement,
              changeReason: movement === 'made' ? null : 'the plan changed'
            })
          ],
          ledger,
          entryDate: '2026-08-21',
          previousEntryDate: '2026-08-16'
        }),
        movement
      ).toEqual([]);
    }
  });

  it('matches a plan named with one qualifier fewer than last time', () => {
    const conflicts = detectScheduleConflicts({
      events: [createScheduledEvent({ event: 'clearing out the attic', when: null, movement: 'kept' })],
      ledger,
      entryDate: '2026-08-21',
      previousEntryDate: '2026-08-16'
    });

    expect(conflicts).toHaveLength(1);
  });

  /* Two plans that share only grammar are two plans, as in lib/diary/projects.ts. */
  it('does not read shared grammar as the same plan', () => {
    expect(
      detectScheduleConflicts({
        events: [
          createScheduledEvent({ event: 'clearing out the shed at home', when: null, movement: 'kept' })
        ],
        ledger,
        entryDate: '2026-08-21',
        previousEntryDate: '2026-08-16'
      })
    ).toEqual([]);
  });
});

describe('detectUnexplainedScheduleChanges', () => {
  it('reports a plan moved or dropped with nothing said about why', () => {
    expect(
      detectUnexplainedScheduleChanges([
        createScheduledEvent({ event: ATTIC, when: 'next week', movement: 'moved', changeReason: null }),
        createScheduledEvent({ event: 'the eye test', when: null, movement: 'dropped', changeReason: '  ' })
      ])
    ).toEqual([
      { event: ATTIC, movement: 'moved' },
      { event: 'the eye test', movement: 'dropped' }
    ]);
  });

  it('says nothing when the change is accounted for, or when nothing changed', () => {
    expect(
      detectUnexplainedScheduleChanges([
        createScheduledEvent({
          event: ATTIC,
          when: 'next week',
          movement: 'moved',
          changeReason: 'Leo is away for the first half of September'
        }),
        createScheduledEvent({ event: 'the eye test', when: 'next month', movement: 'made' }),
        createScheduledEvent({ event: 'the dentist', when: null, movement: 'kept' })
      ])
    ).toEqual([]);
  });
});

/*
 * The hole the window check leaves on its own. An entry that quietly re-states a standing plan at
 * a nearer date resets the window, and the entry that then keeps it lands inside the new one and
 * draws no finding — the same contradiction as the issue's, spread over one more entry.
 */
describe('detectRetimedCommitments', () => {
  const ledger = ledgerOf(ATTIC_ARCHIVE);

  it('reports a standing plan restated at a different time as though it were new', () => {
    const retimed = detectRetimedCommitments({
      events: [createScheduledEvent({ event: ATTIC, when: 'this weekend', movement: 'made' })],
      ledger,
      entryDate: '2026-08-21'
    });

    expect(retimed).toHaveLength(1);
    expect(retimed[0].when).toBe('this weekend');
    expect(retimed[0].previous.when).toBe('next month');
  });

  it('says nothing when the entry calls it a move and says why', () => {
    expect(
      detectRetimedCommitments({
        events: [
          createScheduledEvent({
            event: ATTIC,
            when: 'this weekend',
            movement: 'moved',
            changeReason: 'his mother is going into hospital in September'
          })
        ],
        ledger,
        entryDate: '2026-08-21'
      })
    ).toEqual([]);
  });

  it('says nothing when the plan is restated at the same days, however worded', () => {
    for (const when of ['next month', 'in a month', 'sometime next month']) {
      expect(
        detectRetimedCommitments({
          events: [createScheduledEvent({ event: ATTIC, when, movement: 'made' })],
          ledger,
          entryDate: '2026-08-16'
        }),
        when
      ).toEqual([]);
    }
  });

  it('says nothing when either time resolves to no days at all', () => {
    expect(
      detectRetimedCommitments({
        events: [
          createScheduledEvent({ event: ATTIC, when: 'once the weather turns', movement: 'made' })
        ],
        ledger,
        entryDate: '2026-08-21'
      })
    ).toEqual([]);
    expect(
      detectRetimedCommitments({
        events: [createScheduledEvent({ event: ATTIC, when: 'this weekend', movement: 'made' })],
        ledger: ledgerOf([
          entry({
            date: '2026-08-16',
            scheduledEvents: [createScheduledEvent({ event: ATTIC, when: 'once the roof is done' })]
          })
        ]),
        entryDate: '2026-08-21'
      })
    ).toEqual([]);
  });

  it('says nothing about a plan the ledger has never seen', () => {
    expect(
      detectRetimedCommitments({
        events: [createScheduledEvent({ event: 'the eye test', when: 'next week', movement: 'made' })],
        ledger,
        entryDate: '2026-08-21'
      })
    ).toEqual([]);
  });
});
