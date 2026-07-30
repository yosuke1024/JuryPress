import { describe, it, expect } from 'vitest';
import { validateDiaryResponse, japaneseCharacterRatio } from '../../src/lib/diary/validator';
import { createDiaryResponse, FIXTURE_BODY_EN } from '../helpers/diary-fixtures';
import type { DiaryResponse } from '../../src/schemas/diary';

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
