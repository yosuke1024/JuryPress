import { JUDGE_SLUGS, type JudgeSlug } from '../../src/schemas/jury';
import {
  DIARY_STATE_SCHEMA_VERSION,
  DiaryCharacterStateSchema,
  DiaryLifeStateSchema,
  DiaryMemoriesSchema,
  DiaryPrivateCanonSchema,
  DiaryRelationshipsSchema,
  buildInitialRelationshipMap,
  type DiaryConfig,
  type DiaryJurorStates
} from '../../src/schemas/diary-state';
import {
  DIARY_RESPONSE_SCHEMA_VERSION,
  type DiaryEntryFocus,
  type DiaryProjectUpdate,
  type DiaryResponse
} from '../../src/schemas/diary';
import { writeJurorStates } from '../../src/lib/diary/state-store';
import { buildDefaultDiaryConfig, writeDiaryConfig } from '../../src/lib/diary/config';

/**
 * Fixture builders for JuryDiary tests.
 *
 * Deliberately obvious fiction: every string here reads as test scaffolding rather than as a
 * plausible production diary, so a fixture that ever leaked into a content root would be
 * recognisable at a glance (the same reason tests/fixtures carries `fixture-product`).
 */

export const FIXTURE_BODY_EN =
  'The radio on the workbench still hums when I power it on, which is more than it managed last week. ' +
  'I spent an hour with the schematic and found nothing wrong at all, then found the cold solder joint ' +
  'by accident while reaching past the board for a different tool. Nobody asked me to repair it and ' +
  'nobody will notice that it works now. I keep coming back to the review from this morning and how ' +
  'quickly the five of us agreed about the deployment story. Agreement that fast usually means nobody ' +
  'checked. I did not say so at the time, and I have been turning that over all evening.';

export const FIXTURE_BODY_JA =
  '作業台のラジオは、電源を入れるとまだ低く唸る。先週よりはましだ。回路図と一時間にらみ合っても異常は見つからず、' +
  '別の工具を取ろうと基板の向こうへ手を伸ばした拍子に、はんだの浮きを見つけた。誰かに頼まれた修理ではないし、' +
  '直ったことに気づく人もいない。今朝のレビューのことを、まだ考えている。デプロイの話について、五人があまりに早く同意した。' +
  'あの速さの合意は、たいてい誰も確認していないという意味だ。あのとき私は何も言わなかった。そのことを、一晩ずっと転がしている。';

export const FIXTURE_QUOTE_EN = 'Agreement that fast usually means nobody checked.';
export const FIXTURE_QUOTE_JA = 'あの速さの合意は、たいてい誰も確認していないという意味だ。';

export function createDiaryConfig(overrides: Partial<DiaryConfig> = {}): DiaryConfig {
  return {
    schema_version: '1.0',
    startDate: '2026-08-01',
    rotation: [...JUDGE_SLUGS],
    timezone: 'Asia/Tokyo',
    ...overrides
  };
}

export function createJurorStates(
  jurorId: JudgeSlug = 'david',
  options: { lastEventId?: string; updatedAt?: string } = {}
): DiaryJurorStates {
  const lastEventId = options.lastEventId ?? 'bootstrap';
  const updatedAt = options.updatedAt ?? '2026-08-01T00:00:00+09:00';
  const envelope = { schema_version: DIARY_STATE_SCHEMA_VERSION, jurorId, updatedAt, lastEventId };

  return {
    canon: DiaryPrivateCanonSchema.parse({
      ...envelope,
      state: {
        facts: [
          {
            id: 'fact-fixture-home',
            factType: 'home',
            fact: 'Lives in a small ground-floor flat with a workbench under the window.',
            addedOn: '2026-08-01',
            source: 'bootstrap',
            diaryId: null
          },
          {
            id: 'fact-fixture-hobby',
            factType: 'hobby',
            fact: 'Repairs old radios.',
            addedOn: '2026-08-01',
            source: 'bootstrap',
            diaryId: null
          }
        ]
      }
    }),
    character: DiaryCharacterStateSchema.parse({
      ...envelope,
      state: {
        currentMood: 'level',
        recentConcerns: ['projects that hide their operational cost'],
        emergingTraits: [{ trait: 'patience with small teams', strength: 0.2, evidenceCount: 1 }],
        beliefsUnderPressure: [
          { belief: 'technical debt is always avoidable', confidence: 0.6, reason: 'fixture baseline' }
        ],
        unresolvedThoughts: ['Was I too blunt in the last review?']
      }
    }),
    life: DiaryLifeStateSchema.parse({
      ...envelope,
      state: {
        currentConcerns: ['the kitchen light has been flickering'],
        ongoingActivities: ['repairing an old radio'],
        recentEvents: [{ date: '2026-08-01', event: 'found a box of spare valves' }],
        unresolvedThreads: ['has not replied to a message from a friend']
      }
    }),
    relationships: DiaryRelationshipsSchema.parse({
      ...envelope,
      state: buildInitialRelationshipMap(jurorId)
    }),
    memories: DiaryMemoriesSchema.parse({
      ...envelope,
      state: {
        memories: [
          {
            id: 'mem-fixture-0001',
            summary: 'Accepted once that a deliberate shortcut was the right call.',
            importance: 0.7,
            tags: ['technical-debt'],
            createdOn: '2026-08-01',
            sourceDiaryId: 'bootstrap'
          }
        ]
      }
    })
  };
}

