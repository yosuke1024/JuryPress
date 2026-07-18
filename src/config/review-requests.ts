/**
 * Shared configuration for the reader review-request feature.
 *
 * Used by the request page, the Cloudflare Worker API, the operator CLI and the
 * publish_request pipeline so the target repository, labels and limits can never drift
 * between surfaces.
 */

/** The public repository that owns review-request issues. */
export const REVIEW_REQUEST_REPO = 'yosuke1024/JuryPress';

/** Origin allowed to call the review-request API (same-origin only). */
export const REVIEW_REQUEST_PRODUCTION_ORIGIN = 'https://pixapps.ai';

/** Public site prefix used to build article URLs for issue notifications. */
export const REVIEW_REQUEST_SITE_PREFIX = 'https://pixapps.ai/jurypress';

/** Turnstile action bound to the request form; siteverify must echo it back. */
export const REVIEW_REQUEST_TURNSTILE_ACTION = 'review-request';

export const REVIEW_REQUEST_LABELS = {
  request: 'review-request',
  awaitingOperator: 'review:awaiting-operator',
  processing: 'review:processing',
  published: 'review:published',
  declined: 'review:declined',
  retryNeeded: 'review:retry-needed'
} as const;

export const REVIEW_REQUEST_LIMITS = {
  productNameMin: 1,
  productNameMax: 120,
  purposeMin: 20,
  purposeMax: 500,
  additionalUrlsMax: 5,
  urlMaxLength: 2048,
  /** Maximum accepted API request body, in bytes. */
  requestBodyMaxBytes: 32 * 1024,
  /** Maximum issue body size the workflow will parse (GitHub caps at 65536 chars). */
  issueBodyMaxLength: 60000
} as const;

/** Machine-readable block marker; versioned so future formats can coexist. */
export const REVIEW_REQUEST_BLOCK_MARKER = 'jurypress-review-request:v1';

/** Schema versions the current pipeline understands. */
export const REVIEW_REQUEST_SUPPORTED_SCHEMA_VERSIONS = ['1.0.0'] as const;
