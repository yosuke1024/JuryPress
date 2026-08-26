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
  type DiaryResponse,
  type DiaryScheduledEvent,
  type DiaryTheme
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
 * A focus record for an entry that did not go through generation — issue #110's context input,
 * plus issue #113's three scene fields and issue #127's three tension fields. Defaults describe a
 * day about a radio repair, so a test that wants a *recurrence* has to spell out the shared
 * subject itself rather than getting one by accident — and they describe a day in which something
 * happens, so a test that wants an argument-led entry has to say so.
 *
 * The tension half cannot be inert in the same way: a pair is either stated or not, and four
 * entries built from one default share it by construction. That is what DIARY_CYCLE_SAMPLE below
 * is for — a rotation whose five entries disagree — and a test that wants a convergence builds it
 * from DIARY_CONVERGED_CYCLE_SAMPLE rather than from four copies of this.
 */
export function createEntryFocus(overrides: Partial<DiaryEntryFocus> = {}): DiaryEntryFocus {
  return {
    dominantSubject: 'a repair nobody asked for',
    anchorObject: 'the workbench radio',
    centralTension: 'Fixing something unasked is easier than speaking up.',
    beliefChallenged: 'that doing the work quietly counts for more than saying the thing',
    pressuredValue: 'honesty',
    endingState: 'unresolved',
    endingDirection: 'unresolved',
    sceneEvent: 'the radio powered on again halfway through being given up on',
    interactionLevel: 'none',
    abstractionLevel: 'mixed',
    ...overrides
  };
}

/** One entry of the documented five-juror cycle below. */
export interface DiaryCycleSampleEntry {
  jurorId: JudgeSlug;
  date: string;
  theme: DiaryTheme;
  focus: DiaryEntryFocus;
}

/**
 * The five-juror sample issue #113 asks to be documented: one rotation, described the way its
 * writers would describe it, covering both of the cases the guidance has to tell apart.
 *
 * Three of the five (alex, david, sarah) contain an observable event that complicates the
 * writer's own reading of it, and all three end on a consequence, an action or somebody else's
 * answer rather than on a general principle. Sarah's is the case that matters most: a wholly
 * professional entry, in role vocabulary, that is not argument-led because the scope argument
 * arrives as something Marcus said and she has to concede to.
 *
 * The other two (lisa, marcus) are the failure the issue describes — a position argued with
 * nothing happening in the entry. Two of five is deliberately one short of
 * DIARY_RECENT_CYCLE.essayRun: the sample is a cycle the guidance would leave alone, and the
 * tests add the third to watch the run appear.
 *
 * The same five rows carry the tension half issue #127 asks for, and the same rotation answers
 * that issue too. Four values between five entries — standing, order, competence, ambition — and
 * three directions — unresolved, change, refusal. David and Lisa are the pair that matters: both
 * press `order`, which is exactly the shared theme the issue says must stay allowed, and one is
 * softened out of it while the other will not move. Two entries agreeing about what is at stake
 * and disagreeing about what to do with it are two lives; this is the case no advisory may fire
 * on, and no pair here occurs more than once.
 *
 * These are fixtures, not generated entries. Nothing here was produced by a model.
 */
