import { z } from 'zod';
import { JudgeSlugSchema } from './jury';

/**
 * JuryDiary — the Gemini response contract and the published entry shape.
 *
 * Two layers, for the same reason the evaluation pipeline has two (see schemas/evaluation.ts):
 * the *gen* schema is what reaches Gemini as `responseJsonSchema` and deliberately carries no
 * numeric ranges and no array-length constraints, because constraining those on the wire is
 * what drove the editorial request's first-attempt pass rate to zero. Every limit in
 * DIARY_PATCH_LIMITS is enforced app-side instead, by lib/diary/validator.ts, where a
 * violation is a structural failure with a readable code rather than a malformed request.
 *
 * The other half of that contract: a diary is never rejected for being dull, slightly
 * inconsistent, or awkwardly translated. Only structure decides publication.
 */

/** 1.4 adds the scene half of `entryFocus`: what happened, who was there, how abstract (issue #113). */
export const DIARY_RESPONSE_SCHEMA_VERSION = '1.4';
/** v7: asks the day to contain something that happens, and shows how the cycle spent theirs (issue #113). */
export const DIARY_PROMPT_VERSION = 'diary-v7';
export const DIARY_VALIDATOR_VERSION = 'diary-validator-1.4.0';

/**
 * How many of the writer's own recent entries are reduced to their focus and shown back to
 * them. Two, because the question the guidance turns on is whether a subject is about to
 * become the centre of a *third* consecutive entry (issue #110).
 */
export const DIARY_RECENT_FOCUS_COUNT = 2;

/**
 * How a project stood at the end of today's entry, relative to where the archive last left it
 * (issue #111).
 *
 * These are *movements*, not statuses, because the question the ledger has to answer is what
 * today did to a project — not what condition it happens to be in. A project nobody touched
 * today is simply not reported: the ledger keeps its last stated stage, and a value meaning
 * "unchanged" would be a standing excuse for restating it.
 *
 * `restarted` and `failed` are the two that make arriving at the same stage a second time
 * coherent — the varnish was stripped, the coat came out wrong — which is why they are the
 * ones that explain a repeat rather than being one.
 */
export const DIARY_PROJECT_MOVEMENTS = [
  'started',
  'advanced',
  'completed',
  'failed',
  'restarted'
] as const;
export type DiaryProjectMovement = (typeof DIARY_PROJECT_MOVEMENTS)[number];

/** The movements under which a stage may legitimately be reached again. */
export const DIARY_PROJECT_RESET_MOVEMENTS: readonly DiaryProjectMovement[] = [
  'restarted',
  'failed'
] as const;

/**
 * How much of the archive the project ledger is built from, and how much of it is shown.
 *
 * Counted in the writer's own entries rather than in days: duty comes round every fifth day,
 * so eight entries is roughly six weeks — long enough to still know about the bookcase, short
 * enough that a project genuinely abandoned in spring stops being asked after.
 */
export const DIARY_PROJECT_LEDGER = {
  ownEntryLookback: 8,
  maxProjects: 6
} as const;

/**
 * How much of another person was actually on the page (issue #113).
 *
 * `none` — nobody else acted or spoke; whatever others think reaches the entry only as the
 * writer's account of it. `reported` — someone else is in the entry, but summarized: they
 * "had argued", they "would have said". `direct` — somebody acts or answers in the entry's
 * own present, and the writer has to deal with what they did.
 *
 * The distinction that matters is the middle one. Sarah's 2026-08-14 entry contains a real
 * disagreement with Alex and still reads as an essay, because the disagreement is reported as
 * evidence for a position rather than happening on the page. A scale that only asked "was
 * another juror in it" would have scored that entry full marks.
 */
export const DIARY_INTERACTION_LEVELS = ['none', 'reported', 'direct'] as const;
export type DiaryInteractionLevel = (typeof DIARY_INTERACTION_LEVELS)[number];

/**
 * How much of the entry was the argument rather than the day (issue #113).
 *
 * `scene` — mostly what happened, with the thinking left where it fell. `mixed` — an event and
 * a reflection, neither reducible to the other. `argument` — mostly the position, with the
 * day's details supplied to support it.
 *
 * None of the three is wrong. `argument` is a legitimate day and is published like any other;
 * what the prompt is steering is a whole rotation of them.
 */
export const DIARY_ABSTRACTION_LEVELS = ['scene', 'mixed', 'argument'] as const;
export type DiaryAbstractionLevel = (typeof DIARY_ABSTRACTION_LEVELS)[number];

