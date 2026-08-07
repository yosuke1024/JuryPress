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

export const DIARY_RESPONSE_SCHEMA_VERSION = '1.1';
/** v4: names the prop→metaphor→lesson arc as the default to avoid and shows recent openings/closings (issue #105). */
export const DIARY_PROMPT_VERSION = 'diary-v4';
export const DIARY_VALIDATOR_VERSION = 'diary-validator-1.1.0';

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
  contradictionNotes: 3
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
