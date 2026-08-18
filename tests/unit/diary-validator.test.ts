import { describe, it, expect } from 'vitest';
import { validateDiaryResponse, japaneseCharacterRatio } from '../../src/lib/diary/validator';
import {
  createDiaryResponse,
  createEntryFocus,
  createProjectUpdate,
  FIXTURE_BODY_EN
} from '../helpers/diary-fixtures';
import { DIARY_PATCH_LIMITS, type DiaryResponse } from '../../src/schemas/diary';
import type { DiaryProjectLedgerRow } from '../../src/lib/diary/projects';
import type { DiarySceneMode } from '../../src/lib/diary/scene';

const expected = {
  date: '2026-08-02',
  jurorId: 'david',
  theme: 'mixed',
  privateEventCategory: 'small_success'
} as const;

function validate(
  response: unknown,
  allowedReviewSlugs: string[] = [],
  readingTargetId: string | null = null
) {
  return validateDiaryResponse({
    parsed: response,
    expected: { ...expected, allowedReviewSlugs, readingTargetId }
  });
}

function codes(findings: Array<{ code: string }>): string[] {
  return findings.map((finding) => finding.code);
}

describe('diary structural validator', () => {
  it('passes a well-formed response', () => {
    const verdict = validate(createDiaryResponse());
    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    expect(verdict.response).not.toBeNull();
  });

  it('rejects a response that is not JSON at all', () => {
    const verdict = validate(null);
    expect(verdict.status).toBe('failed');
    expect(codes(verdict.errors)).toContain('DIARY_RESPONSE_NOT_JSON');
  });

  it('rejects a missing required field', () => {
    const response = createDiaryResponse() as Record<string, unknown>;
    delete response.memoryCandidate;
    const verdict = validate(response);
    expect(verdict.status).toBe('failed');
    expect(codes(verdict.errors)).toContain('DIARY_SCHEMA_VALIDATION_FAILED');
  });

  it('requires both languages for every text field', () => {
    for (const field of ['title', 'body', 'mood', 'shareQuote'] as const) {
      for (const lang of ['en', 'ja'] as const) {
        const response = createDiaryResponse();
        response.diary[field][lang] = '   ';
        const verdict = validate(response);
        expect(verdict.status).toBe('failed');
        expect(codes(verdict.errors)).toContain('DIARY_MISSING_LANGUAGE');
      }
    }
  });

  it('rejects an English body pasted into the Japanese field', () => {
    const response = createDiaryResponse();
    response.diary.body.ja = FIXTURE_BODY_EN;
    const verdict = validate(response);
    expect(verdict.status).toBe('failed');
    expect(codes(verdict.errors)).toContain('DIARY_JAPANESE_NOT_TRANSLATED');
  });

  it('rejects a stub translation', () => {
    const response = createDiaryResponse();
    response.diary.body.ja = 'はい。';
    const verdict = validate(response);
    expect(verdict.status).toBe('failed');
    expect(codes(verdict.errors)).toContain('DIARY_BODY_TOO_SHORT');
  });

  it('rejects a body far too short to be a diary', () => {
    const response = createDiaryResponse();
    response.diary.body.en = 'Nothing happened today.';
    const verdict = validate(response);
    expect(verdict.status).toBe('failed');
    expect(codes(verdict.errors)).toContain('DIARY_BODY_TOO_SHORT');
  });

  it('rejects an identity that disagrees with the day the code assigned', () => {
    const wrongJuror = validate(createDiaryResponse({ jurorId: 'alex' }));
    expect(codes(wrongJuror.errors)).toContain('DIARY_IDENTITY_MISMATCH');

    const wrongDate = validate(createDiaryResponse({ date: '2026-08-09' }));
    expect(codes(wrongDate.errors)).toContain('DIARY_IDENTITY_MISMATCH');

    const wrongTheme = validate(createDiaryResponse({ theme: 'work' }));
    expect(codes(wrongTheme.errors)).toContain('DIARY_IDENTITY_MISMATCH');

    const wrongCategory = validate(createDiaryResponse({ privateEventCategory: 'weather' }));
    expect(codes(wrongCategory.errors)).toContain('DIARY_EVENT_CATEGORY_MISMATCH');
  });

  it('rejects a relationship patch aimed at an unknown juror', () => {
    const response = createDiaryResponse({
      relationshipPatches: [
        {
          targetJurorId: 'ethan',
          trustDelta: 0.01,
          respectDelta: 0,
          tensionDelta: 0,
          currentView: 'fixture',
          unresolvedIncident: null,
          reason: 'fixture'
        }
      ]
    });
    const verdict = validate(response);
    expect(verdict.status).toBe('failed');
    expect(codes(verdict.errors)).toContain('DIARY_UNKNOWN_RELATIONSHIP_TARGET');
  });

  it('rejects a juror holding a relationship with themselves', () => {
    const verdict = validate(
      createDiaryResponse({
        relationshipPatches: [
          {
            targetJurorId: 'david',
            trustDelta: 0.01,
            respectDelta: 0,
            tensionDelta: 0,
            currentView: 'fixture',
            unresolvedIncident: null,
            reason: 'fixture'
          }
        ]
      })
    );
    expect(codes(verdict.errors)).toContain('DIARY_SELF_RELATIONSHIP');
  });

  /**
   * The core anti-lurch rule. An overshoot fails the day rather than being quietly clamped:
   * clamped state would look plausible and hide a prompt regression (brief §10.2).
   */
  it('rejects deltas beyond one day of movement instead of clamping them', () => {
    const verdict = validate(
      createDiaryResponse({
        relationshipPatches: [
          {
            targetJurorId: 'sarah',
            trustDelta: 0.4,
            respectDelta: 0,
            tensionDelta: 0,
            currentView: 'fixture',
            unresolvedIncident: null,
            reason: 'fixture'
          }
        ]
      })
    );
    expect(verdict.status).toBe('failed');
    expect(codes(verdict.errors)).toContain('DIARY_DELTA_OUT_OF_BOUNDS');
    expect(verdict.response).toBeNull();
  });

  it('accepts a delta exactly on the boundary despite float representation', () => {
    const verdict = validate(
      createDiaryResponse({
        relationshipPatches: [
          {
            targetJurorId: 'sarah',
            trustDelta: 0.05,
            respectDelta: -0.05,
            tensionDelta: 0.050000000000000003,
            currentView: 'fixture',
            unresolvedIncident: null,
            reason: 'fixture'
          }
        ]
      })
    );
    expect(verdict.status).toBe('passed');
  });

  it('rejects patching more than two relationships in one day', () => {
    const patch = (targetJurorId: string) => ({
      targetJurorId,
      trustDelta: 0.01,
      respectDelta: 0,
      tensionDelta: 0,
      currentView: 'fixture',
      unresolvedIncident: null,
      reason: 'fixture'
    });
    const verdict = validate(
      createDiaryResponse({
        relationshipPatches: [patch('alex'), patch('lisa'), patch('sarah')]
      })
    );
    expect(codes(verdict.errors)).toContain('DIARY_PATCH_LIMIT_EXCEEDED');
  });

  it('rejects the same juror being patched twice in one day', () => {
    const patch = () => ({
      targetJurorId: 'alex',
      trustDelta: 0.01,
      respectDelta: 0,
      tensionDelta: 0,
      currentView: 'fixture',
      unresolvedIncident: null,
      reason: 'fixture'
    });
    const verdict = validate(createDiaryResponse({ relationshipPatches: [patch(), patch()] }));
    expect(codes(verdict.errors)).toContain('DIARY_DUPLICATE_RELATIONSHIP_TARGET');
  });

  it('rejects more than one memory or canon candidate by shape, and bounds their values', () => {
    const badImportance = validate(
      createDiaryResponse({
        memoryCandidate: { summary: 'fixture memory', importance: 4, tags: [] }
      })
    );
    expect(codes(badImportance.errors)).toContain('DIARY_IMPORTANCE_OUT_OF_BOUNDS');

    const badFactType = validate(
      createDiaryResponse({
        canonCandidate: { factType: 'spouse', fact: 'fixture fact', reason: 'fixture' }
      })
    );
    expect(codes(badFactType.errors)).toContain('DIARY_UNKNOWN_CANON_FACT_TYPE');
  });

  it('rejects too many additions to recent concerns or unresolved thoughts', () => {
    const response = createDiaryResponse();
    response.characterStatePatch.addRecentConcerns = ['a', 'b', 'c'];
    response.characterStatePatch.addUnresolvedThoughts = ['a', 'b', 'c'];
    const verdict = validate(response);
    expect(verdict.status).toBe('failed');
    expect(codes(verdict.errors).filter((code) => code === 'DIARY_PATCH_LIMIT_EXCEEDED')).toHaveLength(2);
  });

  /**
   * Core Persona has no writable representation anywhere in JuryDiary. A response that invents
   * a field for editing it is rejected outright rather than silently ignored.
   */
  it('rejects a response that invents a top-level field, such as a persona edit', () => {
    const response = {
      ...createDiaryResponse(),
      corePersonaPatch: { background: 'rewritten' }
    };
    const verdict = validate(response);
    expect(verdict.status).toBe('failed');
    expect(codes(verdict.errors)).toContain('DIARY_SCHEMA_VALIDATION_FAILED');
  });

  it('drops review references that were never offered, as a warning rather than a failure', () => {
    const verdict = validate(
      createDiaryResponse({ relatedReviewIds: ['offered-slug', 'invented-slug'] }),
      ['offered-slug']
    );
    expect(verdict.status).toBe('passed');
    expect(codes(verdict.warnings)).toContain('DIARY_UNKNOWN_REVIEW_REFERENCE');
    expect(verdict.response?.relatedReviewIds).toEqual(['offered-slug']);
  });

  it('warns but still publishes when the share quote is not a verbatim span', () => {
    const response = createDiaryResponse();
    response.diary.shareQuote.en = 'A sentence that appears nowhere in the body at all.';
    const verdict = validate(response);
    expect(verdict.status).toBe('passed');
    expect(codes(verdict.warnings)).toContain('DIARY_SHARE_QUOTE_NOT_IN_BODY');
  });

  it('does not reject a diary for being dull or self-contradictory', () => {
    const response = createDiaryResponse();
    response.diary.body.en =
      'Nothing much happened. I made coffee and did not drink it. I like living alone, ' +
      'though the flat felt unusually empty tonight, which is not a thing I would say out loud. ' +
      'I read half a page of a manual and put it down again. The radio stayed switched off. ' +
      'I have no verdict about any of it and I am not going to invent one for the sake of a diary entry. ' +
      'Tomorrow will almost certainly be the same, and that is genuinely fine by me.';
    response.contradictionNotes = [
      {
        previousState: 'I prefer living alone.',
        currentState: 'The apartment felt unusually empty tonight.',
        interpretation: 'Emotional tension, not a canon change.'
      }
    ];
    const verdict = validate(response);
    expect(verdict.status).toBe('passed');
  });

  /**
   * A reply may only point at the entry code actually handed over. Anything else would be a
   * thread the archive does not contain.
   */
  it('rejects a response to an entry that was never assigned', () => {
    const verdict = validate(
      createDiaryResponse({ respondsTo: { diaryId: 'diary-2026-08-01-alex' } }),
      [],
      null
    );
    expect(verdict.status).toBe('failed');
    expect(codes(verdict.errors)).toContain('DIARY_UNEXPECTED_RESPONSE');
  });

  it('rejects a response aimed at a different entry than the one assigned', () => {
    const verdict = validate(
      createDiaryResponse({ respondsTo: { diaryId: 'diary-2026-08-01-alex' } }),
      [],
      'diary-2026-07-30-lisa'
    );
    expect(verdict.status).toBe('failed');
    expect(codes(verdict.errors)).toContain('DIARY_RESPONSE_TARGET_MISMATCH');
  });

  it('accepts a response to the assigned entry', () => {
    const verdict = validate(
      createDiaryResponse({ respondsTo: { diaryId: 'diary-2026-07-30-lisa' } }),
      [],
      'diary-2026-07-30-lisa'
    );
    expect(verdict.status).toBe('passed');
    expect(verdict.response?.respondsTo?.diaryId).toBe('diary-2026-07-30-lisa');
  });

  it('allows a juror to read something and have nothing to say about it', () => {
    const verdict = validate(createDiaryResponse({ respondsTo: null }), [], 'diary-2026-07-30-lisa');
    expect(verdict.status).toBe('passed');
    expect(codes(verdict.warnings)).toContain('DIARY_RESPONSE_DECLINED');
  });

  it('measures Japanese script share', () => {
    expect(japaneseCharacterRatio('これは日本語です')).toBeGreaterThan(0.9);
    expect(japaneseCharacterRatio('This is English.')).toBe(0);
    expect(japaneseCharacterRatio('')).toBe(0);
  });
});