/**
 * The cross-juror recent cycle (issue #113): how many of the newest entries are shown back as
 * how they spent the day, and how many of them arguing a position with nothing happening makes
 * a run worth naming.
 *
 * Five is one full rotation, so each diarist's latest appears exactly once and the writer sees
 * the diary rather than its own history — which is the point here, since Sarah and Marcus wrote
 * the same *kind* of entry on consecutive days with no motif and no vocabulary in common.
 *
 * Three of five is a majority of the cycle and still leaves the pattern deniable, which is the
 * right threshold for something whose only power is a paragraph of prompt text.
 */
export const DIARY_RECENT_CYCLE = {
  entryCount: 5,
  essayRun: 3
} as const;

/**
 * Explicit reading: how far back a juror may be handed someone else's entry to read, and how
 * much of it they get. They get the body rather than the excerpt used for ambient context —
 * "read this" and "glance at this" should not be the same input.
 */
export const DIARY_READING = {
  lookbackDays: 21,
  bodyChars: 1400
} as const;

export const DIARY_THEMES = ['work', 'private', 'mixed', 'relationship', 'memory'] as const;
export const DiaryThemeSchema = z.enum(DIARY_THEMES);
export type DiaryTheme = z.infer<typeof DiaryThemeSchema>;

/**
 * Weighted theme distribution. Code picks the theme deterministically and tells Gemini which
 * one it is — the model never chooses, so a re-run of the same date produces the same brief.
 */
export const DIARY_THEME_WEIGHTS: ReadonlyArray<readonly [DiaryTheme, number]> = [
  ['work', 0.30],
  ['private', 0.30],
  ['mixed', 0.25],
  ['relationship', 0.10],
  ['memory', 0.05]
] as const;

/** Everyday-life categories offered to the model on private/mixed days. */
export const DIARY_EVENT_CATEGORIES = [
  'home',
  'family',
  'friendship',
  'hobby',
  'food',
  'weather',
  'small_failure',
  'small_success',
  'memory',
  'encounter',
  'rest',
  'possession',
  'routine'
] as const;
export const DiaryEventCategorySchema = z.enum(DIARY_EVENT_CATEGORIES);
export type DiaryEventCategory = z.infer<typeof DiaryEventCategorySchema>;

/** Canon fact kinds. Additive only — an existing fact is never replaced by a generation. */
export const DIARY_CANON_FACT_TYPES = [
  'home',
  'companion',
  'hobby',
  'habit',
  'weakness',
  'possession',
  'place',
  'past_event',
  'other'
] as const;
export const DiaryCanonFactTypeSchema = z.enum(DIARY_CANON_FACT_TYPES);
export type DiaryCanonFactType = z.infer<typeof DiaryCanonFactTypeSchema>;

/**
 * Per-response patch limits. A persona must not lurch: one day may nudge a relationship or a
 * trait, never rewrite one. Enforced in lib/diary/validator.ts as errors — a model that
 * overshoots is a structural failure, never silently clamped (clamping would hide a prompt
 * regression behind plausible-looking state).
 *
 * Two exceptions, and they are the two fields that reach no state file: `contradictionNotes`
 * and `projectUpdates` are truncated with a warning instead. An overage there costs the next
 * prompt some context and costs the day nothing, so failing on it would buy caution at the
 * price of an entry — and the prompt says so, because a limit described as fatal when it is
 * not is the same defect as one the prompt withholds.
 */
export const DIARY_PATCH_LIMITS = {
  relationshipPatches: 2,
  relationshipDelta: 0.05,
  traitAdjustments: 2,
  traitDelta: 0.05,
  beliefAdjustments: 1,
  beliefConfidenceDelta: 0.1,
  addRecentConcerns: 2,
  addUnresolvedThoughts: 2,
  resolveUnresolvedThoughts: 3,
  addCurrentConcerns: 2,
  resolveCurrentConcerns: 3,
  addOngoingActivities: 1,
  completeOngoingActivities: 2,
  addRecentEvents: 2,
  addUnresolvedThreads: 1,
  resolveUnresolvedThreads: 2,
  contradictionNotes: 3,
  projectUpdates: 3
} as const;

/**
 * Float slack for delta bounds. A model that answers 0.05 may serialize 0.050000000000000003;
 * that is the same number, not an overshoot, and failing the day over IEEE-754 would be absurd.
 */
