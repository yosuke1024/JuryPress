import { z } from 'zod';
import { JUDGE_SLUGS } from './jury';
import { DIARY_CANON_FACT_TYPES } from './diary';

/**
 * The one-off request that gives all five jurors a fictional life to start from.
 *
 * Deliberately thin. The brief's instruction is to under-specify (§8.2): a juror with a
 * fully-furnished backstory has nothing left to discover, and the point of the experiment is
 * to watch a life accumulate from the diaries themselves. So this asks for a handful of
 * anchors and nothing more.
 *
 * The model is never asked for a number. Trust, respect and tension are written by code at
 * their neutral values, because a model asked to invent relationship scores produces a cast
 * of allies and rivals on day one, which is the opposite of watching relationships form.
 */

export const DIARY_BOOTSTRAP_SCHEMA_VERSION = '1.0';
export const DIARY_BOOTSTRAP_PROMPT_VERSION = 'diary-bootstrap-v1';

/** Bounds for one juror's starting canon, mirroring brief §8.2. */
export const DIARY_BOOTSTRAP_LIMITS = {
  minFacts: 4,
  maxFacts: 9,
  requiredHomeFacts: 1
} as const;

const BootstrapFactSchema = z.object({
  factType: z.string(),
  fact: z.string()
});

const BootstrapJurorSchema = z.object({
  jurorId: z.string(),
  /** One home, up to one close person, two hobbies, two habits, one weakness, one object/place. */
  canonFacts: z.array(BootstrapFactSchema),
  currentMood: z.string(),
  initialConcern: z.string(),
  ongoingActivity: z.string(),
  viewsOfPeers: z.array(
    z.object({
      targetJurorId: z.string(),
      currentView: z.string()
    })
  )
});

export const DiaryBootstrapResponseGenSchema = z.object({
  schemaVersion: z.literal(DIARY_BOOTSTRAP_SCHEMA_VERSION),
  jurors: z.array(BootstrapJurorSchema)
});

export type DiaryBootstrapResponse = z.infer<typeof DiaryBootstrapResponseGenSchema>;
export type DiaryBootstrapJuror = z.infer<typeof BootstrapJurorSchema>;

export interface DiaryBootstrapValidation {
  status: 'passed' | 'failed';
  errors: string[];
  response: DiaryBootstrapResponse | null;
}

/**
 * Structural check only — the same standard the daily gate applies. Whether the five invented
 * lives are *interesting* is not something this can decide, and whether they are too similar
 * is a judgement for the operator reading the bootstrap output once (brief §16).
 */
export function validateDiaryBootstrapResponse(parsed: unknown): DiaryBootstrapValidation {
  const errors: string[] = [];

  const result = DiaryBootstrapResponseGenSchema.safeParse(parsed);
  if (!result.success) {
    return {
      status: 'failed',
      errors: result.error.issues.slice(0, 20).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      response: null
    };
  }

  const response = result.data;
  const seen = new Set<string>();

  for (const juror of response.jurors) {
    if (!JUDGE_SLUGS.includes(juror.jurorId as (typeof JUDGE_SLUGS)[number])) {
      errors.push(`Unknown juror: ${juror.jurorId}`);
      continue;
    }
    if (seen.has(juror.jurorId)) errors.push(`Duplicate juror: ${juror.jurorId}`);
    seen.add(juror.jurorId);

    if (
      juror.canonFacts.length < DIARY_BOOTSTRAP_LIMITS.minFacts ||
      juror.canonFacts.length > DIARY_BOOTSTRAP_LIMITS.maxFacts
    ) {
      errors.push(
        `${juror.jurorId}: expected ${DIARY_BOOTSTRAP_LIMITS.minFacts}–${DIARY_BOOTSTRAP_LIMITS.maxFacts} canon facts, got ${juror.canonFacts.length}`
      );
    }

    for (const fact of juror.canonFacts) {
      if (!DIARY_CANON_FACT_TYPES.includes(fact.factType as (typeof DIARY_CANON_FACT_TYPES)[number])) {
        errors.push(`${juror.jurorId}: unknown canon fact type "${fact.factType}"`);
      }
      if (fact.fact.trim().length === 0) {
        errors.push(`${juror.jurorId}: empty canon fact`);
      }
    }

    const homeFacts = juror.canonFacts.filter((fact) => fact.factType === 'home');
    if (homeFacts.length !== DIARY_BOOTSTRAP_LIMITS.requiredHomeFacts) {
      errors.push(`${juror.jurorId}: expected exactly one home fact, got ${homeFacts.length}`);
    }

    if (juror.currentMood.trim().length === 0) errors.push(`${juror.jurorId}: empty mood`);
    if (juror.initialConcern.trim().length === 0) errors.push(`${juror.jurorId}: empty initial concern`);
    if (juror.ongoingActivity.trim().length === 0) errors.push(`${juror.jurorId}: empty ongoing activity`);

    const expectedPeers = JUDGE_SLUGS.filter((slug) => slug !== juror.jurorId).sort();
    const actualPeers = [...new Set(juror.viewsOfPeers.map((view) => view.targetJurorId))].sort();
    if (
      expectedPeers.length !== actualPeers.length ||
      expectedPeers.some((slug, index) => slug !== actualPeers[index])
    ) {
      errors.push(
        `${juror.jurorId}: viewsOfPeers must cover exactly [${expectedPeers.join(', ')}], got [${actualPeers.join(', ')}]`
      );
    }
  }

  if (seen.size !== JUDGE_SLUGS.length) {
    errors.push(`Expected all ${JUDGE_SLUGS.length} jurors, got ${seen.size}`);
  }

  return errors.length > 0
    ? { status: 'failed', errors, response: null }
    : { status: 'passed', errors: [], response };
}
