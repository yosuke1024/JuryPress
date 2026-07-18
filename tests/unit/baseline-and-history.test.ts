import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRecommendationFixture } from '../fixtures/refined-review';
import { recoverImmutableBaseline, hasJudgmentStructure } from '../../src/lib/generation/baseline';
import { prepareEdit, BaselineUnavailableError } from '../../src/lib/generation/review-edit';
import {
  buildInitialRecord,
  readRecord,
  writeRecord,
  contentHash,
  recordsDir
} from '../../src/lib/generation/record-store';
import { applyVerdict, validateContent, VALIDATOR_VERSION } from '../../src/lib/generation/validator';
import type { GenerationRecord } from '../../src/schemas/generation-record';

describe('recoverImmutableBaseline', () => {
  const { generatedOutput } = createRecommendationFixture();

  it('recovers a fenced JSON judgment that strict parse would reject', () => {
    const raw = '```json\n' + JSON.stringify(generatedOutput) + '\n```';
    expect(() => JSON.parse(raw)).toThrow();
    const recovered = recoverImmutableBaseline(raw);
    expect(recovered).not.toBeNull();
    expect(recovered!.method).toBe('code-fence');
    expect(hasJudgmentStructure(recovered!.baseline)).toBe(true);
  });

  it('returns null when the response carries no jury judgment (a human must not invent it)', () => {
    expect(recoverImmutableBaseline('this is not json at all')).toBeNull();
    expect(recoverImmutableBaseline('{"article": {"summary": "x"}}')).toBeNull();
    expect(recoverImmutableBaseline(null)).toBeNull();
    expect(recoverImmutableBaseline('')).toBeNull();
  });

  it('rejects a judgment missing scores a human could fill in', () => {
    const noScores = structuredClone(generatedOutput) as any;
    delete noScores.judges[0].criteria[0].score;
    expect(hasJudgmentStructure(noScores)).toBe(false);
  });
});

describe('prepare-edit baseline handling', () => {
  let contentRoot: string;
  const recordId = 'season-2-manual-888001';
  const fixture = createRecommendationFixture();

  beforeEach(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-baseline-'));
    fs.mkdirSync(recordsDir(contentRoot), { recursive: true });
  });
  afterEach(() => fs.rmSync(contentRoot, { recursive: true, force: true }));

  function excludedUnparseable(rawResponse: string): GenerationRecord {
    // originalContent null (never parsed), publication excluded — the RESPONSE_PARSE_FAILED case.
    const record = buildInitialRecord({
      recordId, candidateId: 'c', runKey: recordId, canonicalUrl: null, candidateName: 'C', slug: 'unparseable-x',
      receivedAt: '2026-07-17T00:00:00.000Z', model: 'm', modelVersion: 'm', promptVersion: '2.1.0', promptHash: 'a'.repeat(64),
      rawResponse, originalContent: null,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null, thinkingTokens: null, cachedInputTokens: null },
      route: null
    });
    return writeRecord(contentRoot, {
      ...record,
      quality: { ...record.quality, status: 'failed', errors: [{ code: 'RESPONSE_PARSE_FAILED', path: '$', message: 'not json', severity: 'error', ruleVersion: '2.0.0' }] },
      publication: { status: 'excluded', reason: 'quality_validation_failed', publishedAt: null }
    });
  }

  it('refuses to create a publishable revision when no judgment can be recovered', () => {
    const record = excludedUnparseable('totally not json {{{');
    expect(() => prepareEdit(record, { reason: 'x', editedAt: '2026-07-17T01:00:00.000Z' }))
      .toThrow(BaselineUnavailableError);
    // The raw response and errors remain; nothing was created.
    const onDisk = readRecord(contentRoot, recordId)!;
    expect(onDisk.editorial.mode).toBe('autonomous');
    expect(onDisk.editorial.currentRevision).toBe(0);
    expect(onDisk.generation.rawResponse).toBe('totally not json {{{');
  });

  it('recovers a fenced judgment as the immutable baseline and allows editing', () => {
    const record = excludedUnparseable('```json\n' + JSON.stringify(fixture.generatedOutput) + '\n```');
    const result = prepareEdit(record, { reason: 'fix prose', editedAt: '2026-07-17T01:00:00.000Z' });
    writeRecord(contentRoot, result.record);
    const edited = readRecord(contentRoot, recordId)!;
    expect(result.recoveredBaseline).toBe(true);
    expect(edited.generation.recoveredBaseline).not.toBeNull();
    expect(edited.generation.baselineRecovery?.method).toBe('code-fence');
    // Editing against the recovered baseline still pins the scores.
    const tampered = structuredClone(edited);
    (tampered.editorial.currentContent as any).recalculated_jury_score = 1.0;
    writeRecord(contentRoot, tampered);
    const verdict = validateContent({
      content: tampered.editorial.currentContent,
      originalContent: tampered.generation.originalContent ?? tampered.generation.recoveredBaseline ?? null,
      evidences: fixture.context.evidences,
      humanEdited: true
    });
    expect(verdict.errors.some(e => e.code === 'IMMUTABLE_JUDGMENT_FIELD_CHANGED')).toBe(true);
  });

  it('a human cannot author scores from an empty template through the publish path', () => {
    const record = excludedUnparseable('not recoverable at all');
    // The only way to an editable revision is prepare-edit, which refuses here with the
    // stable IMMUTABLE_JUDGMENT_BASELINE_UNAVAILABLE code.
    try {
      prepareEdit(record, { reason: 'x', editedAt: '2026-07-17T01:00:00.000Z' });
      throw new Error('prepareEdit should have refused');
    } catch (e: any) {
      expect(e).toBeInstanceOf(BaselineUnavailableError);
      expect(e.code).toBe('IMMUTABLE_JUDGMENT_BASELINE_UNAVAILABLE');
    }
  });
});