export const DIARY_DELTA_EPSILON = 1e-9;

/**
 * The scale of `memoryCandidate.importance`, exported so the prompt and the validator can only
 * ever quote the same numbers.
 *
 * It is a *weight*, not a delta: it decides nothing except which memory is dropped first once
 * the store is full. The validator has always required this range; until 2026-08-01 the prompt
 * never said so, and a model told only that a memory should be "worth remembering months from
 * now" answered 2 — a perfectly sensible reading of an unstated 1–5 rating. That cost an entire
 * day, which is why the bound now lives in one place and is interpolated into the instruction.
 */
export const DIARY_MEMORY_IMPORTANCE = { min: 0, max: 1 } as const;

/**
 * Structural language floors. These decide publication, so they test for *structural*
 * defects — an empty side, a stub, an untranslated Japanese field — and not for style.
 * Clumsy phrasing, drifting irony and imperfect register are accepted results (brief §6.2).
 */
export const DIARY_TEXT_LIMITS = {
  minBodyEn: 400,
  minBodyJa: 200,
  minTitle: 2,
  minMood: 2,
  minShareQuote: 10,
  maxShareQuote: 600,
  /** len(ja)/len(en); Japanese is denser, so the band is wide and only catches stubs. */
  minLengthRatio: 0.2,
  maxLengthRatio: 3.0,
  /** Share of hiragana/katakana/kanji in body.ja — catches English pasted into the ja field. */
  minJapaneseRatio: 0.15
} as const;

const LocalizedTextSchema = z.object({
  en: z.string(),
  ja: z.string()
});
export type LocalizedText = z.infer<typeof LocalizedTextSchema>;

const TraitAdjustmentSchema = z.object({
  trait: z.string(),
  delta: z.number(),
  reason: z.string()
});

const BeliefAdjustmentSchema = z.object({
  belief: z.string(),
  confidenceDelta: z.number(),
  reason: z.string()
});

const CharacterStatePatchSchema = z.object({
  currentMood: z.string(),
  addRecentConcerns: z.array(z.string()),
  addUnresolvedThoughts: z.array(z.string()),
  resolveUnresolvedThoughts: z.array(z.string()),
  traitAdjustments: z.array(TraitAdjustmentSchema),
  beliefAdjustments: z.array(BeliefAdjustmentSchema)
});

const LifeStatePatchSchema = z.object({
  addCurrentConcerns: z.array(z.string()),
  resolveCurrentConcerns: z.array(z.string()),
  addOngoingActivities: z.array(z.string()),
  completeOngoingActivities: z.array(z.string()),
  addRecentEvents: z.array(z.string()),
  addUnresolvedThreads: z.array(z.string()),
  resolveUnresolvedThreads: z.array(z.string())
});

const RelationshipPatchSchema = z.object({
  targetJurorId: z.string(),
  trustDelta: z.number(),
  respectDelta: z.number(),
  tensionDelta: z.number(),
  currentView: z.string(),
  unresolvedIncident: z.string().nullable(),
  reason: z.string()
});

/**
 * `importance` is deliberately an unbounded `z.number()` here, and bounded in the validator
 * instead. This schema is the one the validator parses with, and a `.min().max()` failure would
 * return early as a generic `DIARY_SCHEMA_VALIDATION_FAILED` — shadowing the purpose-built
 * `DIARY_IMPORTANCE_OUT_OF_BOUNDS`, which names the field, the value and the range. Keeping the
 * range out of the shape buys a diagnosable failure at no cost: the same day is excluded either
 * way, and only the message differs.
 */
const MemoryCandidateSchema = z.object({
  summary: z.string(),
  importance: z.number(),
  tags: z.array(z.string())
});

const CanonCandidateSchema = z.object({
  factType: z.string(),
  fact: z.string(),
  reason: z.string()
});

const ContradictionNoteSchema = z.object({
  previousState: z.string(),
  currentState: z.string(),
  interpretation: z.string()
});

/**
 * The entry this juror read today and is answering.
 *
 * Only the link is on the wire. The reaction itself is the diary body — asking the model for
 * a separate summary line would duplicate prose it has already written, and give it a second
 * chance to say something the entry does not.
 *
 * Code assigns the target and records it, so this field is an echo the validator checks, not
 * a choice: a juror cannot claim to have answered something they were never given.
 */
const RespondsToSchema = z.object({
  diaryId: z.string()
});

