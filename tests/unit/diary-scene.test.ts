import { describe, it, expect } from 'vitest';
import {
  buildRecentSceneGlances,
  countArgumentLed,
  detectEssayRun,
  isArgumentLed
} from '../../src/lib/diary/scene';
import {
  DIARY_RECENT_CYCLE,
  DiaryEntrySchema,
  type DiaryEntry,
  type DiaryEntryFocus,
  type DiaryTheme
} from '../../src/schemas/diary';
import {
  DIARY_CYCLE_SAMPLE,
  FIXTURE_BODY_EN,
  FIXTURE_BODY_JA,
  createEntryFocus
} from '../helpers/diary-fixtures';

/*
 * Issue #113: Sarah's 2026-08-14 entry argues a product thesis, Marcus's 08-15 a venture
 * thesis. They share no subject, no object and no vocabulary, so neither the arc comparison
 * (#105) nor the centre comparison (#110) can see a repeat. What they share is the mode — a
 * position argued, private detail supplied as evidence, a general principle at the end.
 *
 * This module reads that mode off the writer's own description of its own entry, exactly as
 * focus.ts and projects.ts do, and it can do nothing worse than produce a paragraph of prompt
 * text and a warning.
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
    generation: { model: 'gemini-3.5-flash', promptVersion: 'diary-v7' }
  });
}

/** The failure the issue describes: a position argued, with nothing happening in the entry. */
const ESSAY = createEntryFocus({
  dominantSubject: 'why platform leverage is rent by another name',
  anchorObject: null,
  centralTension: 'My definitions of sustainability are corporate euphemisms.',
  endingState: 'a polished general principle',
  sceneEvent: null,
  interactionLevel: 'reported',
  abstractionLevel: 'argument'
});

describe('isArgumentLed', () => {
  it('flags an argument with nothing happening in it', () => {
    expect(isArgumentLed(ESSAY)).toBe(true);
  });

  /*
   * The case the guidance has to protect. Sarah's is a wholly professional entry in role
   * vocabulary — and it is not this failure, because the argument arrives as something another
   * person said and she has to deal with it.
   */
  it('leaves professional reflection alone when it arose from something that happened', () => {
    const fromAScene = createEntryFocus({
      dominantSubject: 'a scope argument I lost to a number',
      centralTension: 'I wanted the cut to be principled; it was just arithmetic.',
      endingState: 'conceded, and irritated at having conceded',
      sceneEvent: 'Marcus answered with a retention figure I could not argue with',
      interactionLevel: 'direct',
      abstractionLevel: 'mixed'
    });

    expect(isArgumentLed(fromAScene)).toBe(false);
  });

  /*
   * An argument-led day is a legal day. What makes it the issue's failure is that nothing
   * happened in it, so an argument with an event in it is left alone even when the writer says
   * the argument was most of the entry.
   */
  it('leaves an argument alone when somebody else acted inside it', () => {
    expect(
      isArgumentLed(
        createEntryFocus({
          sceneEvent: 'Alex refused the compromise in front of everyone',
          interactionLevel: 'direct',
          abstractionLevel: 'argument'
        })
      )
    ).toBe(false);
  });

  /*
   * And a day spent alone is a day. The prompt calls an uneventful evening on your own a
   * perfectly good entry, so a predicate that flagged one because nobody else was in it would
   * contradict the guidance it exists to support.
   */
  it('leaves an argument alone when the thing that happened happened to one person', () => {
    expect(
      isArgumentLed(
        createEntryFocus({
          sceneEvent: 'the boiler gave out halfway through the evening',
          interactionLevel: 'none',
          abstractionLevel: 'argument'
        })
      )
    ).toBe(false);
  });

  it('reads the level whatever case or padding it arrives in', () => {
    expect(
      isArgumentLed({ sceneEvent: null, interactionLevel: ' None ', abstractionLevel: ' Argument ' })
    ).toBe(true);
  });

  /*
   * An unstated abstraction level is a thing this cannot see, never a thing it may assume the
   * worst about. Every entry written before this shipped is in that position, and so is one
   * whose writer left the field blank.
   */
  it('never flags an entry whose abstraction level was left unstated', () => {
    expect(isArgumentLed({ sceneEvent: null, interactionLevel: '', abstractionLevel: '' })).toBe(
      false
    );
    expect(
      isArgumentLed({ sceneEvent: null, interactionLevel: 'none', abstractionLevel: '  ' })
    ).toBe(false);
  });

  /* The interaction level answers a different question and never decides this one. */
  it('does not consult the interaction level, stated or not', () => {
    for (const interactionLevel of ['none', 'reported', 'direct', '', 'somewhat']) {
      expect(
        isArgumentLed({ sceneEvent: null, interactionLevel, abstractionLevel: 'argument' }),
        `interaction level "${interactionLevel}" changed the verdict`
      ).toBe(true);
    }
  });
});