describe('append-only validation history', () => {
  let contentRoot: string;
  const recordId = 'season-2-manual-999001';
  const fixture = createRecommendationFixture();

  beforeEach(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-history-'));
    fs.mkdirSync(recordsDir(contentRoot), { recursive: true });
  });
  afterEach(() => fs.rmSync(contentRoot, { recursive: true, force: true }));

  function seed(): GenerationRecord {
    const record = buildInitialRecord({
      recordId, candidateId: 'refined-product-id', runKey: recordId, canonicalUrl: null, candidateName: 'C', slug: 'recommended-product',
      receivedAt: '2026-07-17T00:00:00.000Z', model: 'm', modelVersion: 'm', promptVersion: '2.1.0', promptHash: 'a'.repeat(64),
      rawResponse: JSON.stringify(fixture.generatedOutput), originalContent: fixture.generatedOutput,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null, thinkingTokens: null, cachedInputTokens: null },
      route: null
    });
    return writeRecord(contentRoot, record);
  }

  it('appends a new entry per distinct validation and keeps prior failures', () => {
    let record = seed();
    // First: a failed verdict.
    const failVerdict = validateContent({ content: { garbage: true }, originalContent: fixture.generatedOutput, evidences: fixture.context.evidences, humanEdited: false });
    record = writeRecord(contentRoot, applyVerdict(record, failVerdict, '2026-07-17T00:10:00.000Z'));
    // Second: a passing verdict on the real content.
    const passVerdict = validateContent({ content: fixture.generatedOutput, originalContent: fixture.generatedOutput, evidences: fixture.context.evidences, humanEdited: false });
    record = writeRecord(contentRoot, applyVerdict(record, passVerdict, '2026-07-17T00:20:00.000Z'));

    expect(record.quality.status).toBe('passed');
    expect(record.quality.history.length).toBe(2);
    // The earlier failure survives the later pass.
    expect(record.quality.history[0].status).toBe('failed');
    expect(record.quality.history[1].status).toBe('passed');
  });

  it('is idempotent for an identical re-run: the existing entry is left byte-for-byte intact', () => {
    let record = seed();
    const verdict = validateContent({ content: fixture.generatedOutput, originalContent: fixture.generatedOutput, evidences: fixture.context.evidences, humanEdited: false });
    record = writeRecord(contentRoot, applyVerdict(record, verdict, '2026-07-17T00:10:00.000Z'));
    const entryBefore = structuredClone(record.quality.history[0]);
    // Re-run the SAME validation (same validationId) with a LATER checkedAt: strictly a no-op
    // on the history — the entry is never refreshed, so its original checkedAt survives.
    record = writeRecord(contentRoot, applyVerdict(record, verdict, '2026-07-17T00:11:00.000Z'));
    expect(record.quality.history.length).toBe(1);
    expect(record.quality.history[0]).toEqual(entryBefore);
    expect(record.quality.history[0].checkedAt).toBe('2026-07-17T00:10:00.000Z');
  });

  it('rejects any in-place modification of an existing history entry at the storage layer', () => {
    let record = seed();
    // A FAILED verdict, so every mutation below is a genuine change to a frozen field.
    const verdict = validateContent({ content: { garbage: true }, originalContent: fixture.generatedOutput, evidences: fixture.context.evidences, humanEdited: false });
    record = writeRecord(contentRoot, applyVerdict(record, verdict, '2026-07-17T00:10:00.000Z'));

    // Each of these mutates a frozen field of the existing entry — the storage guard must reject
    // it regardless of which field changed (checkedAt, status, errors, or warnings).
    const mutations: Array<(r: GenerationRecord) => void> = [
      r => { (r.quality.history[0] as any).checkedAt = '2026-07-17T09:00:00.000Z'; },
      r => { (r.quality.history[0] as any).status = 'passed'; },
      r => { (r.quality.history[0] as any).errors = []; },
      r => { (r.quality.history[0] as any).warnings = [{ code: 'INJECTED', path: '$', message: 'x', severity: 'warning', ruleVersion: '2.0.0' }]; }
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(record);
      mutate(tampered);
      expect(() => writeRecord(contentRoot, tampered)).toThrow(/append-only/i);
    }
  });

  it('rejects reordering or replacing an existing history prefix at the storage layer', () => {
    let record = seed();
    const fail = validateContent({ content: { garbage: true }, originalContent: fixture.generatedOutput, evidences: fixture.context.evidences, humanEdited: false });
    record = writeRecord(contentRoot, applyVerdict(record, fail, '2026-07-17T00:10:00.000Z'));
    const pass = validateContent({ content: fixture.generatedOutput, originalContent: fixture.generatedOutput, evidences: fixture.context.evidences, humanEdited: false });
    record = writeRecord(contentRoot, applyVerdict(record, pass, '2026-07-17T00:20:00.000Z'));
    expect(record.quality.history.length).toBe(2);

    // Reorder the two existing entries.
    const reordered = structuredClone(record);
    reordered.quality.history = [record.quality.history[1], record.quality.history[0]];
    expect(() => writeRecord(contentRoot, reordered)).toThrow(/append-only/i);

    // Replace entry 0 with a fabricated one (same length, different content).
    const replaced = structuredClone(record);
    (replaced.quality.history[0] as any).contentHash = 'f'.repeat(64);
    (replaced.quality.history[0] as any).validationId = '2.0.0:0:' + 'f'.repeat(64);
    expect(() => writeRecord(contentRoot, replaced)).toThrow(/append-only/i);
  });

  it('records separate entries for different validator versions of the same revision', () => {
    // A record that already carries an older-validator attempt (as it would after a prior run).
    const base = seed();
    const verdict = validateContent({ content: fixture.generatedOutput, originalContent: fixture.generatedOutput, evidences: fixture.context.evidences, humanEdited: false });
    const withV1 = structuredClone(base);
    withV1.quality.history.push({
      validationId: '1.0.0:0:' + verdict.contentHash, revision: 0, contentHash: verdict.contentHash,
      checkedAt: '2026-07-16T00:00:00.000Z', validatorVersion: '1.0.0', status: 'failed',
      errors: [{ code: 'OLD_RULE', path: '$', message: 'old', severity: 'error', ruleVersion: '1.0.0' }], warnings: []
    });
    let record = writeRecord(contentRoot, withV1);
    // Revalidate under the current validator: a different validationId appends a new entry.
    record = writeRecord(contentRoot, applyVerdict(record, verdict, '2026-07-17T00:10:00.000Z'));
    expect(record.quality.history.map(h => h.validatorVersion)).toContain('1.0.0');
    expect(record.quality.history.map(h => h.validatorVersion)).toContain(VALIDATOR_VERSION);
    expect(record.quality.history.length).toBe(2);
  });

  it('cannot delete or reorder existing history at the storage layer', () => {
    let record = seed();
    const verdict = validateContent({ content: fixture.generatedOutput, originalContent: fixture.generatedOutput, evidences: fixture.context.evidences, humanEdited: false });
    record = writeRecord(contentRoot, applyVerdict(record, verdict, '2026-07-17T00:10:00.000Z'));
    const pruned = structuredClone(record);
    pruned.quality.history = [];
    expect(() => writeRecord(contentRoot, pruned)).toThrow(/append-only/i);
  });
});