/**
 * What the entry was about, in the writer's own words — the four fields issue #110 asks for.
 *
 * This is the only part of the response that describes the entry rather than being it, and it
 * exists for exactly one consumer: tomorrow's prompt. Three consecutive Alex entries centred on
 * the same typewriter ribbon and the same friction thesis because nothing in the context said
 * what the previous days had been *about* — the bodies were there, but a body does not announce
 * its own centre, and asking a model to infer two centres before writing a third is asking it
 * to do the work twice.
 *
 * `anchorObject` is nullable because plenty of days have no object at their centre, and a model
 * forced to name one would invent a prop to fill the field — manufacturing exactly the
 * object-centred entry this is meant to loosen. `sceneEvent` is nullable for the same reason and
 * with the opposite consequence: a day where nothing observably happened has to be able to say
 * so, or the field becomes a place to write down the event the entry did not contain.
 *
 * The three scene fields answer issue #113, where the four above could not. Sarah's 2026-08-14
 * and Marcus's 2026-08-15 entries share no subject, no object and no argument — #110's machinery
 * sees two unrelated days — and read alike anyway, because both state a professional position,
 * spend the middle proving it, and close on a general principle. What they have in common is not
 * a centre but a *mode*, so the writer is asked what happened in the entry, how much of another
 * person was in it, and how much of it was the argument.
 *
 * `interactionLevel` and `abstractionLevel` are plain strings on the wire, with the accepted
 * values enforced by the validator as a warning, for the same reason as `projectUpdates.movement`:
 * these fields feed tomorrow's prompt and nothing else, and a word this pipeline does not
 * recognise must cost the next entry a line of context, never cost this entry its publication.
 *
 * Self-reported, therefore fallible: a writer may describe the day it meant to write rather
 * than the one it wrote. That is accepted. The alternative is a second model call to summarize
 * the first, which JuryDiary does not have and will not buy (brief §12.2), and a wrong focus
 * costs a nudge, never a day — nothing structural is decided here.
 */
const EntryFocusSchema = z.object({
  dominantSubject: z.string(),
  anchorObject: z.string().nullable(),
  centralTension: z.string(),
  endingState: z.string(),
  sceneEvent: z.string().nullable(),
  interactionLevel: z.string(),
  abstractionLevel: z.string()
});

export type DiaryEntryFocus = z.infer<typeof EntryFocusSchema>;

/**
 * The stored shape of the focus. Identical to the wire shape once parsed, and tolerant of the
 * three fields issue #113 added: an entry written under diary-v5 or v6 described its centre and
 * had no vocabulary for its scene, and defaulting those to "unstated" is the honest reading.
 * Guessing an abstraction level for a body nobody scored would be inventing the very signal the
 * next prompt is about to quote back.
 *
 * The context builder skips a focus whose scene half is entirely unstated rather than showing a
 * row of blanks, so an older entry costs the cycle a line and nothing else.
 */
const StoredEntryFocusSchema = EntryFocusSchema.extend({
  sceneEvent: z.string().nullable().default(null),
  interactionLevel: z.string().default(''),
  abstractionLevel: z.string().default('')
});

/**
 * Where this entry left an ongoing project — the fix for issue #111.
 *
 * David applied "the third coat of varnish to the cedar bookcase" on 2026-08-02 and was "on
 * the third coat of varnish on the cedar bookcase" again on 2026-08-12, with nothing in
 * between saying the coat had been stripped or had failed. Both entries are good; together
 * they are a project that reset instead of advancing, and nothing in the context could have
 * prevented it, because the only trace the bookcase left was a life-state line frozen at
 * "Applying another coat of varnish to a custom-built cedar bookcase" — a stage, restated as
 * an activity, with no record of which coat, when, or what happened to it.
 *
 * So the writer states it: the project, the stage it now stands at, and what today did to it.
 * The writer's own recent updates are read back on their next duty day, so the next entry
 * resumes from a stage rather than re-inventing one.
 *
 * `movement` is a plain string on the wire, with the accepted values enforced by the validator
 * as a warning rather than by the shape. This field feeds tomorrow's prompt and nothing else,
 * exactly like `entryFocus`: a word this pipeline does not recognise must cost the next entry
 * one line of context, never cost this entry its publication.
 */
const ProjectUpdateSchema = z.object({
  project: z.string(),
  stage: z.string(),
  movement: z.string()
});