describe('diary validator normalization', () => {
  it('returns a normalized response with dropped references and truncated notes', () => {
    const note = (n: number) => ({
      previousState: `previous ${n}`,
      currentState: `current ${n}`,
      interpretation: `interpretation ${n}`
    });
    const verdict = validate(
      createDiaryResponse({
        contradictionNotes: [note(1), note(2), note(3), note(4)]
      })
    );
    expect(verdict.status).toBe('passed');
    expect(verdict.response?.contradictionNotes).toHaveLength(3);
    expect(codes(verdict.warnings)).toContain('DIARY_CONTRADICTION_NOTES_TRUNCATED');
  });

  it('never returns a response when it failed', () => {
    const verdict = validate(createDiaryResponse({ jurorId: 'lisa' }) as DiaryResponse);
    expect(verdict.status).toBe('failed');
    expect(verdict.response).toBeNull();
  });
});

/*
 * Issue #110 added `entryFocus`, whose only consumer is the next prompt. Nothing about it may
 * decide publication: a diary is never rejected for what it says about itself, any more than
 * for being dull. These tests pin that it warns and normalizes, and never fails a day.
 */
describe('validateDiaryResponse — entry focus (issue #110)', () => {
  it('accepts a described entry and keeps the description', () => {
    const verdict = validate(
      createDiaryResponse({
        entryFocus: createEntryFocus({
          dominantSubject: 'a repair nobody asked for',
          anchorObject: 'the workbench radio',
          centralTension: 'Fixing something unasked is easier than speaking up.',
          endingState: 'unresolved'
        })
      })
    );

    expect(verdict.status).toBe('passed');
    expect(verdict.warnings).toEqual([]);
    expect(verdict.response?.entryFocus.anchorObject).toBe('the workbench radio');
  });

  it('warns on a blank field and still publishes the day', () => {
    const verdict = validate(
      createDiaryResponse({
        entryFocus: createEntryFocus({
          dominantSubject: '',
          anchorObject: null,
          centralTension: '   ',
          endingState: 'unresolved'
        })
      })
    );

    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    expect(verdict.warnings.map((finding) => finding.code)).toContain(
      'DIARY_ENTRY_FOCUS_INCOMPLETE'
    );
    // Named fields, so the warning says which context tomorrow lost.
    expect(verdict.warnings[0].message).toContain('dominantSubject');
    expect(verdict.warnings[0].message).toContain('centralTension');
  });

  /*
   * "" and null both mean the day had no object at its centre. Storing two spellings of that
   * would make the next prompt render an empty anchor line instead of "(none)".
   */
  it('folds a blank anchor object to null, and does not warn about it', () => {
    const verdict = validate(
      createDiaryResponse({
        entryFocus: createEntryFocus({
          dominantSubject: '  a phone call that went badly  ',
          anchorObject: '  ',
          centralTension: 'Being right did not help.',
          endingState: 'still annoyed',
          sceneEvent: '  she hung up before I finished the sentence  ',
          interactionLevel: 'Direct',
          abstractionLevel: 'scene'
        })
      })
    );

    expect(verdict.status).toBe('passed');
    expect(verdict.warnings).toEqual([]);
    expect(verdict.response?.entryFocus).toEqual({
      dominantSubject: 'a phone call that went badly',
      anchorObject: null,
      centralTension: 'Being right did not help.',
      endingState: 'still annoyed',
      sceneEvent: 'she hung up before I finished the sentence',
      // Case-folded, so "Direct" and "direct" reach the next prompt as one value.
      interactionLevel: 'direct',
      abstractionLevel: 'scene'
    });
  });
});