describe('buildRecentSceneGlances', () => {
  it('reads across all five diarists, newest first, strictly before the day being written', () => {
    const glances = buildRecentSceneGlances({
      entries: [
        entry({ date: '2026-08-25', jurorId: 'marcus', entryFocus: ESSAY }),
        entry({ date: '2026-08-24', jurorId: 'sarah', entryFocus: createEntryFocus() }),
        entry({ date: '2026-08-23', jurorId: 'lisa', entryFocus: ESSAY })
      ],
      before: '2026-08-25'
    });

    expect(glances.map((glance) => glance.jurorId)).toEqual(['sarah', 'lisa']);
    expect(glances[0].date).toBe('2026-08-24');
  });

  it('keeps the window to one rotation', () => {
    const entries = Array.from({ length: 9 }, (_, index) =>
      entry({ date: `2026-08-1${index}`, jurorId: 'alex', entryFocus: createEntryFocus() })
    );

    const glances = buildRecentSceneGlances({ entries, before: '2026-08-20' });

    expect(glances).toHaveLength(DIARY_RECENT_CYCLE.entryCount);
  });

  /*
   * Entries written under diary-v5 and v6 described their centre and had no vocabulary for
   * their scene. Showing them as a row of blanks would fill the cycle with entries that say
   * nothing; scoring them in code would invent the very signal the prompt quotes back.
   */
  it('skips an entry whose scene half was never stated', () => {
    const glances = buildRecentSceneGlances({
      entries: [
        entry({
          date: '2026-08-13',
          jurorId: 'lisa',
          entryFocus: createEntryFocus({
            sceneEvent: null,
            interactionLevel: '',
            abstractionLevel: ''
          })
        }),
        entry({ date: '2026-08-12', jurorId: 'david', entryFocus: null }),
        entry({ date: '2026-08-11', jurorId: 'alex', entryFocus: ESSAY })
      ],
      before: '2026-08-14'
    });

    expect(glances.map((glance) => glance.jurorId)).toEqual(['alex']);
  });

  it('renders a day with no observable event as one, rather than as a missing field', () => {
    const [glance] = buildRecentSceneGlances({
      entries: [entry({ date: '2026-08-11', jurorId: 'alex', entryFocus: ESSAY })],
      before: '2026-08-14'
    });

    expect(glance.sceneEvent).toBeNull();
    expect(glance.abstractionLevel).toBe('argument');
    expect(glance.endingState).toBe('a polished general principle');
  });
});

describe('detectEssayRun', () => {
  function cycle(focuses: DiaryEntryFocus[]) {
    const jurors = ['alex', 'david', 'lisa', 'sarah', 'marcus'];
    return buildRecentSceneGlances({
      entries: focuses.map((focus, index) =>
        entry({ date: `2026-08-2${index}`, jurorId: jurors[index], entryFocus: focus })
      ),
      before: '2026-09-01'
    });
  }

  it('says nothing until the run is a majority of the rotation', () => {
    const scene = createEntryFocus();
    expect(detectEssayRun(cycle([ESSAY, ESSAY, scene, scene, scene]))).toBeNull();
  });

  it('names the run and the diarists in it once it is', () => {
    const run = detectEssayRun(cycle([ESSAY, ESSAY, ESSAY, createEntryFocus(), createEntryFocus()]));

    expect(run).not.toBeNull();
    expect(run?.count).toBe(DIARY_RECENT_CYCLE.essayRun);
    expect(run?.total).toBe(5);
    // Newest first, and distinct: the point of the finding is that it is not one persona.
    expect(run?.jurorIds).toEqual(['lisa', 'david', 'alex']);
  });

  it('reports nothing about an archive that has no scene records at all', () => {
    expect(detectEssayRun([])).toBeNull();
  });
});

/*
 * The documented five-juror sample (issue #113, acceptance criteria 3 and 4), asserted rather
 * than described, so a change to the guidance that quietly loosens it fails here.
 */
describe('the documented five-juror sample', () => {
  it('covers one full rotation, one entry each', () => {
    expect(DIARY_CYCLE_SAMPLE).toHaveLength(5);
    expect(new Set(DIARY_CYCLE_SAMPLE.map((sample) => sample.jurorId)).size).toBe(5);
  });

  /*
   * "An observable event changes, complicates, or resists the character's initial
   * interpretation" — read here as an entry with something happening in it that its writer did
   * not resolve into the position it started from.
   */
  it('contains at least three entries whose event complicates the writer’s reading of it', () => {
    const complicated = DIARY_CYCLE_SAMPLE.filter(
      (sample) => !isArgumentLed(sample.focus) && (sample.focus.sceneEvent?.length ?? 0) > 0
    );

    expect(complicated.length).toBeGreaterThanOrEqual(3);
    expect(complicated.map((sample) => sample.jurorId)).toEqual(['alex', 'david', 'sarah']);
  });

  it('ends at least two of them on a consequence or an answer rather than a maxim', () => {
    const unresolved = DIARY_CYCLE_SAMPLE.filter((sample) =>
      /draft box|screw short|conceded/.test(sample.focus.endingState)
    );

    expect(unresolved.length).toBeGreaterThanOrEqual(2);
  });

  /* Professional reflection is not the failure; professional reflection with no day is. */
  it('keeps a wholly professional entry out of the count when it arose from a scene', () => {
    const sarah = DIARY_CYCLE_SAMPLE.find((sample) => sample.jurorId === 'sarah');

    expect(sarah?.focus.centralTension).toMatch(/principled/);
    expect(isArgumentLed(sarah!.focus)).toBe(false);
  });

  it('leaves the sample cycle alone, and names the run once a third essay lands', () => {
    const modes = DIARY_CYCLE_SAMPLE.map((sample) => sample.focus);

    expect(countArgumentLed(modes)).toBe(DIARY_RECENT_CYCLE.essayRun - 1);
    expect(countArgumentLed([...modes, ESSAY])).toBe(DIARY_RECENT_CYCLE.essayRun);
  });
});
