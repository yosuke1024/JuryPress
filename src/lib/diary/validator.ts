import {
  DIARY_DELTA_EPSILON,
  DIARY_EVENT_CATEGORIES,
  DIARY_MEMORY_IMPORTANCE,
  DIARY_PATCH_LIMITS,
  DIARY_TEXT_LIMITS,
  DIARY_THEMES,
  DIARY_CANON_FACT_TYPES,
  DiaryResponseStrictSchema,
  type DiaryResponse
} from '../../schemas/diary';
import type { DiaryFinding } from '../../schemas/diary-record';
import { JUDGE_SLUGS } from '../../schemas/jury';

/**
 * The only gate between a Gemini response and publication.
 *
 * JuryDiary has no quality gate and never will (brief §14, §27): a boring day, a slightly
 * inconsistent day, a translation with a flattened joke — all of those are published, because
 * they are the experiment's actual results. What this validator rejects is *structural*
 * damage, where publishing would produce a broken page or a corrupted persona:
 *
 *   - the response is not JSON, or not the agreed shape
 *   - a language is missing, stubbed, or left untranslated
 *   - the model tried to move a relationship or a trait further than one day is allowed to
 *   - a patch targets a juror who does not exist
 *
 * Nothing here throws on a content defect. Findings are returned, the caller records them on
 * the generation record, and an excluded day is a green workflow run — a normal completion
 * with a gap in the archive, not an incident.
 *
 * Out-of-range deltas are errors rather than silently clamped values. Clamping would hide a
 * prompt regression behind state that still looks plausible; a gap is visible (brief §10.2).
 */

const MAX_REPORTED_SCHEMA_ISSUES = 20;

export interface DiaryValidationExpectation {
  date: string;
  jurorId: string;
  theme: string;
  privateEventCategory: string | null;
  /** Review slugs offered to the model today. Anything else it cites is dropped. */
  allowedReviewSlugs?: readonly string[];
  /** The entry the juror was assigned to read, as recorded before the call. */
  readingTargetId?: string | null;
}

export interface DiaryValidationVerdict {
  status: 'passed' | 'failed';
  errors: DiaryFinding[];
  warnings: DiaryFinding[];
  /** Normalized response — present only when the verdict passed. */
  response: DiaryResponse | null;
}

function error(code: string, path: string, message: string): DiaryFinding {
  return { code, path, message, severity: 'error' };
}

function warning(code: string, path: string, message: string): DiaryFinding {
  return { code, path, message, severity: 'warning' };
}

/** Share of kana and kanji among non-whitespace characters. */
export function japaneseCharacterRatio(text: string): number {
  const stripped = text.replace(/\s/g, '');
  if (stripped.length === 0) return 0;
  const matches = stripped.match(/[぀-ゟ゠-ヿ一-鿿]/g);
  return (matches?.length ?? 0) / stripped.length;
}

function exceedsDelta(value: number, limit: number): boolean {
  return Math.abs(value) > limit + DIARY_DELTA_EPSILON;
}

function outsideImportanceRange(value: number): boolean {
  return (
    value < DIARY_MEMORY_IMPORTANCE.min - DIARY_DELTA_EPSILON ||
    value > DIARY_MEMORY_IMPORTANCE.max + DIARY_DELTA_EPSILON
  );
}

