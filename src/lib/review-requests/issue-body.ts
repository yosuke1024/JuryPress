import {
  REVIEW_REQUEST_BLOCK_MARKER,
  REVIEW_REQUEST_LIMITS
} from '../../config/review-requests';
import {
  ReviewRequestBlockSchema,
  type ReviewRequestBlock
} from '../../schemas/review-request';

/**
 * Builds and parses the review-request issue body.
 *
 * The body has two audiences: a human-readable section for readers and operators, and one
 * versioned machine-readable block for the workflow. The workflow NEVER trusts the
 * markdown section — issue bodies are editable — so parsing is strict: exactly one block,
 * strict JSON, versioned schema, full field re-validation.
 */

/**
 * Escapes requester-supplied text for safe embedding in the issue markdown. Every
 * markdown-significant character is neutralized so user input can never introduce
 * headings, links, HTML or comment terminators.
 */
export function escapeMarkdown(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+\-.!|~])/g, '\\$1');
}

/**
 * Serializes the machine block JSON so it can never terminate the surrounding HTML
 * comment: '<' and '>' are emitted as unicode escapes inside JSON strings, so the byte
 * sequence '-->' cannot occur before the intended terminator. JSON.parse restores them.
 */
function commentSafeJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
}

export interface IssueBodyInput extends ReviewRequestBlock {}

export function buildIssueTitle(productName: string): string {
  // The title is plain text (GitHub never renders markdown in titles); strip only
  // characters that could break list rendering elsewhere.
  return `[Review Request] ${productName}`;
}

export function buildIssueBody(input: IssueBodyInput): string {
  const block = ReviewRequestBlockSchema.parse(input);

  const officialSection = block.official_url
    ? block.official_url
    : '_Not provided._';
  const additionalSection = block.additional_official_urls.length > 0
    ? block.additional_official_urls.map(url => `- ${url}`).join('\n')
    : '_None._';

  const relationshipLabel: Record<ReviewRequestBlock['requester_relationship'], string> = {
    creator_maintainer: 'Creator / Maintainer',
    contributor: 'Contributor',
    user: 'User',
    other: 'Other'
  };

  return [
    '## Product',
    '',
    escapeMarkdown(block.product_name),
    '',
    '## Canonical Repository',
    '',
    block.canonical_repository_url,
    '',
    '## Official Website or Demo',
    '',
    officialSection,
    '',
    '## Purpose',
    '',
    escapeMarkdown(block.purpose),
    '',
    '## Requester Relationship',
    '',
    relationshipLabel[block.requester_relationship],
    '',
    '## Additional Official Sources',
    '',
    additionalSection,
    '',
    '## Request Notice',
    '',
    'This request was submitted through JuryPress. Submission does not guarantee publication or a favorable score.',
    'Progress and the final result will be reported on this issue.',
    '',
    `<!-- ${REVIEW_REQUEST_BLOCK_MARKER}`,
    commentSafeJson(block),
    '-->',
    ''
  ].join('\n');
}

export type IssueBodyParseFailureCode =
  | 'issue_body_missing'
  | 'issue_body_too_large'
  | 'machine_block_missing'
  | 'machine_block_multiple'
  | 'machine_block_malformed'
  | 'machine_block_unsupported_version'
  | 'machine_block_invalid_fields';

export type IssueBodyParseResult =
  | { ok: true; block: ReviewRequestBlock }
  | { ok: false; code: IssueBodyParseFailureCode; detail?: string };

/**
 * Strict parse of the machine-readable block. Never relies on markdown headings — only
 * the versioned comment block counts, and it must appear exactly once.
 */
export function parseReviewRequestIssueBody(body: string | null | undefined): IssueBodyParseResult {
  if (typeof body !== 'string' || body.trim().length === 0) {
    return { ok: false, code: 'issue_body_missing' };
  }
  if (body.length > REVIEW_REQUEST_LIMITS.issueBodyMaxLength) {
    return { ok: false, code: 'issue_body_too_large' };
  }

  const markerCount = body.split(REVIEW_REQUEST_BLOCK_MARKER).length - 1;
  if (markerCount === 0) {
    return { ok: false, code: 'machine_block_missing' };
  }
  if (markerCount > 1) {
    return { ok: false, code: 'machine_block_multiple' };
  }

  const blockPattern = new RegExp(`<!--\\s*${REVIEW_REQUEST_BLOCK_MARKER}\\s*\\n([\\s\\S]*?)-->`);
  const match = body.match(blockPattern);
  if (!match) {
    return { ok: false, code: 'machine_block_malformed', detail: 'marker present but the comment block is not well-formed' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(match[1].trim());
  } catch (e: any) {
    return { ok: false, code: 'machine_block_malformed', detail: 'block payload is not valid JSON' };
  }

  if (typeof parsedJson !== 'object' || parsedJson === null || Array.isArray(parsedJson)) {
    return { ok: false, code: 'machine_block_malformed', detail: 'block payload is not a JSON object' };
  }

  const version = (parsedJson as Record<string, unknown>).schema_version;
  if (typeof version !== 'string' || !ReviewRequestBlockSchema.shape.schema_version.options.includes(version as any)) {
    return { ok: false, code: 'machine_block_unsupported_version', detail: String(version ?? 'missing') };
  }

  const result = ReviewRequestBlockSchema.safeParse(parsedJson);
  if (!result.success) {
    const paths = Array.from(new Set(result.error.issues.map(i => i.path.join('.') || '$'))).join(', ');
    return { ok: false, code: 'machine_block_invalid_fields', detail: paths };
  }

  return { ok: true, block: result.data };
}
