import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SelectionSchema } from '../../src/schemas/selection';
import { buildRequestRunKey, isValidRunKey, assertSafeRunKey } from '../../src/lib/publication/run-keys';
import {
  RequestCandidateFileSchema,
  buildRequestSelection,
  loadRequestCandidateFile
} from '../../src/lib/review-requests/request-candidate';

const baseSelection = {
  schema_version: '1.0.0',
  data_class: 'fixture',
  run_key: 'season-2-request-123',
  source: 'reader_request',
  source_rank: null,
  selection_rule: 'Operator-approved reader review request via GitHub Issue',
  selected_at: '2026-07-18T00:00:00.000Z',
  canonical_url: 'https://github.com/owner/great-tool',
  source_url: 'https://github.com/yosuke1024/JuryPress/issues/123',
  algorithm_version: '2.0.0',
  human_selected: true,
  candidate_name: 'great-tool',
  source_id: 'owner/great-tool',
  candidate_metadata: {},
  selection_mode: 'reader-request',
  selected_by: 'operator',
  source_metrics: [{
    platform: 'github',
    metric: 'stars',
    value: 321,
    source_url: 'https://github.com/owner/great-tool',
    retrieved_at: '2026-07-18T00:00:00.000Z'
  }],
  request_provenance: {
    request_id: '7f9c1c3a-2f6e-4a44-9d3c-2b1f5a8e9d10',
    issue_number: 123,
    issue_url: 'https://github.com/yosuke1024/JuryPress/issues/123',
    requester_relationship: 'user'
  }
};

describe('SelectionSchema reader-request mode', () => {
  it('accepts a fully-specified reader-request selection', () => {
    expect(SelectionSchema.safeParse(baseSelection).success).toBe(true);
  });

  it('requires selected_by operator', () => {
    expect(SelectionSchema.safeParse({ ...baseSelection, selected_by: 'system' }).success).toBe(false);
  });

  it('requires human_selected true', () => {
    expect(SelectionSchema.safeParse({ ...baseSelection, human_selected: false }).success).toBe(false);
  });

  it('requires source_rank null', () => {
    expect(SelectionSchema.safeParse({ ...baseSelection, source_rank: 1 }).success).toBe(false);
  });

  it('requires source reader_request', () => {
    expect(SelectionSchema.safeParse({ ...baseSelection, source: 'github' }).success).toBe(false);
  });

  it('requires request_provenance', () => {
    const { request_provenance, ...withoutProvenance } = baseSelection;
    expect(SelectionSchema.safeParse(withoutProvenance).success).toBe(false);
  });

  it('rejects request_provenance on other selection modes', () => {
    const daily = {
      ...baseSelection,
      selection_mode: 'automated-daily',
      selected_by: 'system',
      human_selected: false,
      source: 'github',
      source_rank: 1
    };
    expect(SelectionSchema.safeParse(daily).success).toBe(false);
    const { request_provenance, ...dailyClean } = daily;
    expect(SelectionSchema.safeParse(dailyClean).success).toBe(true);
  });

  it('keeps production source_metrics requirements for reader requests', () => {
    const production = { ...baseSelection, data_class: 'production', source_metrics: [] };
    expect(SelectionSchema.safeParse(production).success).toBe(false);
  });
});

describe('request run keys', () => {
  it('builds and validates season-<n>-request-<issue>', () => {
    expect(buildRequestRunKey(2, 123)).toBe('season-2-request-123');
    expect(isValidRunKey('season-2-request-123')).toBe(true);
    expect(() => assertSafeRunKey('season-2-request-123')).not.toThrow();
  });

  it('rejects invalid issue numbers and malformed request keys', () => {
    expect(() => buildRequestRunKey(2, 0)).toThrow();
    expect(() => buildRequestRunKey(2, 1.5)).toThrow();
    expect(isValidRunKey('season-2-request-0')).toBe(false);
    expect(isValidRunKey('season-2-request-')).toBe(false);
    expect(isValidRunKey('season-2-request-12x')).toBe(false);
    expect(isValidRunKey('season-2-request-12-extra')).toBe(false);
  });

  it('keeps existing daily and manual formats valid', () => {
    expect(isValidRunKey('season-2-2026-07-18-daily')).toBe(true);
    expect(isValidRunKey('season-2-2026-07-18-daily-some-slug')).toBe(true);
    expect(isValidRunKey('season-2-manual-29633364803')).toBe(true);
  });
});

