import { z } from 'zod';

export const JudgeSlugSchema = z.enum(['alex', 'david', 'lisa', 'sarah', 'marcus']);
export type JudgeSlug = z.infer<typeof JudgeSlugSchema>;

export const JUDGE_SLUGS = ['alex', 'david', 'lisa', 'sarah', 'marcus'] as const;

export const EvaluationLensSchema = z.object({
  label: z.string().min(1),
  question: z.string().min(1),
});

export const JudgeProfileSchema = z.object({
  sourceId: z.string(),
  slug: JudgeSlugSchema,
  name: z.string().min(1),
  role: z.string().min(1),
  avatarPath: z.string().min(1),
  background: z.string().min(1),
  personalityAndTone: z.string().min(1),
  expertise: z.array(z.string()).min(1),
  loves: z.array(z.string()).min(1),
  hates: z.array(z.string()).min(1),
  evaluationLenses: z.array(EvaluationLensSchema).min(1),
});

export type JudgeProfile = z.infer<typeof JudgeProfileSchema>;
export type EvaluationLens = z.infer<typeof EvaluationLensSchema>;

export const RubricCriterionSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  weight: z.number().min(1),
  whatJudgesEvaluate: z.array(z.string()).min(1),
  strongSignals: z.array(z.string()).min(1),
});

export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;
