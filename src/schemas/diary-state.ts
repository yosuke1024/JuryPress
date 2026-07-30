import { z } from 'zod';
import { JudgeSlugSchema, JUDGE_SLUGS, type JudgeSlug } from './jury';
import { DiaryCanonFactTypeSchema } from './diary';

/**
 * JuryDiary persona state — the four mutable layers beneath Core Persona (brief §8).
 *
 * Core Persona is absent from this file on purpose. It lives in the public rubric config
 * (`config/rubrics/open-source-product-v2.json`, read through lib/jury.ts) which the diary
 * pipeline only ever reads. There is no writable representation of it anywhere in JuryDiary,
 * which is a stronger guarantee than a schema rule: nothing can edit a file that does not exist.
 *
 * Every state file carries the same envelope so that `lastEventId` — the applied-event marker
 * that makes patch application idempotent — is uniform across all five.
 */

export const DIARY_STATE_SCHEMA_VERSION = '1.0';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Ceilings for accumulating state. Recent-state lists are working memory, not an archive:
 * anything older than the cap is pruned when a new day arrives, and what deserves to outlive
 * it is promoted by the model as a memory candidate instead (brief §8.4). The full history
 * survives regardless — every prune is recorded in that day's event file and in git.
 */
export const DIARY_STATE_CAPS = {
  recentConcerns: 6,
  emergingTraits: 8,
  beliefsUnderPressure: 5,
  unresolvedThoughts: 6,
  currentConcerns: 6,
  ongoingActivities: 5,
  recentEvents: 10,
  unresolvedThreads: 5,
  memories: 60
} as const;

/** Neutral-ish starting point for every pair. Nobody begins as an ally or an enemy (brief §8.5). */
export const DIARY_INITIAL_RELATIONSHIP = {
  trust: 0.5,
  respect: 0.5,
  tension: 0.2
} as const;

export const DiaryConfigSchema = z
  .object({
    schema_version: z.literal('1.0'),
    startDate: z.string().regex(DATE_PATTERN, 'startDate must be YYYY-MM-DD'),
    rotation: z.array(JudgeSlugSchema),
    timezone: z.literal('Asia/Tokyo')
  })
  .superRefine((config, ctx) => {
    // The rotation must be a permutation of the five jurors: a duplicate would give one juror
    // two turns per cycle, and a missing juror would silence them permanently.
    const unique = new Set(config.rotation);
    if (config.rotation.length !== JUDGE_SLUGS.length || unique.size !== JUDGE_SLUGS.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rotation'],
        message: `rotation must list each of the ${JUDGE_SLUGS.length} jurors exactly once.`
      });
    }
  });

export type DiaryConfig = z.infer<typeof DiaryConfigSchema>;

const unitInterval = z.number().min(0).max(1);

function stateEnvelope<T extends z.ZodTypeAny>(state: T) {
  return z.object({
    schema_version: z.literal(DIARY_STATE_SCHEMA_VERSION),
    jurorId: JudgeSlugSchema,
    updatedAt: z.string().min(1),
    /** Id of the last applied diary event; `bootstrap` before any diary has run. */
    lastEventId: z.string().min(1),
    state
  });
}

/* -------------------------------------------------------------------------- */
/* Private Canon — slow-moving fictional life setting. Additive only.          */
/* -------------------------------------------------------------------------- */

export const DiaryCanonFactSchema = z.object({
  id: z.string().min(1),
  factType: DiaryCanonFactTypeSchema,
  fact: z.string().min(1),
  addedOn: z.string().regex(DATE_PATTERN),
  source: z.enum(['bootstrap', 'diary']),
  diaryId: z.string().nullable()
});

export const DiaryPrivateCanonSchema = stateEnvelope(
  z.object({
    facts: z.array(DiaryCanonFactSchema)
  })
);

export type DiaryPrivateCanon = z.infer<typeof DiaryPrivateCanonSchema>;
export type DiaryCanonFact = z.infer<typeof DiaryCanonFactSchema>;

/* -------------------------------------------------------------------------- */
/* Character State — who this juror currently is.                             */
/* -------------------------------------------------------------------------- */

export const DiaryEmergingTraitSchema = z.object({
  trait: z.string().min(1),
  strength: unitInterval,
  evidenceCount: z.number().int().min(0)
});

export const DiaryBeliefUnderPressureSchema = z.object({
  belief: z.string().min(1),
  confidence: unitInterval,
  reason: z.string()
});

