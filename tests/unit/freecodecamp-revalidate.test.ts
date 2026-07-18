import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateContent, applyVerdict, VALIDATOR_VERSION } from '../../src/lib/generation/validator';
import type { Evidence } from '../../src/schemas/evidence';
import type { GenerationRecord } from '../../src/schemas/generation-record';

/**
 * Editorial Recovery, at the library layer the `review revalidate` CLI drives: the persisted
 * excluded record, re-validated by the bumped validator over its own stored content, becomes
 * `ready` — with the raw response and original content untouched and a fresh, appended history
 * entry. No generator is involved.
 */
const dir = join(__dirname, '..', 'fixtures', 'freecodecamp-record');
const evidences = JSON.parse(readFileSync(join(dir, 'evidences.json'), 'utf8')) as Evidence[];
function loadRecord(): GenerationRecord {
  return JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8')) as GenerationRecord;
}

describe('freeCodeCamp record — revalidate transitions excluded → ready', () => {
  it('the excluded record now clears the quality validator', () => {
    const record = loadRecord();
    expect(record.publication.status).toBe('excluded');

    const verdict = validateContent({
      content: record.editorial.currentContent,
      originalContent: record.generation.originalContent ?? record.generation.recoveredBaseline ?? null,
      evidences,
      humanEdited: record.editorial.mode === 'human_edited'
    });

    expect(verdict.errors.map(e => e.code)).not.toContain('CLAIM_STATEMENT_UNMATCHED');
    expect(verdict.status).toBe('passed');
  });

  it('applyVerdict flips publication to ready, appends history, and never mutates the raw response', () => {
    const record = loadRecord();
    const before = loadRecord(); // pristine copy for immutability comparison

    const verdict = validateContent({
      content: record.editorial.currentContent,
      originalContent: record.generation.originalContent ?? null,
      evidences,
      humanEdited: false
    });
    const updated = applyVerdict(record, verdict, '2026-07-18T10:00:00.000Z');

    // Transition: excluded → ready.
    expect(updated.publication.status).toBe('ready');

    // Append-only history: the prior excluded attempt is preserved, a new entry is appended.
    expect(updated.quality.history!.length).toBe(before.quality.history!.length + 1);
    expect(updated.quality.history![0]).toEqual(before.quality.history![0]);
    const appended = updated.quality.history![updated.quality.history!.length - 1];
    expect(appended.validatorVersion).toBe(VALIDATOR_VERSION);
    expect(appended.status).toBe('passed');

    // The generator's outputs are immutable: raw response and original content are byte-identical.
    expect(updated.generation.rawResponse).toEqual(before.generation.rawResponse);
    expect(updated.generation.originalContent).toEqual(before.generation.originalContent);
  });
});
