import {
  DIARY_ABSTRACTION_LEVELS,
  DIARY_DELTA_EPSILON,
  DIARY_EVENT_CATEGORIES,
  DIARY_INTERACTION_LEVELS,
  DIARY_MEMORY_IMPORTANCE,
  DIARY_PATCH_LIMITS,
  DIARY_PROJECT_MOVEMENTS,
  DIARY_RECENT_CYCLE,
  DIARY_TEXT_LIMITS,
  DIARY_THEMES,
  DIARY_CANON_FACT_TYPES,
  DiaryResponseStrictSchema,
  type DiaryEntryFocus,
  type DiaryProjectUpdate,
  type DiaryResponse
} from '../../schemas/diary';
import type { DiaryFinding } from '../../schemas/diary-record';
import { JUDGE_SLUGS } from '../../schemas/jury';
import { detectRepeatedProjectStages, type DiaryProjectLedgerRow } from './projects';
import { countArgumentLed, isArgumentLed, type DiarySceneMode } from './scene';

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
 * Two families of finding are warnings by construction, whatever they say: `entryFocus` and
 * `projectUpdates` are read by tomorrow's prompt and by nothing else, so a defect in either
 * costs the next entry some context and must never cost this one its publication. A project
 * that quietly restarted (issue #111) is reported here and still publishes, and so does a
 * rotation that has spent most of its entries arguing positions rather than living days
 * (issue #113): the finding makes the pattern findable afterwards, it does not judge the day.
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
  /**
   * Where the archive last left this juror's ongoing projects (issue #111). Absent means the
   * caller has no ledger to compare against, which is how every day before this shipped reads —
   * not a reason to complain about a project the archive cannot place.
   */
  knownProjects?: readonly DiaryProjectLedgerRow[];
  /**
   * How the newest entries across all five diarists spent their day (issue #113), as shown to
   * this juror in the prompt. Absent means the caller has no cycle to compare against, which is
   * every day before this shipped — not a reason to call today's entry part of a run.
   */
  recentScenes?: readonly DiarySceneMode[];
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

  /*
   * entryFocus feeds tomorrow's prompt and nothing else (issue #110), so a blank field costs
   * the next day some context and costs today nothing. Warning, never error: making the
   * writer's description of its own entry a publication condition would give the diary its
   * first quality gate by the back door.
   */
  const focusResult = normalizeEntryFocus(response.entryFocus);
  const entryFocus = focusResult.focus;
  /*
   * Blankness is read from what arrived, not from what normalization kept: a level outside the
   * accepted list is reported as the unrecognised word it was, and calling it blank as well
   * would report one defect twice and hide which one it is. `sceneEvent` is absent from this
   * list on purpose — null is one of its two honest answers.
   */
  const blankFocusFields = (
    [
      ['dominantSubject', response.entryFocus.dominantSubject],
      ['centralTension', response.entryFocus.centralTension],
      ['endingState', response.entryFocus.endingState],
      ['interactionLevel', response.entryFocus.interactionLevel],
      ['abstractionLevel', response.entryFocus.abstractionLevel]
    ] as const
  )
    .filter(([, value]) => value.trim().length === 0)
    .map(([field]) => field);
  if (blankFocusFields.length > 0) {
    warnings.push(
      warning(
        'DIARY_ENTRY_FOCUS_INCOMPLETE',
        '$.entryFocus',
        `Left blank: ${blankFocusFields.join(', ')}. The next entry by this juror loses that context.`
      )
    );
  }
  for (const unknown of focusResult.unknownLevels) {
    warnings.push(
      warning(
        'DIARY_UNKNOWN_FOCUS_LEVEL',
        `$.entryFocus.${unknown.field}`,
        `Set aside ${unknown.field} "${unknown.value}"; expected one of ${unknown.accepted.join(', ')}.`
      )
    );
  }

  /*
   * The essay-mode advisory (issue #113). It fires on a *run*, never on a day: an entry that
   * argues a position with nothing happening in it is a legitimate diary day, and warning about
   * one would be a quality opinion the gate is not allowed to have. What is worth finding
   * afterwards is the rotation where every juror wrote one, which is why today is only counted
   * alongside the cycle it was written into — the same five entries the prompt had shown it.
   */
  const recentScenes = expected.recentScenes ?? [];
  const arguedBefore = countArgumentLed(recentScenes);
  if (isArgumentLed(entryFocus) && arguedBefore + 1 >= DIARY_RECENT_CYCLE.essayRun) {
    warnings.push(
      warning(
        'DIARY_ENTRY_ESSAY_RUN',
        '$.entryFocus',
        'This entry argues a position with nothing happening in it, and so did ' +
          `${arguedBefore} of the ${recentScenes.length} entries before it. ` +
          'Published as written; the next prompt names the run.'
      )
    );
  }

  /*
   * projectUpdates has the same standing as entryFocus: it is read by the next prompt and by
   * nothing else, so every defect in it is a warning. An unrecognised movement is dropped
   * rather than kept, because a ledger row whose movement means nothing is worse than a
   * missing one — it would be quoted back to the writer as though the pipeline understood it.
   */
  const projects = normalizeProjectUpdates(response.projectUpdates);
  if (projects.blank > 0) {
    warnings.push(
      warning(
        'DIARY_PROJECT_UPDATE_INCOMPLETE',
        '$.projectUpdates',
        `Dropped ${projects.blank} project update(s) with no project or no stage.`
      )
    );
  }
  for (const movement of projects.unknownMovements) {
    warnings.push(
      warning(
        'DIARY_UNKNOWN_PROJECT_MOVEMENT',
        '$.projectUpdates',
        `Dropped a project update with movement "${movement}"; expected one of ` +
          `${DIARY_PROJECT_MOVEMENTS.join(', ')}.`
      )
    );
  }
  let projectUpdates = projects.kept;
  if (projectUpdates.length > DIARY_PATCH_LIMITS.projectUpdates) {
    warnings.push(
      warning(
        'DIARY_PROJECT_UPDATES_TRUNCATED',
        '$.projectUpdates',
        `Kept the first ${DIARY_PATCH_LIMITS.projectUpdates} of ${projectUpdates.length} project updates.`
      )
    );
    projectUpdates = projectUpdates.slice(0, DIARY_PATCH_LIMITS.projectUpdates);
  }

  /*
   * The continuity check itself. It reports; it never rejects. A project put back where it
   * already stood is a duller archive, not a broken one, and the day still publishes — the
   * finding is what makes the gap findable afterwards, and the ledger in tomorrow's prompt is
   * what stops it happening again.
   */
  for (const repeat of detectRepeatedProjectStages(projectUpdates, expected.knownProjects ?? [])) {
    warnings.push(
      warning(
        'DIARY_PROJECT_STAGE_REPEATED',
        '$.projectUpdates',
        `"${repeat.project}" is reported as "${repeat.stage}" (${repeat.movement}), which says ` +
          `nothing the ${repeat.previous.date} entry did not already say ("${repeat.previous.stage}"). ` +
          'Neither entry restarted it or reported it failed.'
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
    response: {
      ...response,
      entryFocus,
      projectUpdates,
      relatedReviewIds: keptReviewIds,
      contradictionNotes
    }
  };
}

/**
 * Trims each project update and drops the ones that cannot be read: a blank project or stage
 * names nothing, and a movement outside the stated list is a word this pipeline has no rule
 * for. Both are counted so the caller can say what was lost rather than losing it silently.
 */
function normalizeProjectUpdates(updates: readonly DiaryProjectUpdate[]): {
  kept: DiaryProjectUpdate[];
  blank: number;
  unknownMovements: string[];
} {
  const kept: DiaryProjectUpdate[] = [];
  const unknownMovements: string[] = [];
  let blank = 0;

  for (const update of updates) {
    const project = update.project.trim();
    const stage = update.stage.trim();
    const movement = update.movement.trim().toLowerCase();
    if (project.length === 0 || stage.length === 0) {
      blank++;
      continue;
    }
    if (!DIARY_PROJECT_MOVEMENTS.includes(movement as (typeof DIARY_PROJECT_MOVEMENTS)[number])) {
      unknownMovements.push(update.movement.trim());
      continue;
    }
    kept.push({ project, stage, movement });
  }

  return { kept, blank, unknownMovements };
}

/** A level the writer used that this pipeline has no reading for, kept for the warning. */
interface UnknownFocusLevel {
  field: 'interactionLevel' | 'abstractionLevel';
  value: string;
  accepted: readonly string[];
}

/**
 * Trims the focus, folds a blank `anchorObject` or `sceneEvent` to null, and reduces each level
 * to an accepted value or to nothing.
 *
 * "" and null both mean "no object at the centre", and storing two spellings of the same fact
 * would make the next prompt render an empty anchor line instead of "(none)". A level outside
 * its list is dropped rather than kept, for the reason an unrecognised project movement is: a
 * value the pipeline cannot read would still be quoted back to the whole rotation as though it
 * had been understood, and a blank is a smaller lie than that.
 */
function normalizeEntryFocus(focus: DiaryEntryFocus): {
  focus: DiaryEntryFocus;
  unknownLevels: UnknownFocusLevel[];
} {
  const anchorObject = focus.anchorObject?.trim() ?? '';
  const sceneEvent = focus.sceneEvent?.trim() ?? '';
  const interaction = normalizeFocusLevel(focus.interactionLevel, DIARY_INTERACTION_LEVELS);
  const abstraction = normalizeFocusLevel(focus.abstractionLevel, DIARY_ABSTRACTION_LEVELS);

  const unknownLevels: UnknownFocusLevel[] = [];
  if (interaction.unknown !== null) {
    unknownLevels.push({
      field: 'interactionLevel',
      value: interaction.unknown,
      accepted: DIARY_INTERACTION_LEVELS
    });
  }
  if (abstraction.unknown !== null) {
    unknownLevels.push({
      field: 'abstractionLevel',
      value: abstraction.unknown,
      accepted: DIARY_ABSTRACTION_LEVELS
    });
  }

  return {
    focus: {
      dominantSubject: focus.dominantSubject.trim(),
      anchorObject: anchorObject.length > 0 ? anchorObject : null,
      centralTension: focus.centralTension.trim(),
      endingState: focus.endingState.trim(),
      sceneEvent: sceneEvent.length > 0 ? sceneEvent : null,
      interactionLevel: interaction.kept,
      abstractionLevel: abstraction.kept
    },
    unknownLevels
  };
}

/** Case-folded to an accepted value, or set aside. A blank is missing, not wrong. */
function normalizeFocusLevel(
  raw: string,
  accepted: readonly string[]
): { kept: string; unknown: string | null } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kept: '', unknown: null };
  const folded = trimmed.toLowerCase();
  if (!accepted.includes(folded)) return { kept: '', unknown: trimmed };
  return { kept: folded, unknown: null };
}

/** Quote matching ignores whitespace and the curly/straight quote distinction only. */
function normalizeQuoted(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