export const DiaryCharacterStateSchema = stateEnvelope(
  z.object({
    currentMood: z.string(),
    recentConcerns: z.array(z.string()),
    emergingTraits: z.array(DiaryEmergingTraitSchema),
    beliefsUnderPressure: z.array(DiaryBeliefUnderPressureSchema),
    unresolvedThoughts: z.array(z.string())
  })
);

export type DiaryCharacterState = z.infer<typeof DiaryCharacterStateSchema>;

/* -------------------------------------------------------------------------- */
/* Life State — what is currently going on off the clock.                     */
/* -------------------------------------------------------------------------- */

export const DiaryRecentEventSchema = z.object({
  date: z.string().regex(DATE_PATTERN),
  event: z.string().min(1)
});

export const DiaryLifeStateSchema = stateEnvelope(
  z.object({
    currentConcerns: z.array(z.string()),
    ongoingActivities: z.array(z.string()),
    recentEvents: z.array(DiaryRecentEventSchema),
    unresolvedThreads: z.array(z.string())
  })
);

export type DiaryLifeState = z.infer<typeof DiaryLifeStateSchema>;

/* -------------------------------------------------------------------------- */
/* Relationship State — how this juror sees the other four.                   */
/* -------------------------------------------------------------------------- */

export const DiaryRelationshipSchema = z.object({
  trust: unitInterval,
  respect: unitInterval,
  tension: unitInterval,
  currentView: z.string(),
  unresolvedIncident: z.string().nullable(),
  lastInteractionOn: z.string().regex(DATE_PATTERN).nullable()
});

export const DiaryRelationshipsSchema = stateEnvelope(
  z.record(JudgeSlugSchema, DiaryRelationshipSchema)
).superRefine((doc, ctx) => {
  // Exactly the other four jurors, no self-entry: a self-relationship has no meaning here,
  // and a missing peer would make an interaction with them unrecordable.
  const expected = JUDGE_SLUGS.filter((slug) => slug !== doc.jurorId).sort();
  const actual = Object.keys(doc.state).sort();
  if (expected.length !== actual.length || expected.some((slug, i) => slug !== actual[i])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['state'],
      message: `relationships for ${doc.jurorId} must cover exactly [${expected.join(', ')}], found [${actual.join(', ')}].`
    });
  }
});

export type DiaryRelationships = z.infer<typeof DiaryRelationshipsSchema>;
export type DiaryRelationship = z.infer<typeof DiaryRelationshipSchema>;

/* -------------------------------------------------------------------------- */
/* Memories — long-term, selected by importance rather than recency.          */
/* -------------------------------------------------------------------------- */

export const DiaryMemorySchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  importance: unitInterval,
  tags: z.array(z.string()),
  createdOn: z.string().regex(DATE_PATTERN),
  sourceDiaryId: z.string().min(1)
});

export const DiaryMemoriesSchema = stateEnvelope(
  z.object({
    memories: z.array(DiaryMemorySchema)
  })
);

export type DiaryMemories = z.infer<typeof DiaryMemoriesSchema>;
export type DiaryMemory = z.infer<typeof DiaryMemorySchema>;

/** The five files that together are one juror's mutable self. Always read and written as a set. */
export interface DiaryJurorStates {
  canon: DiaryPrivateCanon;
  character: DiaryCharacterState;
  life: DiaryLifeState;
  relationships: DiaryRelationships;
  memories: DiaryMemories;
}

export const DIARY_STATE_FILES = {
  canon: 'private-canon.json',
  character: 'character-state.json',
  life: 'life-state.json',
  relationships: 'relationships.json',
  memories: 'memories.json'
} as const satisfies Record<keyof DiaryJurorStates, string>;

/** Builds the neutral relationship map a juror starts with, covering exactly their four peers. */
export function buildInitialRelationshipMap(
  jurorId: JudgeSlug,
  views: Partial<Record<JudgeSlug, string>> = {}
): Record<string, z.infer<typeof DiaryRelationshipSchema>> {
  const map: Record<string, z.infer<typeof DiaryRelationshipSchema>> = {};
  for (const slug of JUDGE_SLUGS) {
    if (slug === jurorId) continue;
    map[slug] = {
      trust: DIARY_INITIAL_RELATIONSHIP.trust,
      respect: DIARY_INITIAL_RELATIONSHIP.respect,
      tension: DIARY_INITIAL_RELATIONSHIP.tension,
      currentView: views[slug] ?? '',
      unresolvedIncident: null,
      lastInteractionOn: null
    };
  }
  return map;
}