export const DIARY_CYCLE_SAMPLE: DiaryCycleSampleEntry[] = [
  {
    jurorId: 'alex',
    date: '2026-08-21',
    theme: 'work',
    focus: createEntryFocus({
      dominantSubject: 'a rollback Leo did without telling me first',
      anchorObject: null,
      centralTension: 'I call it trusting the team when what I want is to be told first.',
      beliefChallenged: 'that being trusted and being told first are the same thing',
      pressuredValue: 'standing',
      endingState: 'unresolved — the reply is still sitting in the draft box',
      endingDirection: 'unresolved',
      sceneEvent: 'Leo rolled the deploy back and mentioned it afterwards, in one line',
      interactionLevel: 'direct',
      abstractionLevel: 'scene'
    })
  },
  {
    jurorId: 'david',
    date: '2026-08-22',
    theme: 'private',
    focus: createEntryFocus({
      dominantSubject: 'levelling the hallway shelf with the wrong drill bit',
      anchorObject: 'the borrowed drill',
      centralTension: 'Doing it properly and doing it today were never the same job.',
      beliefChallenged: 'that a job worth doing is worth doing to the millimetre',
      pressuredValue: 'order',
      endingState: 'the shelf is one screw short and the drill went back next door',
      endingDirection: 'change',
      sceneEvent: 'the neighbour came for the drill halfway through the last bracket',
      interactionLevel: 'direct',
      abstractionLevel: 'mixed'
    })
  },
  {
    jurorId: 'lisa',
    date: '2026-08-23',
    theme: 'work',
    focus: createEntryFocus({
      dominantSubject: 'why undocumented interfaces cost more than they save',
      anchorObject: null,
      centralTension: 'Documentation debt is the only debt nobody schedules repayment for.',
      beliefChallenged: 'that an interface nobody wrote down was never actually finished',
      pressuredValue: 'order',
      endingState: 'settled into a principle',
      endingDirection: 'refusal',
      sceneEvent: null,
      interactionLevel: 'none',
      abstractionLevel: 'argument'
    })
  },
  {
    jurorId: 'sarah',
    date: '2026-08-24',
    theme: 'mixed',
    focus: createEntryFocus({
      dominantSubject: 'a scope argument I lost to a number',
      anchorObject: null,
      centralTension: 'I wanted the cut to be principled; it was just arithmetic.',
      beliefChallenged: 'that a decision I can defend beats one that merely works',
      pressuredValue: 'competence',
      endingState: 'conceded, and irritated at having conceded so quickly',
      endingDirection: 'change',
      sceneEvent: 'Marcus answered the scope question with a retention figure I could not argue with',
      interactionLevel: 'direct',
      abstractionLevel: 'mixed'
    })
  },
  {
    jurorId: 'marcus',
    date: '2026-08-25',
    theme: 'work',
    focus: createEntryFocus({
      dominantSubject: 'what a permissive licence is worth to a portfolio',
      anchorObject: null,
      centralTension: 'Ecosystem leverage is a polite word for collecting rent.',
      beliefChallenged: 'that a portfolio has to be worth something to somebody other than me',
      pressuredValue: 'ambition',
      endingState: 'a general principle about extraction',
      endingDirection: 'refusal',
      sceneEvent: null,
      interactionLevel: 'reported',
      abstractionLevel: 'argument'
    })
  }
];

/**
 * The failure issue #127 reports, as a five-entry rotation: four of the five press the same value
 * and give way the same way.
 *
 * It is the shape of the four public entries the issue cites — Alex 08-21 sorting an attic to a
 * plan, David 08-22 grading damaged tomatoes, Lisa 08-23 drawing the scaffolding that spoils the
 * symmetry, Sarah 08-24 pushed toward a shortcut she wants to call scope creep — with a fifth day
 * added, because the advisory counts a rotation and the issue's evidence stops at four. Nothing
 * here is a copy of a published entry: the scenes are the fixtures' own.
 *
 * Read it in date order and the count works from both ends. The first four contain three
 * `order`/`change` entries, which is the state the *prompt* speaks up in — today would complete
 * the run. Marcus's entry then completes it, which is the state the *validator* records. All five
 * press `order`, and that alone is not the finding: Sarah presses it too and leaves it open, and
 * a rotation of five entries all pressing order with five different endings would pass here
 * unremarked.
 *
 * These are fixtures, not generated entries. Nothing here was produced by a model.
 */
