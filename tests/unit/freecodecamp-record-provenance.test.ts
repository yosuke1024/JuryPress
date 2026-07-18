import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coverageTextFields,
  normalizeStatement,
  segmentStatements,
  buildTrustedClaimReferences,
  buildProtectedTokens,
  EMPTY_PROTECTED_TOKENS,
  type ProtectedTokens
} from '../../src/lib/evaluation/public-claims';
import type { Evidence } from '../../src/schemas/evidence';

/**
 * The real production record `season-2-manual-29626451493` (freeCodeCamp/freeCodeCamp) that the
 * manual run excluded on a CLAIM_STATEMENT_UNMATCHED. Its evaluation carries 18 annotations
 * whose statements contain a dotted technical token (`package.json` ×15, `freeCodeCamp.org` ×3)
 * that the strict segmenter over-split. With a protected-token context built from THIS record's
 * own evidence bundle, all 18 resolve and the fail-closed contract still holds.
 */
const dir = join(__dirname, '..', 'fixtures', 'freecodecamp-record');
const evaluation = JSON.parse(readFileSync(join(dir, 'evaluation.json'), 'utf8'));
const evidences = JSON.parse(readFileSync(join(dir, 'evidences.json'), 'utf8')) as Evidence[];

function countMismatches(evaluationInput: any, tokens: ProtectedTokens): number {
  const byPath = new Map<string, any[]>();
  for (const a of evaluationInput.public_statement_annotations ?? []) {
    (byPath.get(a.public_output_path) ?? byPath.set(a.public_output_path, []).get(a.public_output_path)!).push(a);
  }
  let mismatches = 0;
  for (const field of coverageTextFields(evaluationInput)) {
    const segments = segmentStatements(field.text, tokens).map(normalizeStatement);
    const consumed = new Set<number>();
    for (const annotation of byPath.get(field.path) ?? []) {
      const target = normalizeStatement(annotation.statement_text);
      const idx = segments.findIndex((s, i) => !consumed.has(i) && s === target);
      if (idx < 0) mismatches++;
      else consumed.add(idx);
    }
  }
  return mismatches;
}

describe('freeCodeCamp record — protected tokens resolve every dotted-token mismatch', () => {
  it('reproduces exactly 18 mismatches under the strict scan (the excluded state)', () => {
    expect(countMismatches(evaluation, EMPTY_PROTECTED_TOKENS)).toBe(18);
  });

  it('resolves all 18 with a token context built from the record\'s own evidence', () => {
    const tokens = buildProtectedTokens(evidences);
    // The tokens actually came from the restricted, attested sources.
    expect(tokens.has('package.json')).toBe(true);      // evidence URL basename
    expect(tokens.has('freecodecamp.org')).toBe(true);  // body-URL hostname (www-stripped)
    expect(countMismatches(evaluation, tokens)).toBe(0);
  });

  it('buildTrustedClaimReferences throws under strict but succeeds with attested tokens', () => {
    const evidenceById = new Map(evidences.map(e => [e.evidence_id, e]));
    // Strict: the very first dotted-token statement fails closed, exactly as in production.
    expect(() => buildTrustedClaimReferences(evaluation, evidenceById, EMPTY_PROTECTED_TOKENS, []))
      .toThrow(/matches no statement of that field/i);

    // Attested: no traceability rule throws. Wording observations are warnings (as in the
    // validator, which passes a sink), never hard errors — so the record clears the gate.
    const tokens = buildProtectedTokens(evidences);
    const warnings: any[] = [];
    const references = buildTrustedClaimReferences(evaluation, evidenceById, tokens, warnings);
    // Every one of the 112 model annotations is now matched to a statement.
    const annotationCount = evaluation.public_statement_annotations.length;
    const fromAnnotations = references.filter(r => r.coverage_source === 'statement_annotation').length;
    expect(fromAnnotations).toBe(annotationCount);
  });

  it('is a pure, synchronous derivation — no Gemini/network call', () => {
    // The whole provenance path is synchronous: it returns a value, never a Promise, so it
    // cannot have awaited a model call. Revalidation of this record calls no generator.
    const tokens = buildProtectedTokens(evidences);
    const evidenceById = new Map(evidences.map(e => [e.evidence_id, e]));
    const result = buildTrustedClaimReferences(evaluation, evidenceById, tokens, []);
    expect(result).not.toBeInstanceOf(Promise);
    expect(Array.isArray(result)).toBe(true);
  });
});
