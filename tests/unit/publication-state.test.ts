import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  assertRunStatusTransition,
  collectActiveExclusions,
  normalizeRunStatus,
  readRunState,
  writeRunState,
  writePublicationState
} from '../../src/lib/publication/state-store';
import { RunStateSchemaV2, AnyRunStateSchema } from '../../src/schemas/selection';
import { parseRunCliArgs } from '../../src/lib/publication/cli-args';
import { Selector } from '../../src/lib/selection/selector';

let contentRoot: string;

beforeEach(() => {
  contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-state-store-'));
});

afterEach(() => {
  fs.rmSync(contentRoot, { recursive: true, force: true });
});

function v2State(overrides: Record<string, unknown> = {}): any {
  return {
    schema_version: '2.0.0',
    data_class: 'production',
    status: 'reserved',
    run_key: 'season-2-manual-100',
    trigger: 'manual',
    operation: 'publish_new',
    workflow_run_id: '100',
    reserved_at: '2026-07-16T00:00:00.000Z',
    updated_at: '2026-07-16T00:00:00.000Z',
    candidate_reservation: {
      content_id: 'example/reserved-repo',
      canonical_url: 'https://github.com/example/reserved-repo',
      candidate_name: 'Reserved Repo'
    },
    ...overrides
  };
}

describe('Run state schema v2', () => {
  it('parses a reserved state and requires failure details when failed', () => {
    expect(() => RunStateSchemaV2.parse(v2State())).not.toThrow();
    expect(() => RunStateSchemaV2.parse(v2State({ status: 'failed' }))).toThrow(/failure/);
    expect(() => RunStateSchemaV2.parse(v2State({
      status: 'failed',
      failure: {
        stage: 'evaluation',
        retryable: true,
        previous_status: 'generating',
        error_category: 'HTTP_503',
        failed_at: '2026-07-16T01:00:00.000Z'
      }
    }))).not.toThrow();
  });

  it('keeps legacy 1.0.0 run states readable through the union', () => {
    const legacy = {
      schema_version: '1.0.0',
      data_class: 'production',
      status: 'generated',
      run_key: 'season-2-2026-07-14-daily',
      slug: 'some-slug'
    };
    const parsed: any = AnyRunStateSchema.parse(legacy);
    expect(parsed.status).toBe('generated');
    expect(normalizeRunStatus(parsed)).toBe('generated');
    expect(normalizeRunStatus(AnyRunStateSchema.parse({ ...legacy, status: 'selected' }))).toBe('reserved');
  });
});

describe('State monotonicity', () => {
  it('allows only forward transitions', () => {
    const reserved = AnyRunStateSchema.parse(v2State());
    expect(() => assertRunStatusTransition(reserved, 'generating')).not.toThrow();
    expect(() => assertRunStatusTransition(reserved, 'published')).not.toThrow();
    expect(() => assertRunStatusTransition(reserved, 'reserved')).not.toThrow();

    const published = AnyRunStateSchema.parse(v2State({ status: 'published', slug: 's' }));
    for (const backwards of ['reserved', 'generating', 'generated', 'validated', 'committed'] as const) {
      expect(() => assertRunStatusTransition(published, backwards)).toThrow(/regress/);
    }
    expect(() => assertRunStatusTransition(published, 'failed')).toThrow(/published/);
  });

  it('resumes a failed run at or after its recorded previous status', () => {
    const failed = AnyRunStateSchema.parse(v2State({
      status: 'failed',
      failure: {
        stage: 'evaluation',
        retryable: true,
        previous_status: 'generating',
        error_category: 'HTTP_503',
        failed_at: '2026-07-16T01:00:00.000Z'
      }
    }));
    expect(() => assertRunStatusTransition(failed, 'generating')).not.toThrow();
    expect(() => assertRunStatusTransition(failed, 'generated')).not.toThrow();
    expect(() => assertRunStatusTransition(failed, 'reserved')).toThrow(/before its failed status/);
  });

  it('enforces monotonicity on disk writes', () => {
    writeRunState(contentRoot, v2State({ status: 'generated', slug: 's' }));
    expect(() => writeRunState(contentRoot, v2State({ status: 'reserved' }))).toThrow(/regress/);
    // Forward write succeeds and persists.
    writeRunState(contentRoot, v2State({ status: 'validated', slug: 's' }));
    expect((readRunState(contentRoot, 'season-2-manual-100') as any).status).toBe('validated');
  });

  it('fails closed on path-traversal run keys at the storage layer', () => {
    expect(() => readRunState(contentRoot, '../../etc/passwd')).toThrow();
    expect(() => writeRunState(contentRoot, v2State({ run_key: '../evil' }))).toThrow();
  });
});