/*
 * Issue #111 added `projectUpdates`, which is read by the next prompt and by nothing else. So
 * every rule about it is a warning, including the one this issue is named for: a bookcase that
 * went back to its third coat of varnish is a duller archive, not a broken one, and the day
 * publishes. These tests pin that, and pin the normalization the next prompt depends on.
 */
describe('validateDiaryResponse — project continuity (issue #111)', () => {
  const BOOKCASE_LEDGER: DiaryProjectLedgerRow[] = [
    {
      project: 'the cedar bookcase',
      stage: 'third coat of varnish applied',
      movement: 'advanced',
      date: '2026-08-02'
    }
  ];

  function validateAgainst(response: unknown, knownProjects: DiaryProjectLedgerRow[] = []) {
    return validateDiaryResponse({
      parsed: response,
      expected: { ...expected, allowedReviewSlugs: [], readingTargetId: null, knownProjects }
    });
  }

  it('keeps a well-formed update and says nothing about it', () => {
    const verdict = validateAgainst(createDiaryResponse());

    expect(verdict.status).toBe('passed');
    expect(verdict.warnings).toEqual([]);
    expect(verdict.response?.projectUpdates).toEqual([createProjectUpdate()]);
  });

  /* The sequence from the issue: the same stage again, ten days and one entry later. */
  it('warns when a project returns to a stage the archive already reached', () => {
    const verdict = validateAgainst(
      createDiaryResponse({
        projectUpdates: [
          {
            project: 'the cedar bookcase',
            stage: 'third coat of varnish',
            movement: 'advanced'
          }
        ]
      }),
      BOOKCASE_LEDGER
    );

    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    expect(codes(verdict.warnings)).toContain('DIARY_PROJECT_STAGE_REPEATED');
    // The finding has to be readable months later, so it names the entry it disagrees with.
    expect(verdict.warnings[0].message).toContain('2026-08-02');
    expect(verdict.warnings[0].message).toContain('third coat of varnish applied');
  });

  it('says nothing when the entry explains what undid the project', () => {
    const verdict = validateAgainst(
      createDiaryResponse({
        projectUpdates: [
          {
            project: 'the cedar bookcase',
            stage: 'third coat of varnish',
            movement: 'restarted'
          }
        ]
      }),
      BOOKCASE_LEDGER
    );

    expect(verdict.warnings).toEqual([]);
  });

  it('says nothing when the project actually moved', () => {
    const verdict = validateAgainst(
      createDiaryResponse({
        projectUpdates: [
          {
            project: 'the cedar bookcase',
            stage: 'fourth coat applied and the hardware fitted',
            movement: 'advanced'
          }
        ]
      }),
      BOOKCASE_LEDGER
    );

    expect(verdict.warnings).toEqual([]);
  });

  it('drops a movement it has no rule for, and keeps the day', () => {
    const verdict = validateAgainst(
      createDiaryResponse({
        projectUpdates: [createProjectUpdate({ movement: 'in progress' })]
      })
    );

    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    expect(codes(verdict.warnings)).toContain('DIARY_UNKNOWN_PROJECT_MOVEMENT');
    // Named, so a prompt wording that induces the wrong word is diagnosable from the record.
    expect(verdict.warnings[0].message).toContain('in progress');
    expect(verdict.response?.projectUpdates).toEqual([]);
  });

  it('drops an update that names no project or no stage', () => {
    const verdict = validateAgainst(
      createDiaryResponse({
        projectUpdates: [
          createProjectUpdate({ project: '   ' }),
          createProjectUpdate({ stage: '' }),
          createProjectUpdate()
        ]
      })
    );

    expect(verdict.status).toBe('passed');
    expect(codes(verdict.warnings)).toContain('DIARY_PROJECT_UPDATE_INCOMPLETE');
    expect(verdict.response?.projectUpdates).toEqual([createProjectUpdate()]);
  });

  it('trims and lowercases what it keeps, so the next prompt reads one spelling', () => {
    const verdict = validateAgainst(
      createDiaryResponse({
        projectUpdates: [
          { project: '  the cedar bookcase  ', stage: '  fourth coat  ', movement: 'Advanced' }
        ]
      })
    );

    expect(verdict.response?.projectUpdates).toEqual([
      { project: 'the cedar bookcase', stage: 'fourth coat', movement: 'advanced' }
    ]);
  });

  /* Truncated, not fatal — the same treatment contradictionNotes gets, for the same reason. */
  it('truncates an over-long list instead of failing the day', () => {
    const tooMany = Array.from({ length: DIARY_PATCH_LIMITS.projectUpdates + 2 }, (_, index) =>
      createProjectUpdate({ project: `project ${'x'.repeat(index + 3)}`, stage: `stage ${index}` })
    );
    const verdict = validateAgainst(createDiaryResponse({ projectUpdates: tooMany }));

    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    expect(codes(verdict.warnings)).toContain('DIARY_PROJECT_UPDATES_TRUNCATED');
    expect(verdict.response?.projectUpdates).toHaveLength(DIARY_PATCH_LIMITS.projectUpdates);
  });

  /*
   * A caller with no ledger — every day generated before this shipped, and any juror whose
   * archive carries no project yet — must not produce a complaint about a stage nobody stated.
   */
  it('has nothing to say when no ledger was supplied', () => {
    const verdict = validateDiaryResponse({
      parsed: createDiaryResponse({
        projectUpdates: [
          { project: 'the cedar bookcase', stage: 'third coat of varnish', movement: 'advanced' }
        ]
      }),
      expected: { ...expected, allowedReviewSlugs: [], readingTargetId: null }
    });

    expect(verdict.status).toBe('passed');
    expect(verdict.warnings).toEqual([]);
  });

  it('accepts an entry that moved no project at all', () => {
    const verdict = validateAgainst(createDiaryResponse({ projectUpdates: [] }), BOOKCASE_LEDGER);

    expect(verdict.status).toBe('passed');
    expect(verdict.warnings).toEqual([]);
    expect(verdict.response?.projectUpdates).toEqual([]);
  });
});

