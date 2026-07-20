import { createEditorialFixture } from '../fixtures/refined-review';
import { EVIDENCE_MAP_SCHEMA_VERSION, MAPPING_PROMPT_VERSION, type EvidenceMap } from '../../src/schemas/evidence-map';

/**
 * A review that actually ranks under the current standard.
 *
 * Ranking now requires a complete, loadable evidence map, so a fixture that only sets
 * `evidence_map_status: 'complete'` is not enough — the map file has to exist and parse, or
 * getEffectiveEvidenceMapStatus fails closed and the review drops out of every ranking.
 * Tests about period boundaries, ordering or layout need a ranked population, not a
 * statement about mapping, so they should build on this rather than on the 2.x fixtures.
 */
export function createRankableFixture() {
  const base = createEditorialFixture();
  const review = JSON.parse(JSON.stringify(base.review));
  review.evidence_map_status = 'complete';
  return { ...base, review };
}

/**
 * A minimal map that satisfies EvidenceMapSchema. `article_hash` is only compared when the
 * review carries provenance.validated_content_hash, which the fixtures deliberately do not.
 */
export function createEvidenceMapFile(): EvidenceMap {
  return {
    map_schema_version: EVIDENCE_MAP_SCHEMA_VERSION,
    article_hash: 'a'.repeat(64),
    mapping_prompt_version: MAPPING_PROMPT_VERSION,
    mapped_at: '2026-07-19T02:00:00.000Z',
    model: 'fixture-model',
    status: 'complete',
    scope: { version: '1.0.0', selected_statement_count: 1, excluded_statement_count: 0 },
    claims: [
      {
        claim_id: 'claim-1',
        public_output_path: 'article.standfirst',
        statement_index: 0,
        statement_text: 'A small, opinionated tool with an unusually clear point of view.',
        classification: 'directly_supported',
        evidence_ids: [],
        support: 'strong',
        note: null
      }
    ],
    unmapped_statements: [],
    contradictions: [],
    evidence_usage: []
  } as EvidenceMap;
}
