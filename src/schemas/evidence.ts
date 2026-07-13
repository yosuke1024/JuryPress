import { z } from 'zod';

export const EvidenceSchema = z.object({
  evidence_id: z.string(),
  type: z.string(),
  url: z.string().url(),
  title: z.string(),
  retrieved_at: z.string(),
  content_hash: z.string(),
  summary: z.string(),
  claims: z.array(z.object({
    text: z.string(),
    claim_type: z.enum(["verified_fact", "creator_claim", "inference", "unknown"])
  }))
});

export type Evidence = z.infer<typeof EvidenceSchema>;
