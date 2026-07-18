import * as fs from 'node:fs';
import { z } from 'zod';
import {
  CandidateSchema,
  SelectionSchema,
  SourceMetricSchema,
  type Candidate,
  type Selection,
  type SourceMetric
} from '../../schemas/selection';
import {
  REQUESTER_RELATIONSHIPS,
  validateCanonicalRepositoryUrl,
  validatePublicHttpsUrl
} from '../../schemas/review-request';
import { resolveDataMode } from '../content-root';

/**
 * The validated request-candidate file: the ONLY bridge between the issue-facing CLI and
 * the publication pipeline. It deliberately carries no requester free text (no purpose, no
 * issue body): the candidate identity comes from official APIs, the request identity from
 * the machine-readable block. Everything Gemini will see is re-collected by the Evidence
 * Collector from official sources.
 */
export const RequestCandidateFileSchema = z.object({
  schema_version: z.literal('1.0.0'),
  generated_at: z.string(),
  issue: z.object({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    number: z.number().int().positive(),
    url: z.string().url()
  }).strict(),
  request: z.object({
    request_id: z.string().uuid(),
    requester_relationship: z.enum(REQUESTER_RELATIONSHIPS)
  }).strict(),
  candidate: CandidateSchema,
  source_metrics: z.array(SourceMetricSchema).min(1)
}).strict();

export type RequestCandidateFile = z.infer<typeof RequestCandidateFileSchema>;

/**
 * Loads and re-validates a request-candidate file. Fails closed on every mismatch: the
 * file must describe the exact issue the operator dispatched, the candidate must point at
 * a supported public source, and the source URL must equal the canonical URL so the
 * Evidence Collector can never be steered at the GitHub Issue (or anywhere else).
 */
export function loadRequestCandidateFile(filePath: string, expectedIssueNumber: number): RequestCandidateFile {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[Request] Candidate file does not exist: ${filePath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e: any) {
    throw new Error(`[Request] Candidate file is not valid JSON: ${e.message}`);
  }
  const file = RequestCandidateFileSchema.parse(raw);

  if (file.issue.number !== expectedIssueNumber) {
    throw new Error(`[Request] Candidate file is for issue #${file.issue.number}, but issue #${expectedIssueNumber} was dispatched.`);
  }

  const canonical = validateCanonicalRepositoryUrl(file.candidate.canonicalUrl);
  if (!canonical) {
    throw new Error(`[Request] Candidate canonical URL is not a supported public source: ${file.candidate.canonicalUrl}`);
  }
  if (file.candidate.sourceUrl !== file.candidate.canonicalUrl) {
    throw new Error('[Request] Candidate sourceUrl must equal canonicalUrl (evidence collection must target the official source only).');
  }
  if (file.candidate.source !== 'reader_request') {
    throw new Error(`[Request] Candidate source must be "reader_request", got "${file.candidate.source}".`);
  }
  for (const url of file.candidate.additional_evidence_urls ?? []) {
    if (validatePublicHttpsUrl(url, { allowQuery: true }) === null) {
      throw new Error(`[Request] Additional evidence URL is not an acceptable public https URL: ${url}`);
    }
  }

  return file;
}

/**
 * Builds the reader-request selection record. Never influences scoring: this is
 * provenance and transparency metadata only, validated against the same SelectionSchema
 * every other selection mode uses.
 */
export function buildRequestSelection(input: {
  runKey: string;
  candidate: Candidate;
  issueNumber: number;
  issueUrl: string;
  requestId: string;
  requesterRelationship: (typeof REQUESTER_RELATIONSHIPS)[number];
  sourceMetrics: SourceMetric[];
}): Selection {
  return SelectionSchema.parse({
    schema_version: '1.0.0',
    data_class: resolveDataMode(),
    run_key: input.runKey,
    source: 'reader_request',
    source_rank: null,
    selection_rule: 'Operator-approved reader review request via GitHub Issue',
    selected_at: new Date().toISOString(),
    canonical_url: input.candidate.canonicalUrl,
    source_url: input.issueUrl,
    algorithm_version: '2.0.0',
    human_selected: true,
    candidate_name: input.candidate.name,
    source_id: input.candidate.sourceId,
    candidate_metadata: { ...input.candidate.metadata },
    selection_mode: 'reader-request',
    selected_by: 'operator',
    source_metrics: input.sourceMetrics,
    request_provenance: {
      request_id: input.requestId,
      issue_number: input.issueNumber,
      issue_url: input.issueUrl,
      requester_relationship: input.requesterRelationship
    }
  });
}
