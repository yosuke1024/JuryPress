import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildRequestSelection } from '../../src/lib/review-requests/request-candidate';

/**
 * The prompt-injection invariant, re-asserted after the pipeline split.
 *
 * A reader-submitted GitHub issue is untrusted text. Its body may contain anything —
 * including instructions addressed to a model. The pipeline's defence is structural: issue
 * text never reaches ANY prompt builder. Only a numeric issue number and a re-validated
 * https URL cross the boundary; everything the model reads is collected by the evidence
 * collector from the project itself.
 *
 * The editorial split doubles the number of Gemini requests, so this suite checks BOTH.
 * Request 2 is the easier case by construction — its inputs are the persisted article and
 * the evidence bundle — but "obviously safe" is exactly the property that rots silently, so
 * it is pinned here rather than assumed.
 */
describe('Prompt input isolation (reader-request injection invariant)', () => {
  const evaluatorSource = readFileSync('src/lib/evaluation/evaluator.ts', 'utf8');
  const mapperSource = readFileSync('src/lib/evaluation/evidence-mapper.ts', 'utf8');
  const requestCandidateSource = readFileSync('src/lib/review-requests/request-candidate.ts', 'utf8');

  /** Fields that carry reader-authored free text out of an issue form. */
  const ISSUE_TEXT_FIELDS = ['issue_body', 'issueBody', 'body', 'requester_note', 'reason', 'notes'];

  it('neither prompt-building module reads an issue-text field', () => {
    // A property access like `.body` or `.reason` anywhere in these modules would mean
    // reader-authored text has a path toward a model. Matched on a word boundary so
    // legitimate longer names (`criterion.reasoning`) are not false positives.
    for (const source of [evaluatorSource, mapperSource]) {
      for (const field of ISSUE_TEXT_FIELDS) {
        expect(source).not.toMatch(new RegExp(`\\.${field}\\b`));
      }
    }
  });

  /**
   * Every `${...}` interpolation in a template literal region. The literal PROSE of a prompt
   * may legitimately mention issues (the GitHub "open issues" metric is a real input); what
   * must never happen is an interpolated VALUE sourced from reader text. So the assertion
   * targets the interpolations, not the words around them.
   */
  function interpolations(region: string): string[] {
    return [...region.matchAll(/\$\{([^}]*)\}/g)].map(match => match[1].trim());
  }

  it('the editorial prompt interpolates only the candidate, its metadata and the evidence', () => {
    const start = evaluatorSource.indexOf('private buildEditorialPrompt');
    const end = evaluatorSource.indexOf('* Calls Gemini once and returns the response verbatim');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const found = interpolations(evaluatorSource.slice(start, end));
    expect(found.length).toBeGreaterThan(0);
    for (const expression of found) {
      expect(expression).toMatch(/canonicalDisplayName|candidate\.canonicalUrl|sanitizedMetadata|metadataSnapshot|budgeted|personaBlocks|this\.rubric|e\.(evidence_id|url|type|title|summary|claims)|index|persona\.(name|role|prompt)/);
      for (const field of ISSUE_TEXT_FIELDS) {
        expect(expression).not.toContain(field);
      }
    }
  });

  it('the mapping prompt interpolates only the article hash, its statements and the evidence', () => {
    const start = mapperSource.indexOf('function buildMappingPrompt');
    const end = mapperSource.indexOf('* Ingests the model');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const found = interpolations(mapperSource.slice(start, end));
    expect(found.length).toBeGreaterThan(0);
    for (const expression of found) {
      expect(expression).toMatch(/input\.articleHash|numberedStatements|evidenceBlocks|s\.(statementId|path|text)|e\.(evidence_id|url|type|title|summary|claims)/);
      for (const field of ISSUE_TEXT_FIELDS) {
        expect(expression).not.toContain(field);
      }
    }
  });

  it('a request-derived candidate carries no reader free text at all', () => {
    const previousMode = process.env.JURYPRESS_DATA_MODE;
    process.env.JURYPRESS_DATA_MODE = 'production';
    try {
      const selection = buildRequestSelection({
        runKey: 'season-2-request-99',
        candidate: {
          name: 'Example Project',
          canonicalUrl: 'https://github.com/example/project',
          sourceUrl: 'https://github.com/example/project',
          source: 'GitHub',
          sourceId: 'example-project',
          sourceRank: 1,
          popularityValue: 10,
          popularityUnit: 'stars',
          collectedAt: '2026-07-19T00:00:00.000Z',
          metadata: {}
        },
        issueNumber: 99,
        issueUrl: 'https://github.com/yosuke1024/JuryPress-content/issues/99',
        requestId: 'request-99',
        requesterRelationship: 'user',
        sourceMetrics: [{
          platform: 'github',
          metric: 'stars',
          value: 10,
          source_url: 'https://github.com/example/project',
          retrieved_at: '2026-07-19T00:00:00.000Z'
        }]
      } as any);

      const serialized = JSON.stringify(selection).toLowerCase();
      // A prompt-injection string placed in an issue body must have no path into this object.
      expect(serialized).not.toContain('ignore previous instructions');
      for (const field of ISSUE_TEXT_FIELDS) {
        expect(serialized).not.toContain(`"${field}"`);
      }
    } finally {
      if (previousMode === undefined) delete process.env.JURYPRESS_DATA_MODE;
      else process.env.JURYPRESS_DATA_MODE = previousMode;
    }
  });

  it('the request-candidate module never exports issue body text', () => {
    expect(requestCandidateSource).not.toMatch(/issue_?body/i);
  });
});
