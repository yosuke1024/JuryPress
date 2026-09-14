import { z } from 'zod';

/**
 * The consumer's copy of the catalog contract.
 *
 * The contract is *owned* by the oss-selfhosting repository, which ships the JSON Schema and
 * the validator that gates changes to it. This file is the reading half: it accepts what that
 * contract produces and refuses everything else, so a record that would not have passed the
 * catalog's own CI cannot reach a page here either.
 *
 * It is deliberately strict rather than permissive. An unknown field means the catalog moved
 * ahead of this site, and rendering a record we only partly understand is how a claim nobody
 * reviewed reaches a reader.
 */

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).min(2).max(64);
const reviewSlug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{6}(?:-r[0-9a-f]{7})?$/);
const httpsUrl = z.string().url().startsWith('https://').max(2048);
const date = z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const text = z.string().min(1).max(500);
const longText = z.string().min(1).max(2000);

export const CHECK_RESULTS = ['passed', 'failed', 'not_tested', 'not_applicable'] as const;
export const WORK_STATES = ['draft', 'ai_prepared', 'awaiting_human_verification', 'verified'] as const;
export const LISTING_STATES = ['unlisted', 'tested', 'experimental', 'retired'] as const;
export const TEMPLATE_TYPES = ['official', 'community', 'maintained_here'] as const;

export const ProductRecordSchema = z.object({
  schema_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  data_class: z.enum(['production', 'fixture']),
  product: z.object({
    slug,
    name: text,
    summary: longText,
    upstream: z.object({
      repo_url: httpsUrl,
      homepage_url: httpsUrl.optional(),
      license: z.string().min(1).max(100),
      license_url: httpsUrl.optional(),
      self_hosting_permitted: z.boolean()
    }).strict()
  }).strict(),
  review: z.object({
    review_slug: reviewSlug,
    review_url: httpsUrl
  }).strict(),
  discovery: z.object({
    categories: z.array(slug).min(1).max(5),
    use_cases: z.array(text).min(1).max(8),
    search_terms: z.array(text).max(20).optional()
  }).strict(),
  deployment: z.object({
    provider: slug,
    template_type: z.enum(TEMPLATE_TYPES),
    route_url: httpsUrl.optional(),
    route_provenance: longText.optional(),
    maintained_path: z.string().max(256).optional(),
    guide_path: z.string().max(256).optional(),
    dependent_services: z.array(
      z.object({
        name: text,
        required: z.boolean(),
        supplied_by: z.enum(['reader', 'provider', 'bundled']),
        note: text.optional()
      }).strict()
    ).max(20),
    constraints: z.array(longText).max(20).optional()
  }).strict(),
  states: z.object({
    work_state: z.enum(WORK_STATES),
    listing_state: z.enum(LISTING_STATES),
    approval: z.object({
      approved: z.literal(true),
      approved_by: text,
      approved_at: date,
      approved_config_digest: sha256,
      approval_reference: httpsUrl.optional()
    }).strict().optional(),
    retirement: z.object({
      retired_at: date,
      reason: longText
    }).strict().optional()
  }).strict(),
  verification: z.object({
    verifier: text,
    verified_at: date,
    target: z.object({
      upstream_commit: z.string().regex(/^[0-9a-f]{40}$/).optional(),
      upstream_version: text.optional(),
      image_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
      template_revision: text.optional()
    }).strict(),
    checks: z.array(
      z.object({
        check_id: slug,
        result: z.enum(CHECK_RESULTS),
        reason: longText.optional(),
        note: longText.optional()
      }).strict()
    ),
    not_tested: z.array(longText).max(20).optional(),
    config_digest: sha256
  }).strict().optional(),
  notes_paths: z.array(z.string().max(256)).optional()
}).strict();

export type ProductRecord = z.infer<typeof ProductRecordSchema>;

export const CheckSuiteSchema = z.object({
  schema_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  data_class: z.enum(['production', 'fixture']),
  checks: z.array(
    z.object({
      check_id: slug,
      title: text,
      required: z.boolean(),
      what_to_do: longText,
      passing_criteria: longText,
      automatable: z.boolean().optional()
    }).strict()
  ).min(1).max(50)
}).strict();

export type CheckSuite = z.infer<typeof CheckSuiteSchema>;