describe('Reservation-aware duplicate prevention', () => {
  function writePubState(slug: string, status: string, url: string, contentId: string) {
    writePublicationState(contentRoot, {
      schema_version: '1.0.0',
      data_class: 'production',
      content_id: contentId,
      slug,
      source_canonical_url: url,
      selected_at: '2026-07-16T00:00:00.000Z',
      generated_at: '2026-07-16T00:00:00.000Z',
      generation_run_id: 'season-2-2026-07-14-daily',
      publication_status: status
    } as any);
  }

  it('excludes candidates held by active run and publication states, but not failed ones', () => {
    writeRunState(contentRoot, v2State());
    writeRunState(contentRoot, v2State({
      run_key: 'season-2-manual-101',
      workflow_run_id: '101',
      status: 'failed',
      candidate_reservation: {
        content_id: 'example/failed-repo',
        canonical_url: 'https://github.com/example/failed-repo',
        candidate_name: 'Failed Repo'
      },
      failure: {
        stage: 'evaluation',
        retryable: true,
        previous_status: 'reserved',
        error_category: 'HTTP_503',
        failed_at: '2026-07-16T01:00:00.000Z'
      }
    }));
    // Legacy v1 selected state also reserves its candidate.
    fs.mkdirSync(path.join(contentRoot, 'runs'), { recursive: true });
    fs.writeFileSync(path.join(contentRoot, 'runs', 'season-2-2026-07-14-daily.json'), JSON.stringify({
      schema_version: '1.0.0',
      data_class: 'production',
      status: 'selected',
      run_key: 'season-2-2026-07-14-daily',
      candidate: { name: 'Legacy', canonical_url: 'https://github.com/example/legacy-repo/' },
      selection: { source_id: 'example/legacy-repo', canonical_url: 'https://github.com/example/legacy-repo' }
    }));
    writePubState('published-repo', 'published', 'https://github.com/example/published-repo', 'example/published-repo');
    writePubState('failed-pub', 'failed', 'https://github.com/example/failed-pub', 'example/failed-pub');

    const exclusions = collectActiveExclusions(contentRoot);
    expect(exclusions.canonicalUrls.has('https://github.com/example/reserved-repo')).toBe(true);
    expect(exclusions.canonicalUrls.has('https://github.com/example/legacy-repo')).toBe(true);
    expect(exclusions.canonicalUrls.has('https://github.com/example/published-repo')).toBe(true);
    expect(exclusions.contentIds.has('example/reserved-repo')).toBe(true);
    expect(exclusions.contentIds.has('example/legacy-repo')).toBe(true);
    // Failed states never reserve — retries reuse them via the run key instead.
    expect(exclusions.canonicalUrls.has('https://github.com/example/failed-repo')).toBe(false);
    expect(exclusions.canonicalUrls.has('https://github.com/example/failed-pub')).toBe(false);
  });

  it('makes the selector reject excluded candidates', () => {
    const selector: any = new Selector();
    const candidate = {
      name: 'Reserved Repo',
      canonicalUrl: 'https://github.com/example/reserved-repo',
      sourceId: 'example/reserved-repo'
    };
    expect(selector.isEligible(candidate, new Set())).toBe(true);
    expect(selector.isEligible(candidate, new Set(), {
      canonicalUrls: new Set(['https://github.com/example/reserved-repo'])
    })).toBe(false);
    expect(selector.isEligible(candidate, new Set(), {
      contentIds: new Set(['example/reserved-repo'])
    })).toBe(false);
  });
});

describe('CLI argument contract', () => {
  it('defaults to the legacy scheduled daily behaviour with no arguments', () => {
    const args = parseRunCliArgs([], {} as any);
    expect(args.operation).toBe('publish_new');
    expect(args.trigger).toBe('scheduled');
    expect(args.reserveOnly).toBe(false);
    expect(args.generateReserved).toBe(false);
  });

  it('requires --run-key for resume_pending and validates it', () => {
    expect(() => parseRunCliArgs(['--operation', 'resume_pending'], {} as any)).toThrow(/--run-key/);
    expect(() => parseRunCliArgs(['--operation', 'resume_pending', '--run-key', '../evil'], {} as any)).toThrow();
    expect(() => parseRunCliArgs(['--operation', 'resume_pending', '--run-key', 'season-2-manual-1'], {} as any)).not.toThrow();
    expect(() => parseRunCliArgs(['--operation', 'resume_pending', '--run-key', 'season-2-manual-1', '--reserve-only'], {} as any)).toThrow(/reserve-only/);
  });

  it('requires a workflow run id for manual publish_new', () => {
    expect(() => parseRunCliArgs(['--operation', 'publish_new', '--trigger', 'manual'], {} as any)).toThrow(/GITHUB_RUN_ID/);
    const args = parseRunCliArgs(['--operation', 'publish_new', '--trigger', 'manual'], { GITHUB_RUN_ID: '123' } as any);
    expect(args.workflowRunId).toBe('123');
  });

  it('rejects unknown flags and invalid enums', () => {
    expect(() => parseRunCliArgs(['--frobnicate'], {} as any)).toThrow(/Unknown argument/);
    expect(() => parseRunCliArgs(['--operation', 'noop'], {} as any)).toThrow();
    expect(() => parseRunCliArgs(['--trigger', 'cron'], {} as any)).toThrow();
    expect(() => parseRunCliArgs(['--reserve-only', '--generate-reserved'], {} as any)).toThrow(/mutually exclusive/);
  });
});