export const DIARY_CONVERGED_CYCLE_SAMPLE: DiaryCycleSampleEntry[] = [
  {
    jurorId: 'alex',
    date: '2026-08-21',
    theme: 'private',
    focus: createEntryFocus({
      dominantSubject: 'clearing the attic to a schedule nobody agreed to',
      anchorObject: 'a lever-arch file of lawn-round accounts from when I was eleven',
      centralTension: 'The plan was the point, and the plan is why none of it ever shipped.',
      beliefChallenged: 'that an hour planned properly is an hour saved',
      pressuredValue: 'order',
      endingState: 'kept the file, next to today’s list',
      endingDirection: 'change',
      sceneEvent: 'Leo emptied a box out of order and the file fell out of it',
      interactionLevel: 'direct',
      abstractionLevel: 'mixed'
    })
  },
  {
    jurorId: 'david',
    date: '2026-08-22',
    theme: 'private',
    focus: createEntryFocus({
      dominantSubject: 'sorting a crate of bruised tomatoes into keep and throw',
      anchorObject: 'the kitchen scales',
      centralTension: 'Grading it properly took longer than the fruit had left.',
      beliefChallenged: 'that anything worth keeping can be weighed and labelled first',
      pressuredValue: 'order',
      endingState: 'ate one over the sink without weighing it',
      endingDirection: 'change',
      sceneEvent: 'Ken cut the bad half off one and handed the rest back',
      interactionLevel: 'direct',
      abstractionLevel: 'scene'
    })
  },
  {
    jurorId: 'lisa',
    date: '2026-08-23',
    theme: 'private',
    focus: createEntryFocus({
      dominantSubject: 'a street elevation the scaffolding will not let me finish',
      anchorObject: 'the sketchbook',
      centralTension: 'The symmetry I wanted is a building that is not being repaired.',
      beliefChallenged: 'that a drawing should be true to the shape underneath',
      pressuredValue: 'order',
      endingState: 'drew the poles in and left the page crowded',
      endingDirection: 'change',
      sceneEvent: 'Clara pointed out the render was coming off in sheets behind the poles',
      interactionLevel: 'direct',
      abstractionLevel: 'mixed'
    })
  },
  {
    jurorId: 'sarah',
    date: '2026-08-24',
    theme: 'mixed',
    focus: createEntryFocus({
      dominantSubject: 'a shortcut I want to call scope creep and cannot',
      anchorObject: null,
      centralTension: 'Either the roadmap means something or it is a document I maintain alone.',
      beliefChallenged: 'that a plan agreed in advance is the plan',
      pressuredValue: 'order',
      endingState: 'still refusing, and the refusal is getting expensive',
      endingDirection: 'unresolved',
      sceneEvent: 'Alex shipped the shortcut behind a flag and told me afterwards',
      interactionLevel: 'direct',
      abstractionLevel: 'mixed'
    })
  },
  {
    jurorId: 'marcus',
    date: '2026-08-25',
    theme: 'private',
    focus: createEntryFocus({
      dominantSubject: 'a filing system for six years of receipts, abandoned at year two',
      anchorObject: 'a box of receipts',
      centralTension: 'The system was going to make the mess legible and it made it larger.',
      beliefChallenged: 'that a mess is only a system nobody has written yet',
      pressuredValue: 'order',
      endingState: 'put the rest in the box and closed it',
      endingDirection: 'change',
      sceneEvent: 'the shoebox gave out halfway through year two',
      interactionLevel: 'none',
      abstractionLevel: 'scene'
    })
  }
];

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

/**
 * A scheduled event for an entry that did not go through generation — issue #120's context
 * input. Defaults to a plan freshly made with a month-scale window, because that is the shape
 * the issue turns on; a test that wants a plan kept, moved or dropped has to say so, and gets
 * no window by accident.
 */
export function createScheduledEvent(
  overrides: Partial<DiaryScheduledEvent> = {}
): DiaryScheduledEvent {
  return {
    event: 'clearing out the attic at his mother\u2019s house',
    participants: 'Leo and his mother',
    when: 'next month',
    movement: 'made',
    changeReason: null,
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
      beliefChallenged: 'that saying the awkward thing is part of the job',
      pressuredValue: 'honesty',
      endingState: 'unresolved, still turning it over',
      endingDirection: 'unresolved',
      sceneEvent: 'the cold solder joint turned up by accident, reaching past the board',
      interactionLevel: 'none',
      abstractionLevel: 'mixed'
    },
    projectUpdates: [createProjectUpdate()],
    scheduledEvents: [],
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