describe('request candidate file', () => {
  const validFile = {
    schema_version: '1.0.0',
    generated_at: '2026-07-18T00:00:00.000Z',
    issue: {
      repo: 'yosuke1024/JuryPress',
      number: 123,
      url: 'https://github.com/yosuke1024/JuryPress/issues/123'
    },
    request: {
      request_id: '7f9c1c3a-2f6e-4a44-9d3c-2b1f5a8e9d10',
      requester_relationship: 'user'
    },
    candidate: {
      source: 'reader_request',
      sourceId: 'owner/great-tool',
      name: 'great-tool',
      canonicalUrl: 'https://github.com/owner/great-tool',
      sourceUrl: 'https://github.com/owner/great-tool',
      sourceRank: 0,
      popularityValue: 321,
      popularityUnit: 'stars',
      collectedAt: '2026-07-18T00:00:00.000Z',
      metadata: { official_full_name: 'owner/great-tool' }
    },
    source_metrics: [{
      platform: 'github',
      metric: 'stars',
      value: 321,
      source_url: 'https://github.com/owner/great-tool',
      retrieved_at: '2026-07-18T00:00:00.000Z'
    }]
  };

  function writeTempFile(content: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-request-'));
    const filePath = path.join(dir, 'candidate.json');
    fs.writeFileSync(filePath, JSON.stringify(content, null, 2));
    return filePath;
  }

  it('loads a valid candidate file', () => {
    const filePath = writeTempFile(validFile);
    const loaded = loadRequestCandidateFile(filePath, 123);
    expect(loaded.candidate.canonicalUrl).toBe('https://github.com/owner/great-tool');
  });

  it('rejects an issue-number mismatch', () => {
    const filePath = writeTempFile(validFile);
    expect(() => loadRequestCandidateFile(filePath, 999)).toThrow(/issue #123/);
  });

  it('rejects a sourceUrl that differs from the canonical URL', () => {
    const filePath = writeTempFile({
      ...validFile,
      candidate: { ...validFile.candidate, sourceUrl: 'https://github.com/yosuke1024/JuryPress/issues/123' }
    });
    expect(() => loadRequestCandidateFile(filePath, 123)).toThrow(/sourceUrl/);
  });

  it('rejects a non-reader_request source', () => {
    const filePath = writeTempFile({
      ...validFile,
      candidate: { ...validFile.candidate, source: 'github' }
    });
    expect(() => loadRequestCandidateFile(filePath, 123)).toThrow(/reader_request/);
  });

  it('rejects unsupported additional evidence URLs', () => {
    const filePath = writeTempFile({
      ...validFile,
      candidate: { ...validFile.candidate, additional_evidence_urls: ['http://insecure.dev/docs'] }
    });
    expect(() => loadRequestCandidateFile(filePath, 123)).toThrow(/Additional evidence URL/);
  });

  it('rejects unknown keys (strict schema)', () => {
    expect(RequestCandidateFileSchema.safeParse({ ...validFile, extra: true }).success).toBe(false);
  });

  it('builds a schema-valid reader-request selection with provenance', () => {
    const originalMode = process.env.JURYPRESS_DATA_MODE;
    process.env.JURYPRESS_DATA_MODE = originalMode || 'fixture';
    const selection = buildRequestSelection({
      runKey: 'season-2-request-123',
      candidate: validFile.candidate as any,
      issueNumber: 123,
      issueUrl: 'https://github.com/yosuke1024/JuryPress/issues/123',
      requestId: '7f9c1c3a-2f6e-4a44-9d3c-2b1f5a8e9d10',
      requesterRelationship: 'user',
      sourceMetrics: validFile.source_metrics as any
    });
    expect(selection.selection_mode).toBe('reader-request');
    expect(selection.selected_by).toBe('operator');
    expect(selection.human_selected).toBe(true);
    expect(selection.source_rank).toBeNull();
    expect(selection.request_provenance?.issue_number).toBe(123);
    expect(SelectionSchema.safeParse(selection).success).toBe(true);
    if (originalMode === undefined) {
      delete process.env.JURYPRESS_DATA_MODE;
    }
  });
});
