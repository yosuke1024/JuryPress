import { REVIEW_REQUEST_LIMITS } from '../../config/review-requests';
import {
  REQUESTER_RELATIONSHIPS,
  ReviewRequestFormSchema,
  type RequesterRelationship,
  type ReviewRequestForm
} from '../../schemas/review-request';

/**
 * Parses the body of a review-request issue submitted through the GitHub issue form
 * (.github/ISSUE_TEMPLATE/review-request.yml).
 *
 * GitHub renders each form field as a `### <label>` section, so the section labels are a
 * stable, machine-generated contract with the template. The body is still editable after
 * creation, so nothing here is trusted: every section must be present exactly once and
 * every value is fully re-validated (URL rules, bounds, enums) before any pipeline work.
 */

/** Section labels — must match the issue-form template labels exactly. */
export const FORM_SECTION_LABELS = {
  productName: 'Product name',
  canonicalRepositoryUrl: 'Canonical public repository URL',
  purpose: 'One-sentence purpose',
  requesterRelationship: 'Your relationship to the product',
  officialUrl: 'Official website / Demo URL',
  additionalOfficialUrls: 'Additional official documentation URLs',
  acknowledgement: 'Acknowledgement'
} as const;

const RELATIONSHIP_LABELS: Record<string, RequesterRelationship> = {
  'Creator / Maintainer': 'creator_maintainer',
  'Contributor': 'contributor',
  'User': 'user',
  'Other': 'other'
};

/** GitHub inserts this placeholder for optional form fields left empty. */
const NO_RESPONSE = '_no response_';

export type IssueBodyParseFailureCode =
  | 'issue_body_missing'
  | 'issue_body_too_large'
  | 'form_section_missing'
  | 'form_section_duplicated'
  | 'form_field_invalid'
  | 'acknowledgement_missing';

export type IssueBodyParseResult =
  | { ok: true; request: ReviewRequestForm }
  | { ok: false; code: IssueBodyParseFailureCode; detail?: string };

function sectionValue(sections: Map<string, string>, label: string): string | null {
  const raw = sections.get(label);
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === NO_RESPONSE) return null;
  return trimmed;
}

/** Collapses editor line breaks and runs of whitespace into single spaces. */
function normalizeSingleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function parseReviewRequestIssueBody(body: string | null | undefined): IssueBodyParseResult {
  if (typeof body !== 'string' || body.trim().length === 0) {
    return { ok: false, code: 'issue_body_missing' };
  }
  if (body.length > REVIEW_REQUEST_LIMITS.issueBodyMaxLength) {
    return { ok: false, code: 'issue_body_too_large' };
  }

  // Split into `### <label>` sections. Content before the first heading is ignored.
  const sections = new Map<string, string>();
  const pattern = /^### (.+?)\s*$/gm;
  const matches = [...body.matchAll(pattern)];
  for (let i = 0; i < matches.length; i++) {
    const label = matches[i][1].trim();
    const start = (matches[i].index ?? 0) + matches[i][0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? body.length) : body.length;
    if (sections.has(label)) {
      return { ok: false, code: 'form_section_duplicated', detail: label };
    }
    sections.set(label, body.slice(start, end));
  }

  for (const label of [
    FORM_SECTION_LABELS.productName,
    FORM_SECTION_LABELS.canonicalRepositoryUrl,
    FORM_SECTION_LABELS.purpose,
    FORM_SECTION_LABELS.requesterRelationship,
    FORM_SECTION_LABELS.acknowledgement
  ]) {
    if (!sections.has(label)) {
      return { ok: false, code: 'form_section_missing', detail: label };
    }
  }

  const productName = sectionValue(sections, FORM_SECTION_LABELS.productName);
  const canonicalUrl = sectionValue(sections, FORM_SECTION_LABELS.canonicalRepositoryUrl);
  const purpose = sectionValue(sections, FORM_SECTION_LABELS.purpose);
  const relationshipLabel = sectionValue(sections, FORM_SECTION_LABELS.requesterRelationship);
  const officialUrl = sectionValue(sections, FORM_SECTION_LABELS.officialUrl);
  const additionalRaw = sectionValue(sections, FORM_SECTION_LABELS.additionalOfficialUrls);
  const acknowledgement = sectionValue(sections, FORM_SECTION_LABELS.acknowledgement);

  if (!productName) return { ok: false, code: 'form_field_invalid', detail: FORM_SECTION_LABELS.productName };
  if (!canonicalUrl) return { ok: false, code: 'form_field_invalid', detail: FORM_SECTION_LABELS.canonicalRepositoryUrl };
  if (!purpose) return { ok: false, code: 'form_field_invalid', detail: FORM_SECTION_LABELS.purpose };
  if (!relationshipLabel) return { ok: false, code: 'form_field_invalid', detail: FORM_SECTION_LABELS.requesterRelationship };

  // The required checkbox must still be checked ("- [x] ...").
  if (!acknowledgement || !/-\s*\[[xX]\]/.test(acknowledgement)) {
    return { ok: false, code: 'acknowledgement_missing' };
  }

  const relationship = RELATIONSHIP_LABELS[normalizeSingleLine(relationshipLabel)];
  if (!relationship) {
    return { ok: false, code: 'form_field_invalid', detail: FORM_SECTION_LABELS.requesterRelationship };
  }

  const additionalUrls = (additionalRaw ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const candidateForm = {
    product_name: normalizeSingleLine(productName),
    canonical_repository_url: normalizeSingleLine(canonicalUrl),
    official_url: officialUrl ? normalizeSingleLine(officialUrl) : null,
    purpose: normalizeSingleLine(purpose),
    requester_relationship: relationship,
    additional_official_urls: additionalUrls
  };

  const result = ReviewRequestFormSchema.safeParse(candidateForm);
  if (!result.success) {
    const paths = Array.from(new Set(result.error.issues.map(i => i.path.join('.') || '$'))).join(', ');
    return { ok: false, code: 'form_field_invalid', detail: paths };
  }

  return { ok: true, request: result.data };
}

export { REQUESTER_RELATIONSHIPS };