export function validateDiaryResponse(input: {
  parsed: unknown;
  expected: DiaryValidationExpectation;
}): DiaryValidationVerdict {
  const errors: DiaryFinding[] = [];
  const warnings: DiaryFinding[] = [];
  const { expected } = input;

  if (input.parsed === null || input.parsed === undefined) {
    return {
      status: 'failed',
      errors: [
        error('DIARY_RESPONSE_NOT_JSON', '$', 'The response could not be parsed as JSON.')
      ],
      warnings,
      response: null
    };
  }

  const parseResult = DiaryResponseStrictSchema.safeParse(input.parsed);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues.slice(0, MAX_REPORTED_SCHEMA_ISSUES)) {
      errors.push(
        error(
          'DIARY_SCHEMA_VALIDATION_FAILED',
          `$.${issue.path.join('.')}`,
          issue.message
        )
      );
    }
    return { status: 'failed', errors, warnings, response: null };
  }

  const response = parseResult.data;

  /* -- Identity: code decides the day, the juror and the brief; the model only echoes them. */

  if (response.date !== expected.date) {
    errors.push(
      error('DIARY_IDENTITY_MISMATCH', '$.date', `Expected date ${expected.date}, got ${response.date}.`)
    );
  }
  if (response.jurorId !== expected.jurorId) {
    errors.push(
      error(
        'DIARY_IDENTITY_MISMATCH',
        '$.jurorId',
        `Expected juror ${expected.jurorId}, got ${response.jurorId}.`
      )
    );
  }
  if (response.theme !== expected.theme) {
    errors.push(
      error('DIARY_IDENTITY_MISMATCH', '$.theme', `Expected theme ${expected.theme}, got ${response.theme}.`)
    );
  }
  if (!DIARY_THEMES.includes(response.theme as (typeof DIARY_THEMES)[number])) {
    errors.push(error('DIARY_UNKNOWN_THEME', '$.theme', `Unknown theme: ${response.theme}.`));
  }
  if (response.privateEventCategory !== expected.privateEventCategory) {
    errors.push(
      error(
        'DIARY_EVENT_CATEGORY_MISMATCH',
        '$.privateEventCategory',
        `Expected ${expected.privateEventCategory ?? 'null'}, got ${response.privateEventCategory ?? 'null'}.`
      )
    );
  }
  if (
    response.privateEventCategory !== null &&
    !DIARY_EVENT_CATEGORIES.includes(
      response.privateEventCategory as (typeof DIARY_EVENT_CATEGORIES)[number]
    )
  ) {
    errors.push(
      error(
        'DIARY_UNKNOWN_EVENT_CATEGORY',
        '$.privateEventCategory',
        `Unknown event category: ${response.privateEventCategory}.`
      )
    );
  }

  /* -- Both languages must actually be there. Everything else about them is allowed to wobble. */

  const textFields: Array<[string, { en: string; ja: string }, number]> = [
    ['title', response.diary.title, DIARY_TEXT_LIMITS.minTitle],
    ['mood', response.diary.mood, DIARY_TEXT_LIMITS.minMood],
    ['shareQuote', response.diary.shareQuote, DIARY_TEXT_LIMITS.minShareQuote],
    ['body', response.diary.body, 0]
  ];

  for (const [field, value, minLength] of textFields) {
    for (const lang of ['en', 'ja'] as const) {
      const text = value[lang].trim();
      if (text.length === 0) {
        errors.push(
          error('DIARY_MISSING_LANGUAGE', `$.diary.${field}.${lang}`, `${field}.${lang} is empty.`)
        );
      } else if (text.length < minLength) {
        errors.push(
          error(
            'DIARY_TEXT_TOO_SHORT',
            `$.diary.${field}.${lang}`,
            `${field}.${lang} is ${text.length} characters; at least ${minLength} required.`
          )
        );
      }
    }
  }

  const bodyEn = response.diary.body.en.trim();
  const bodyJa = response.diary.body.ja.trim();

  if (bodyEn.length > 0 && bodyEn.length < DIARY_TEXT_LIMITS.minBodyEn) {
    errors.push(
      error(
        'DIARY_BODY_TOO_SHORT',
        '$.diary.body.en',
        `body.en is ${bodyEn.length} characters; at least ${DIARY_TEXT_LIMITS.minBodyEn} required.`
      )
    );
  }
  if (bodyJa.length > 0 && bodyJa.length < DIARY_TEXT_LIMITS.minBodyJa) {
    errors.push(
      error(
        'DIARY_BODY_TOO_SHORT',
        '$.diary.body.ja',
        `body.ja is ${bodyJa.length} characters; at least ${DIARY_TEXT_LIMITS.minBodyJa} required.`
      )
    );
  }
  if (bodyEn.length > 0 && bodyJa.length > 0) {
    const ratio = bodyJa.length / bodyEn.length;
    if (ratio < DIARY_TEXT_LIMITS.minLengthRatio || ratio > DIARY_TEXT_LIMITS.maxLengthRatio) {
      errors.push(
        error(
          'DIARY_LENGTH_RATIO_OUT_OF_BAND',
          '$.diary.body',
          `Japanese/English length ratio ${ratio.toFixed(2)} is outside [${DIARY_TEXT_LIMITS.minLengthRatio}, ${DIARY_TEXT_LIMITS.maxLengthRatio}] — one side looks truncated.`
        )
      );
    }
    // The failure this catches is the model echoing the English body into the Japanese field.
    if (japaneseCharacterRatio(bodyJa) < DIARY_TEXT_LIMITS.minJapaneseRatio) {
      errors.push(
        error(
          'DIARY_JAPANESE_NOT_TRANSLATED',
          '$.diary.body.ja',
          'body.ja does not contain enough Japanese script to be a translation.'
        )
      );
    }
  }
  if (response.diary.shareQuote.en.trim().length > DIARY_TEXT_LIMITS.maxShareQuote) {
    errors.push(
      error(
        'DIARY_TEXT_TOO_LONG',
        '$.diary.shareQuote.en',
        `shareQuote.en exceeds ${DIARY_TEXT_LIMITS.maxShareQuote} characters.`
      )
    );
  }

  /* -- Patch limits. A persona is nudged, never rewritten (brief §10.2). */

  const listLimits: Array<[string, number, number]> = [
    ['characterStatePatch.addRecentConcerns', response.characterStatePatch.addRecentConcerns.length, DIARY_PATCH_LIMITS.addRecentConcerns],
    ['characterStatePatch.addUnresolvedThoughts', response.characterStatePatch.addUnresolvedThoughts.length, DIARY_PATCH_LIMITS.addUnresolvedThoughts],
    ['characterStatePatch.resolveUnresolvedThoughts', response.characterStatePatch.resolveUnresolvedThoughts.length, DIARY_PATCH_LIMITS.resolveUnresolvedThoughts],
    ['characterStatePatch.traitAdjustments', response.characterStatePatch.traitAdjustments.length, DIARY_PATCH_LIMITS.traitAdjustments],
    ['characterStatePatch.beliefAdjustments', response.characterStatePatch.beliefAdjustments.length, DIARY_PATCH_LIMITS.beliefAdjustments],
    ['lifeStatePatch.addCurrentConcerns', response.lifeStatePatch.addCurrentConcerns.length, DIARY_PATCH_LIMITS.addCurrentConcerns],
    ['lifeStatePatch.resolveCurrentConcerns', response.lifeStatePatch.resolveCurrentConcerns.length, DIARY_PATCH_LIMITS.resolveCurrentConcerns],
    ['lifeStatePatch.addOngoingActivities', response.lifeStatePatch.addOngoingActivities.length, DIARY_PATCH_LIMITS.addOngoingActivities],
    ['lifeStatePatch.completeOngoingActivities', response.lifeStatePatch.completeOngoingActivities.length, DIARY_PATCH_LIMITS.completeOngoingActivities],
    ['lifeStatePatch.addRecentEvents', response.lifeStatePatch.addRecentEvents.length, DIARY_PATCH_LIMITS.addRecentEvents],
    ['lifeStatePatch.addUnresolvedThreads', response.lifeStatePatch.addUnresolvedThreads.length, DIARY_PATCH_LIMITS.addUnresolvedThreads],
    ['lifeStatePatch.resolveUnresolvedThreads', response.lifeStatePatch.resolveUnresolvedThreads.length, DIARY_PATCH_LIMITS.resolveUnresolvedThreads],
    ['relationshipPatches', response.relationshipPatches.length, DIARY_PATCH_LIMITS.relationshipPatches]
  ];

  for (const [path, actual, limit] of listLimits) {
    if (actual > limit) {
      errors.push(
        error(
          'DIARY_PATCH_LIMIT_EXCEEDED',
          `$.${path}`,
          `${path} carries ${actual} items; at most ${limit} allowed per day.`
        )
      );
    }
  }

  response.characterStatePatch.traitAdjustments.forEach((adjustment, index) => {
    if (exceedsDelta(adjustment.delta, DIARY_PATCH_LIMITS.traitDelta)) {
      errors.push(
        error(
          'DIARY_DELTA_OUT_OF_BOUNDS',
          `$.characterStatePatch.traitAdjustments[${index}].delta`,
          `Trait delta ${adjustment.delta} exceeds ±${DIARY_PATCH_LIMITS.traitDelta}.`
        )
      );
    }
  });

  response.characterStatePatch.beliefAdjustments.forEach((adjustment, index) => {
    if (exceedsDelta(adjustment.confidenceDelta, DIARY_PATCH_LIMITS.beliefConfidenceDelta)) {
      errors.push(
        error(
          'DIARY_DELTA_OUT_OF_BOUNDS',
          `$.characterStatePatch.beliefAdjustments[${index}].confidenceDelta`,
          `Belief confidence delta ${adjustment.confidenceDelta} exceeds ±${DIARY_PATCH_LIMITS.beliefConfidenceDelta}.`
        )
      );
    }
  });

  const seenTargets = new Set<string>();
  response.relationshipPatches.forEach((patch, index) => {
    const path = `$.relationshipPatches[${index}]`;
    if (!JUDGE_SLUGS.includes(patch.targetJurorId as (typeof JUDGE_SLUGS)[number])) {
      errors.push(
        error(
          'DIARY_UNKNOWN_RELATIONSHIP_TARGET',
          `${path}.targetJurorId`,
          `Unknown juror: ${patch.targetJurorId}.`
        )
      );
    } else if (patch.targetJurorId === expected.jurorId) {
      errors.push(
        error(
          'DIARY_SELF_RELATIONSHIP',
          `${path}.targetJurorId`,
          'A juror cannot hold a relationship entry for themselves.'
        )
      );
    }
    if (seenTargets.has(patch.targetJurorId)) {
      errors.push(
        error(
          'DIARY_DUPLICATE_RELATIONSHIP_TARGET',
          `${path}.targetJurorId`,
          `${patch.targetJurorId} is patched more than once in the same day.`
        )
      );
    }
    seenTargets.add(patch.targetJurorId);

    const deltas: Array<[string, number]> = [
      ['trustDelta', patch.trustDelta],
      ['respectDelta', patch.respectDelta],
      ['tensionDelta', patch.tensionDelta]
    ];
    for (const [field, value] of deltas) {
      if (exceedsDelta(value, DIARY_PATCH_LIMITS.relationshipDelta)) {
        errors.push(
          error(
            'DIARY_DELTA_OUT_OF_BOUNDS',
            `${path}.${field}`,
            `${field} ${value} exceeds ±${DIARY_PATCH_LIMITS.relationshipDelta}.`
          )
        );
      }
    }
  });

  if (response.memoryCandidate && outsideImportanceRange(response.memoryCandidate.importance)) {
    errors.push(
      error(
        'DIARY_IMPORTANCE_OUT_OF_BOUNDS',
        '$.memoryCandidate.importance',
        `importance ${response.memoryCandidate.importance} is outside ` +
          `[${DIARY_MEMORY_IMPORTANCE.min}, ${DIARY_MEMORY_IMPORTANCE.max}].`
      )
    );
  }

  /*
   * Replies may only point at the entry code actually handed over. A juror who was given
   * nothing to read cannot claim to be answering someone — that would fabricate a thread the
   * archive does not contain. Declining to answer something they *were* given is allowed and
   * only warned about: an honest silence is a legitimate day.
   */
  const readingTargetId = expected.readingTargetId ?? null;
  if (readingTargetId === null) {
    if (response.respondsTo !== null) {
      errors.push(
        error(
          'DIARY_UNEXPECTED_RESPONSE',
          '$.respondsTo',
          'No entry was assigned to read today, so this diary cannot be a response to one.'
        )
      );
    }
  } else if (response.respondsTo === null) {
    warnings.push(
      warning(
        'DIARY_RESPONSE_DECLINED',
        '$.respondsTo',
        `Read ${readingTargetId} but chose not to respond to it.`
      )
    );
  } else if (response.respondsTo.diaryId !== readingTargetId) {
    errors.push(
      error(
        'DIARY_RESPONSE_TARGET_MISMATCH',
        '$.respondsTo.diaryId',
        `Expected a response to ${readingTargetId}, got ${response.respondsTo.diaryId}.`
      )
    );
  }

  if (
    response.canonCandidate &&
    !DIARY_CANON_FACT_TYPES.includes(
      response.canonCandidate.factType as (typeof DIARY_CANON_FACT_TYPES)[number]
    )
  ) {
    errors.push(
      error(
        'DIARY_UNKNOWN_CANON_FACT_TYPE',
        '$.canonCandidate.factType',
        `Unknown canon fact type: ${response.canonCandidate.factType}.`
      )
    );
  }

  /* -- Warnings: things worth recording that must not cost the day. */

  const quoteEn = response.diary.shareQuote.en.trim();
  if (quoteEn.length > 0 && !normalizeQuoted(bodyEn).includes(normalizeQuoted(quoteEn))) {
    warnings.push(
      warning(
        'DIARY_SHARE_QUOTE_NOT_IN_BODY',
        '$.diary.shareQuote.en',
        'The English share quote is not a verbatim span of the English body.'
      )
    );
  }

  const allowed = expected.allowedReviewSlugs ?? [];
  const keptReviewIds = response.relatedReviewIds.filter((slug) => allowed.includes(slug));
  if (keptReviewIds.length !== response.relatedReviewIds.length) {
    warnings.push(
      warning(
        'DIARY_UNKNOWN_REVIEW_REFERENCE',
        '$.relatedReviewIds',
        'Dropped review references that were not offered in the prompt context.'
      )
    );
  }

  let contradictionNotes = response.contradictionNotes;
  if (contradictionNotes.length > DIARY_PATCH_LIMITS.contradictionNotes) {
    warnings.push(
      warning(
        'DIARY_CONTRADICTION_NOTES_TRUNCATED',
        '$.contradictionNotes',
        `Kept the first ${DIARY_PATCH_LIMITS.contradictionNotes} of ${contradictionNotes.length} contradiction notes.`
      )
    );
    contradictionNotes = contradictionNotes.slice(0, DIARY_PATCH_LIMITS.contradictionNotes);
  }

  if (errors.length > 0) {
    return { status: 'failed', errors, warnings, response: null };
  }

  return {
    status: 'passed',
    errors,
    warnings,
    response: { ...response, relatedReviewIds: keptReviewIds, contradictionNotes }
  };
}

/** Quote matching ignores whitespace and the curly/straight quote distinction only. */
function normalizeQuoted(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
