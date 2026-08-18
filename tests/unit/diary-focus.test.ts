import { describe, it, expect } from 'vitest';
import { detectRecurringFocus, termsOf } from '../../src/lib/diary/focus';
import { createEntryFocus } from '../helpers/diary-fixtures';

/*
 * Issue #110: Alex wrote 2026-08-01, 08-06 and 08-11 about the Hermes Baby ribbon and the same
 * friction-versus-practicality argument. The newest was the best written of the three, so this
 * detector is not looking for a regression — it is looking for a subject that has stopped
 * moving, and its whole output is how firmly one prompt paragraph is worded.
 *
 * Two properties matter more than the matching itself:
 *   - it reads only the four central-role fields, never a body, so a prop that merely appears
 *     cannot trigger it;
 *   - a hit is never a rejection. Nothing downstream of this can fail a day.
 */

const RIBBON = createEntryFocus({
  dominantSubject: 'replacing the ribbon on the Hermes Baby',
  anchorObject: 'the Hermes Baby typewriter',
  centralTension: 'Manual friction gives a hobby its soul but has no place in software.',
  endingState: 'settled into a lesson'
});

describe('detectRecurringFocus', () => {
  it('reports the object two consecutive entries both centred on', () => {
    const recurrence = detectRecurringFocus([
      RIBBON,
      createEntryFocus({
        dominantSubject: 'a failed ribbon change',
        anchorObject: 'the Hermes Baby typewriter',
        centralTension: 'You cannot optimize your way out of manual mechanics.',
        endingState: 'resigned'
      })
    ]);

    expect(recurrence).not.toBeNull();
    expect(recurrence?.sharedSubjectTerms).toEqual(
      expect.arrayContaining(['ribbon', 'hermes', 'baby', 'typewriter'])
    );
  });

  it('reports a repeated argument even when the subject moved on', () => {
    const recurrence = detectRecurringFocus([
      createEntryFocus({
        dominantSubject: 'Leo asking whether to rebuild the marketplace',
        anchorObject: null,
        centralTension: 'Ritual friction is worth keeping; software friction is not.',
        endingState: 'left open'
      }),
      RIBBON
    ]);

    // Different subject, same thesis: a milder repeat, and the prompt says which half repeated.
    expect(recurrence?.sharedSubjectTerms).toEqual([]);
    expect(recurrence?.sharedTensionTerms).toEqual(expect.arrayContaining(['friction']));
  });

  it('stays silent when two entries share nothing central', () => {
    expect(
      detectRecurringFocus([
        createEntryFocus({
          dominantSubject: 'a phone call with Leo about his marketplace',
          anchorObject: null,
          centralTension: 'Advising a friend for free costs more than it looks.',
          endingState: 'unfinished — he never called back'
        }),
        RIBBON
      ])
    ).toBeNull();
  });

  /*
   * The archive on the day this ships: entries exist, none carry a focus. One is also all a
   * juror has after their first duty day under this prompt. Neither is a recurrence.
   */
  it('needs two focus records before it will report anything', () => {
    expect(detectRecurringFocus([])).toBeNull();
    expect(detectRecurringFocus([RIBBON])).toBeNull();
  });

  /*
   * Vocabulary shared by any two English sentences must not register, or the escalation fires
   * every single day and stops carrying information.
   */
  it('does not read grammar as a shared subject', () => {
    expect(
      detectRecurringFocus([
        createEntryFocus({
          dominantSubject: 'the day that the kitchen tap finally gave up',
          anchorObject: null,
          centralTension: 'What you have been putting off has been deciding things for you.',
          endingState: 'still dripping'
        }),
        createEntryFocus({
          dominantSubject: 'a walk that was much longer than it should have been',
          anchorObject: null,
          centralTension: 'You can be very sure about something and still be wrong about it.',
          endingState: 'quietly pleased'
        })
      ])
    ).toBeNull();
  });

  it('treats a plural and its singular as one subject, worded as the newest entry worded it', () => {
    const recurrence = detectRecurringFocus([
      createEntryFocus({ dominantSubject: 'sorting the ribbons', anchorObject: null }),
      createEntryFocus({ dominantSubject: 'one ribbon, badly threaded', anchorObject: null })
    ]);

    expect(recurrence?.sharedSubjectTerms).toEqual(['ribbons']);
  });

  /*
   * The distinction the issue turns on: same object, different role. A day *about* the ribbon
   * followed by a day where the typewriter merely sits on the desk is the outcome this whole
   * change is trying to produce, so the ribbon must not appear in a central-role field for it.
   */
  it('sees only the central role, never a prop that is simply present', () => {
    const backgroundDay = createEntryFocus({
      dominantSubject: "Leo's decision about the marketplace, taken without me",
      anchorObject: null,
      centralTension: 'Being consulted and being listened to are different things.',
      endingState: 'annoyed, and aware that is unfair'
    });

    expect(detectRecurringFocus([backgroundDay, RIBBON])).toBeNull();
  });
});

describe('termsOf', () => {
  it('drops punctuation, case and words too short to be a subject', () => {
    expect([...termsOf('The Hermes Baby — its ribbon, again.').values()]).toEqual([
      'hermes',
      'baby',
      'ribbon'
    ]);
  });

  /*
   * The fold is for matching only. "Hermes" keys as "herme" so a plural cannot split a subject
   * in two, but the prompt quotes these words back at the writer, and reading a stem out loud
   * would make the instruction look broken.
   */
  it('keeps the word as written even when the fold mangles it', () => {
    const terms = termsOf('Hermes');
    expect(terms.get('herme')).toBe('hermes');
  });

  it('leaves a word that merely ends in s alone', () => {
    expect([...termsOf('business').values()]).toEqual(['business']);
  });
});