export type DiaryProjectUpdate = z.infer<typeof ProjectUpdateSchema>;

/**
 * The wire schema. Every field is required (empty arrays and explicit nulls are how a juror
 * says "nothing today"), because a fully-populated envelope is far more predictable from a
 * Flash model than a sparse one — and a missing key is then unambiguously a defect.
 *
 * There is no field here through which Core Persona could be edited, by design: Core Persona
 * lives in the public rubric config that this pipeline only ever reads (brief §8.1).
 */
export const DiaryResponseGenSchema = z.object({
  schemaVersion: z.literal(DIARY_RESPONSE_SCHEMA_VERSION),
  date: z.string(),
  jurorId: z.string(),
  theme: z.string(),
  privateEventCategory: z.string().nullable(),
  diary: z.object({
    title: LocalizedTextSchema,
    body: LocalizedTextSchema,
    mood: LocalizedTextSchema,
    shareQuote: LocalizedTextSchema
  }),
  relatedReviewIds: z.array(z.string()),
  respondsTo: RespondsToSchema.nullable(),
  entryFocus: EntryFocusSchema,
  projectUpdates: z.array(ProjectUpdateSchema),
  characterStatePatch: CharacterStatePatchSchema,
  lifeStatePatch: LifeStatePatchSchema,
  relationshipPatches: z.array(RelationshipPatchSchema),
  memoryCandidate: MemoryCandidateSchema.nullable(),
  canonCandidate: CanonCandidateSchema.nullable(),
  contradictionNotes: z.array(ContradictionNoteSchema)
});

export type DiaryResponse = z.infer<typeof DiaryResponseGenSchema>;
export type DiaryCharacterStatePatch = z.infer<typeof CharacterStatePatchSchema>;
export type DiaryLifeStatePatch = z.infer<typeof LifeStatePatchSchema>;
export type DiaryRelationshipPatch = z.infer<typeof RelationshipPatchSchema>;
export type DiaryMemoryCandidate = z.infer<typeof MemoryCandidateSchema>;
export type DiaryCanonCandidate = z.infer<typeof CanonCandidateSchema>;
export type DiaryContradictionNote = z.infer<typeof ContradictionNoteSchema>;

/**
 * Top-level strictness rejects a response that invents a sibling of the known fields — the
 * shape a "let me also update the persona" hallucination would take. Nested unknown keys are
 * stripped rather than rejected, which is equally safe: the patch engine reads named fields
 * only, so anything it does not know about cannot reach a state file.
 */
export const DiaryResponseStrictSchema = DiaryResponseGenSchema.strict();

/** The published entry: presentation fields only. Internal state never appears here. */
export const DiaryEntrySchema = z.object({
  schema_version: z.literal('1.0'),
  id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  jurorId: JudgeSlugSchema,
  theme: DiaryThemeSchema,
  privateEventCategory: DiaryEventCategorySchema.nullable(),
  title: LocalizedTextSchema,
  body: LocalizedTextSchema,
  mood: LocalizedTextSchema,
  shareQuote: LocalizedTextSchema,
  relatedReviewSlugs: z.array(z.string()),
  /**
   * The entry this one answers, when the juror was given one to read. Nullable with a default
   * so entries written before explicit reading existed remain valid: "responds to nothing" and
   * "was written before replies existed" mean the same thing to a reader.
   */
  respondsToDiaryId: z.string().nullable().default(null),
  /**
   * What this entry was about, as its writer described it. Nullable with a default for the
   * same reason as `respondsToDiaryId`: entries written before focus existed stay valid, and
   * the context builder treats a missing focus as one it simply cannot show.
   */
  entryFocus: StoredEntryFocusSchema.nullable().default(null),
  /**
   * Where this entry left each ongoing project it touched (issue #111). Defaulted for the same
   * reason as `entryFocus`: entries written before project continuity existed carry none, and
   * "this entry moved no project" and "this entry predates the ledger" both read as an empty
   * list to the builder.
   */
  projectUpdates: z.array(ProjectUpdateSchema).default([]),
  publishedAt: z.string().min(1),
  generation: z.object({
    model: z.string().nullable(),
    promptVersion: z.string()
  })
});

export type DiaryEntry = z.infer<typeof DiaryEntrySchema>;

/** Builds the canonical entry/event/record id for a duty day. One day, one juror, one id. */
export function buildDiaryId(date: string, jurorId: string): string {
  return `diary-${date}-${jurorId}`;
}