/**
 * Seeds a temp content root with a config and all five bootstrapped personas — the state a
 * diary run expects to find before it can generate anything.
 */
export function seedDiaryContentRoot(
  contentRoot: string,
  options: { startDate?: string } = {}
): DiaryConfig {
  const startDate = options.startDate ?? '2026-08-01';
  const config = writeDiaryConfig(contentRoot, buildDefaultDiaryConfig(startDate));
  for (const slug of JUDGE_SLUGS) {
    writeJurorStates(contentRoot, slug, createJurorStates(slug));
  }
  return config;
}

/**
 * A focus record for an entry that did not go through generation — issue #110's context input.
 * Defaults describe a day about a radio repair, so a test that wants a *recurrence* has to
 * spell out the shared subject itself rather than getting one by accident.
 */
export function createEntryFocus(overrides: Partial<DiaryEntryFocus> = {}): DiaryEntryFocus {
  return {
    dominantSubject: 'a repair nobody asked for',
    anchorObject: 'the workbench radio',
    centralTension: 'Fixing something unasked is easier than speaking up.',
    endingState: 'unresolved',
    ...overrides
  };
}

/**
 * A project update for an entry that did not go through generation — issue #111's context
 * input. Defaults to the radio the fixture body is about, so a test that wants a *repeat* has
 * to state the shared stage itself rather than inheriting one.
 */
export function createProjectUpdate(
  overrides: Partial<DiaryProjectUpdate> = {}
): DiaryProjectUpdate {
  return {
    project: 'the workbench radio',
    stage: 'cold solder joint found and resoldered; it powers on again',
    movement: 'advanced',
    ...overrides
  };
}

export function createDiaryResponse(overrides: Partial<DiaryResponse> = {}): DiaryResponse {
  const base: DiaryResponse = {
    schemaVersion: DIARY_RESPONSE_SCHEMA_VERSION,
    date: '2026-08-02',
    jurorId: 'david',
    theme: 'mixed',
    privateEventCategory: 'small_success',
    diary: {
      title: { en: 'The Cold Joint', ja: 'はんだの浮き' },
      body: { en: FIXTURE_BODY_EN, ja: FIXTURE_BODY_JA },
      mood: { en: 'unsettled but steady', ja: '落ち着かないが平静' },
      shareQuote: { en: FIXTURE_QUOTE_EN, ja: FIXTURE_QUOTE_JA }
    },
    relatedReviewIds: [],
    respondsTo: null,
    entryFocus: {
      dominantSubject: 'a repair nobody asked for, next to a review that went too smoothly',
      anchorObject: 'the workbench radio',
      centralTension: 'Fast agreement usually means nobody checked, and I said nothing.',
      endingState: 'unresolved, still turning it over'
    },
    projectUpdates: [createProjectUpdate()],
    characterStatePatch: {
      currentMood: 'unsettled but steady',
      addRecentConcerns: ['teams confusing velocity with progress'],
      addUnresolvedThoughts: ['I should have said something in the review.'],
      resolveUnresolvedThoughts: [],
      traitAdjustments: [
        { trait: 'patience with small teams', delta: 0.03, reason: 'fixture adjustment' }
      ],
      beliefAdjustments: []
    },
    lifeStatePatch: {
      addCurrentConcerns: [],
      resolveCurrentConcerns: [],
      addOngoingActivities: [],
      completeOngoingActivities: [],
      addRecentEvents: ['found the cold solder joint by accident'],
      addUnresolvedThreads: [],
      resolveUnresolvedThreads: []
    },
    relationshipPatches: [],
    memoryCandidate: null,
    canonCandidate: null,
    contradictionNotes: []
  };

  return { ...base, ...overrides };
}
