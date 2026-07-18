/**
 * Shared configuration for the reader review-request feature.
 *
 * Requests are submitted by readers directly on GitHub through the issue-form template
 * (.github/ISSUE_TEMPLATE/review-request.yml), so a GitHub account is required and each
 * request is authored by the requester's own account. Used by the request page, the
 * operator CLI and the publish_request pipeline so the target repository, labels and
 * limits can never drift between surfaces.
 */

/** The public repository that owns review-request issues. */
export const REVIEW_REQUEST_REPO = 'yosuke1024/JuryPress';

/** Issue-form template filename in .github/ISSUE_TEMPLATE/. */
export const REVIEW_REQUEST_TEMPLATE = 'review-request.yml';

/** Where the request page sends readers to open a new request. */
export const REVIEW_REQUEST_NEW_ISSUE_URL =
  `https://github.com/${REVIEW_REQUEST_REPO}/issues/new?template=${REVIEW_REQUEST_TEMPLATE}`;

/** Public site prefix used to build article URLs for issue notifications. */
export const REVIEW_REQUEST_SITE_PREFIX = 'https://pixapps.ai/jurypress';

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
  /** Maximum issue body size the workflow will parse (GitHub caps at 65536 chars). */
  issueBodyMaxLength: 60000
} as const;
