import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coverageTextFields,
  normalizeStatement,
  segmentStatements,
  buildProtectedTokens
} from '../../src/lib/evaluation/public-claims';
import { repairContent } from '../../src/lib/generation/repair';
import { validateContent } from '../../src/lib/generation/validator';
import type { Evidence } from '../../src/schemas/evidence';

/**
 * Every production path (generation, repair, validation, revalidation, the publication gate)
 * derives its protected-token context from the SAME `buildProtectedTokens` over the SAME
 * evidence bundle, so none of them can disagree about where a statement boundary is.
 */
const dir = join(__dirname, '..', 'fixtures', 'freecodecamp-record');
const evidences = JSON.parse(readFileSync(join(dir, 'evidences.json'), 'utf8')) as Evidence[];
const record = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'));
const evaluation = JSON.parse(readFileSync(join(dir, 'evaluation.json'), 'utf8'));

function segmentationOf(content: any, tokens: ReadonlySet<string>): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const field of coverageTextFields(content)) {
    map[field.path] = segmentStatements(field.text, tokens);
  }
  return map;
}

function mismatches(content: any, tokens: ReadonlySet<string>): number {
  const byPath = new Map<string, any[]>();
  for (const a of content.public_statement_annotations ?? []) {
    (byPath.get(a.public_output_path) ?? byPath.set(a.public_output_path, []).get(a.public_output_path)!).push(a);
  }
  let n = 0;
  for (const field of coverageTextFields(content)) {
    const segs = segmentStatements(field.text, tokens).map(normalizeStatement);
    const consumed = new Set<number>();
    for (const a of byPath.get(field.path) ?? []) {
      const t = normalizeStatement(a.statement_text);
      const i = segs.findIndex((s, idx) => !consumed.has(idx) && s === t);
      if (i < 0) n++; else consumed.add(i);
    }
  }
  return n;
}

describe('segmentation is identical across every production path', () => {
  it('buildProtectedTokens is a deterministic function of the evidence bundle', () => {
    const a = buildProtectedTokens(evidences);
    const b = buildProtectedTokens(evidences);
    expect([...a].sort()).toEqual([...b].sort());
  });

  it('repaired content is fully covered under the same token context the gate re-derives', () => {
    // Repair may legitimately reword some public text; what must hold is that the content the
    // validator then judges segments — under the identical tokens — with every annotation matched.
    const tokens = buildProtectedTokens(evidences);
    const { content: repaired } = repairContent(evaluation, evidences, tokens);
    expect(mismatches(repaired, tokens)).toBe(0);
    // And the dotted-token fields specifically did not over-split post-repair.
    const segs = segmentationOf(repaired, tokens);
    expect(segs['article.where_jury_agreed.2']).toHaveLength(1);
  });

  it('repair with an explicit context equals repair that self-derives from evidence', () => {
    const tokens = buildProtectedTokens(evidences);
    const explicit = repairContent(evaluation, evidences, tokens).content;
    const derived = repairContent(evaluation, evidences).content;
    expect(segmentationOf(explicit, tokens)).toEqual(segmentationOf(derived, tokens));
  });

  it('validateContent is idempotent — generation and revalidation agree byte-for-byte', () => {
    const run = () => validateContent({
      content: record.editorial.currentContent,
      originalContent: record.generation.originalContent ?? null,
      evidences,
      humanEdited: false
    });
    const first = run();
    const second = run();
    expect(first.status).toBe('passed');
    expect(second.contentHash).toBe(first.contentHash);
    expect(second.status).toBe(first.status);
  });
});

/**
 * `Node.js` was the second root cause of the season-2-request-36 failure. It is never a URL
 * basename, so the attested-token mask could not reach it, and it is not a repository
 * filename, so the closed filename list did not cover it either — leaving it to split into
 * "…for Node." + a bare "js.", a statement no annotation can ever match.
 */
describe('dotted technology names are not sentence boundaries', () => {
  const strict = (text: string) => segmentStatements(text, new Set<string>());

  it('keeps Node.js in one statement without any evidence attestation', () => {
    expect(strict('The README documents setup requirements for Node.js.'))
      .toEqual(['The README documents setup requirements for Node.js.']);
  });

  it('never emits a bare extension fragment as its own statement', () => {
    for (const name of ['Node.js', 'Vue.js', 'Next.js', 'three.js', 'socket.io', 'ASP.NET']) {
      const segments = strict(`The project targets ${name}. It ships tests.`);
      expect(segments).toHaveLength(2);
      expect(segments.some(s => /^(js|io|net)\.$/i.test(s))).toBe(false);
    }
  });

  it('still splits an unknown dotted token, so the list cannot hide a boundary', () => {
    // `safe.js` is not on the closed list: the fail-closed default is unchanged.
    expect(strict('The tool is safe.js the claim is false.').length).toBeGreaterThan(1);
    expect(strict('The claim is false.json the tool is safe.').length).toBeGreaterThan(1);
  });

  it('does not protect a known name glued into a larger identifier', () => {
    expect(strict('It uses evilnode.js the claim is false.').length).toBeGreaterThan(1);
  });
});