/*
 * Issue #113 added three scene fields to `entryFocus`, and one advisory over them. Both keep
 * the standing rule of this file: nothing about how an entry describes itself may decide
 * publication. A model that argued a position all day is publishing that day.
 */
describe('validateDiaryResponse — the scene half of the focus (issue #113)', () => {
  /** An entry that argued a position with nothing happening in it. */
  const ARGUED = createEntryFocus({
    sceneEvent: null,
    interactionLevel: 'none',
    abstractionLevel: 'argument'
  });

  /** The cycle the prompt showed this juror, as the run step re-derives it before applying. */
  function validateAgainst(response: unknown, recentScenes: DiarySceneMode[] = []) {
    return validateDiaryResponse({
      parsed: response,
      expected: { ...expected, allowedReviewSlugs: [], readingTargetId: null, recentScenes }
    });
  }

  it('sets aside a level it cannot read, names it, and still publishes', () => {
    const verdict = validate(
      createDiaryResponse({
        entryFocus: createEntryFocus({ interactionLevel: 'somewhat', abstractionLevel: 'scene' })
      })
    );

    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    const finding = verdict.warnings.find((warning) => warning.code === 'DIARY_UNKNOWN_FOCUS_LEVEL');
    expect(finding?.path).toBe('$.entryFocus.interactionLevel');
    expect(finding?.message).toContain('somewhat');
    expect(finding?.message).toContain('none, reported, direct');
    expect(verdict.response?.entryFocus.interactionLevel).toBe('');
    // The one it could read is kept.
    expect(verdict.response?.entryFocus.abstractionLevel).toBe('scene');
  });

  /* One defect, one finding: an unreadable level must not also be reported as a blank one. */
  it('does not also call an unreadable level a blank one', () => {
    const verdict = validate(
      createDiaryResponse({ entryFocus: createEntryFocus({ abstractionLevel: 'essayish' }) })
    );

    expect(verdict.warnings.map((warning) => warning.code)).toEqual(['DIARY_UNKNOWN_FOCUS_LEVEL']);
  });

  /*
   * The response schema asks for all seven focus fields, because a fully-populated envelope is
   * what a Flash model answers most reliably. A response that omits one of the three added here
   * must still publish: these fields reach tomorrow's prompt and nothing else, and a lost day is
   * the one cost they may never impose.
   */
  it('publishes a response that omitted the scene fields entirely', () => {
    const response = createDiaryResponse() as Record<string, unknown>;
    const focus = { ...(response.entryFocus as Record<string, unknown>) };
    delete focus.sceneEvent;
    delete focus.interactionLevel;
    delete focus.abstractionLevel;

    const verdict = validate({ ...response, entryFocus: focus });

    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    expect(verdict.response?.entryFocus.sceneEvent).toBeNull();
    expect(verdict.response?.entryFocus.interactionLevel).toBe('');
    const finding = verdict.warnings.find(
      (warning) => warning.code === 'DIARY_ENTRY_FOCUS_INCOMPLETE'
    );
    expect(finding?.message).toContain('interactionLevel');
    expect(finding?.message).toContain('abstractionLevel');
  });

  /* The older four keep their standing: an entry naming no subject is a defective shape. */
  it('still fails a response that omitted the fields describing its centre', () => {
    const response = createDiaryResponse() as Record<string, unknown>;
    const focus = { ...(response.entryFocus as Record<string, unknown>) };
    delete focus.dominantSubject;

    const verdict = validate({ ...response, entryFocus: focus });

    expect(verdict.status).toBe('failed');
    expect(codes(verdict.errors)).toContain('DIARY_SCHEMA_VALIDATION_FAILED');
  });

  it('warns when a level is left blank, and says which', () => {
    const verdict = validate(
      createDiaryResponse({ entryFocus: createEntryFocus({ abstractionLevel: '  ' }) })
    );

    expect(verdict.status).toBe('passed');
    const finding = verdict.warnings.find(
      (warning) => warning.code === 'DIARY_ENTRY_FOCUS_INCOMPLETE'
    );
    expect(finding?.message).toContain('abstractionLevel');
  });

  /* A null sceneEvent is one of its two honest answers, not a missing field. */
  it('treats a day with no observable event as described, not as incomplete', () => {
    const verdict = validate(createDiaryResponse({ entryFocus: ARGUED }));

    expect(verdict.status).toBe('passed');
    expect(verdict.warnings.map((warning) => warning.code)).not.toContain(
      'DIARY_ENTRY_FOCUS_INCOMPLETE'
    );
    expect(verdict.response?.entryFocus.sceneEvent).toBeNull();
  });

  /*
   * The advisory fires on a run, never on a day. An argument-led entry is a legitimate diary
   * day; warning about one on its own would be the quality opinion this gate is not allowed to
   * hold.
   */
  it('says nothing about an argument-led day that stands alone', () => {
    const verdict = validateAgainst(createDiaryResponse({ entryFocus: ARGUED }), [
      createEntryFocus(),
      createEntryFocus()
    ]);

    expect(verdict.warnings.map((warning) => warning.code)).not.toContain('DIARY_ENTRY_ESSAY_RUN');
  });

  it('reports the run once today completes it, and publishes the day anyway', () => {
    const verdict = validateAgainst(createDiaryResponse({ entryFocus: ARGUED }), [
      ARGUED,
      createEntryFocus(),
      ARGUED,
      createEntryFocus()
    ]);

    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
    const finding = verdict.warnings.find((warning) => warning.code === 'DIARY_ENTRY_ESSAY_RUN');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('2 of the 4 entries before it');
    expect(verdict.response).not.toBeNull();
  });

  /*
   * The case the issue insists must survive: a wholly professional entry that arose from
   * something that happened is not part of any run, whatever the rest of the cycle did.
   */
  it('leaves professional reflection out of the run when a scene carried it', () => {
    const verdict = validateAgainst(
      createDiaryResponse({
        entryFocus: createEntryFocus({
          dominantSubject: 'a scope argument I lost to a number',
          sceneEvent: 'Marcus answered with a retention figure I could not argue with',
          interactionLevel: 'direct',
          abstractionLevel: 'argument'
        })
      }),
      [ARGUED, ARGUED, ARGUED]
    );

    expect(verdict.warnings.map((warning) => warning.code)).not.toContain('DIARY_ENTRY_ESSAY_RUN');
  });

  /* No cycle handed over is every day before this shipped, and is not evidence of a run. */
  it('reports no run when the caller has no cycle to compare against', () => {
    const verdict = validate(createDiaryResponse({ entryFocus: ARGUED }));

    expect(verdict.warnings.map((warning) => warning.code)).not.toContain('DIARY_ENTRY_ESSAY_RUN');
  });
});
