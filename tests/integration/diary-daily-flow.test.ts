import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  DIARY_PROMPT_VERSION,
  DIARY_RESPONSE_SCHEMA_VERSION,
  buildDiaryId
} from '../../src/schemas/diary';
import { buildInitialDiaryRecord, readDiaryRecord, writeDiaryRecord } from '../../src/lib/diary/record-store';
import { readJurorStates } from '../../src/lib/diary/state-store';
import { readDiaryEntry, readDiaryEvent } from '../../src/lib/diary/entry-store';
import { contentHash } from '../../src/lib/generation/record-store';
import { diaryFailurePath } from '../../src/lib/diary/storage';
import {
  createDiaryResponse,
  createScheduledEvent,
  seedDiaryContentRoot
} from '../helpers/diary-fixtures';

/**
 * The daily diary flow, driven through the exact CLI entrypoints `daily-diary.yml` invokes:
 *
 *   generate            -> verbatim response persisted to the record (workflow commits here)
 *   --apply-record      -> structural gate, then persona patches + event + entry
 *   --update-status     -> published, only after the deploy succeeded
 *
 * Gemini is never reachable: an offline-network guard turns any outbound call into an
 * immediate failure, so these assert what the pipeline does with a stored response and what
 * it does when no response can be obtained at all. The two cases that matter most are that a
 * stored response is never bought twice, and that a structurally broken one costs a day
 * rather than corrupting a persona.
 */
describe('Daily diary flow (response-first CLI wiring)', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const offlineNetwork = pathToFileURL(path.join(__dirname, '..', 'helpers', 'offline-network.ts')).href;

  const DATE = '2026-08-02';
  const JUROR = 'david';
  const RUN_KEY = buildDiaryId(DATE, JUROR);

  let contentRoot: string;

  beforeEach(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-diary-'));
    seedDiaryContentRoot(contentRoot, { startDate: '2026-08-01' });
  });

  afterEach(() => {
    fs.rmSync(contentRoot, { recursive: true, force: true });
  });

  function runDiary(args: string[]): {
    status: number | null;
    stdout: string;
    stderr: string;
    outputs: Record<string, string>;
  } {
    const outputFile = path.join(contentRoot, 'github-output.txt');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--import', offlineNetwork, 'scripts/run-diary.ts', ...args, '--github-output', outputFile],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          JURYPRESS_DATA_MODE: 'production',
          JURYPRESS_CONTENT_ROOT: contentRoot,
          JURYPRESS_SITE_URL: 'http://localhost:4321',
          JURYDIARY_GEMINI_API_KEY: 'test-diary-key-value',
          JURYDIARY_GEMINI_MAX_ATTEMPTS: '1',
          GEMINI_API_KEY: 'test-primary-key-value',
          GEMINI_FALLBACK_API_KEY: 'test-fallback-key-value',
          DRY_RUN: 'false'
        },
        encoding: 'utf8'
      }
    );

    const outputs: Record<string, string> = {};
    if (fs.existsSync(outputFile)) {
      for (const line of fs.readFileSync(outputFile, 'utf8').split('\n')) {
        const index = line.indexOf('=');
        if (index > 0) outputs[line.slice(0, index)] = line.slice(index + 1);
      }
      fs.unlinkSync(outputFile);
    }
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', outputs };
  }

  /** Stores a response for the day exactly as the generate step would have. */
  function seedStoredResponse(overrides: Record<string, unknown> = {}): void {
    const response = createDiaryResponse({
      date: DATE,
      jurorId: JUROR,
      theme: 'work',
      privateEventCategory: null,
      ...overrides
    });

    writeDiaryRecord(
      contentRoot,
      buildInitialDiaryRecord({
        recordId: RUN_KEY,
        date: DATE,
        jurorId: JUROR,
        theme: 'work',
        privateEventCategory: null,
        generatedAt: '2026-08-02T09:20:00.000Z',
        requestedModel: 'gemini-3.5-flash',
        modelUsed: 'gemini-3.5-flash',
        promptVersion: DIARY_PROMPT_VERSION,
        responseSchemaVersion: DIARY_RESPONSE_SCHEMA_VERSION,
        promptHash: 'a'.repeat(64),
        rawResponse: JSON.stringify(response),
        usage: { inputTokens: 100, outputTokens: 200, thinkingTokens: 50, totalTokens: 350 },
        route: { attempts: 1, keySource: 'dedicated' }
      })
    );
  }

  it('fails the day, records the failure and stores no record when Gemini cannot be reached', () => {
    const result = runDiary(['--target-date', DATE]);

    expect(result.status).toBe(1);
    expect(readDiaryRecord(contentRoot, RUN_KEY)).toBeNull();

    const failurePath = diaryFailurePath(contentRoot, RUN_KEY);
    expect(fs.existsSync(failurePath)).toBe(true);

    const failure = JSON.parse(fs.readFileSync(failurePath, 'utf8'));
    expect(failure.run_key).toBe(RUN_KEY);
    expect(failure.jurorId).toBe(JUROR);
    expect(failure.date).toBe(DATE);
    expect(failure.status).toBe('failed');

    // A failure note must never carry a credential.
    const serialized = JSON.stringify(failure);
    expect(serialized).not.toContain('test-diary-key-value');
    expect(serialized).not.toContain('test-primary-key-value');
    expect(serialized).not.toContain('test-fallback-key-value');
  });

  it('leaves the persona untouched when the day fails', () => {
    const before = contentHash(readJurorStates(contentRoot, JUROR)!.character.state);
    runDiary(['--target-date', DATE]);
    expect(contentHash(readJurorStates(contentRoot, JUROR)!.character.state)).toBe(before);
  });

  it('never calls Gemini again once a response is stored', () => {
    seedStoredResponse();

    // Offline: reaching Gemini would fail the run. Exit 0 proves it did not try.
    const result = runDiary(['--target-date', DATE]);

    expect(result.status).toBe(0);
    expect(result.outputs.generation_performed).toBe('false');
    expect(result.outputs.resumed).toBe('true');
    expect(result.outputs.publication_status).toBe('generated');
    expect(result.stdout).toContain('Skipping Gemini');
  });

  it('applies a stored response into an entry, an event and persona state', () => {
    seedStoredResponse();

    const result = runDiary(['--apply-record', '--run-key', RUN_KEY]);
    expect(result.status).toBe(0);
    expect(result.outputs.applied).toBe('true');
    expect(result.outputs.structural_status).toBe('passed');

    const entry = readDiaryEntry(contentRoot, DATE, JUROR);
    expect(entry?.id).toBe(RUN_KEY);
    expect(entry?.title.en.length).toBeGreaterThan(0);
    expect(entry?.title.ja.length).toBeGreaterThan(0);
    expect(entry?.body.ja).toMatch(/[぀-ゟ゠-ヿ一-鿿]/);

    // Issue #110: the focus is carried onto the entry, because the archive is where the next
    // duty day reads what this juror's story has already been about.
    expect(entry?.entryFocus?.dominantSubject).toBe(
      'a repair nobody asked for, next to a review that went too smoothly'
    );
    expect(entry?.entryFocus?.anchorObject).toBe('the workbench radio');

    // Issue #111 and #120: the two continuity ledgers are carried onto the entry for the same
    // reason, because the published archive is the only thing the next duty day reads.
    expect(entry?.projectUpdates).toHaveLength(1);
    expect(entry?.scheduledEvents).toEqual([]);

    const event = readDiaryEvent(contentRoot, DATE, JUROR);
    expect(event?.eventId).toBe(RUN_KEY);
    expect(event?.stateHashes.character.before).not.toBe(event?.stateHashes.character.after);

    const states = readJurorStates(contentRoot, JUROR)!;
    expect(states.character.lastEventId).toBe(RUN_KEY);
    expect(states.character.state.recentConcerns).toContain('teams confusing velocity with progress');

    const record = readDiaryRecord(contentRoot, RUN_KEY)!;
    expect(record.structural.status).toBe('passed');
    expect(record.application.status).toBe('applied');
    expect(record.application.eventId).toBe(RUN_KEY);
    // Publication waits for the deploy — state must never run ahead of the site.
    expect(record.publication.status).toBe('pending');
  });

  /*
   * Issue #120 end to end, on the dates it actually happened. David states a plan for "next
   * month" on 08-02; five days later the entry that would carry it out is being written, and the
   * prompt for that day has to be holding the plan with the days its words cover — otherwise the
   * writer has nothing to be consistent with, which is exactly how the attic got cleared early.
   */
  it('carries a plan from one entry into the next duty day\'s prompt, with its window', () => {
    seedStoredResponse({
      scheduledEvents: [
        createScheduledEvent({
          event: 'clearing out the loft with my brother',
          participants: 'my brother',
          when: 'next month'
        })
      ]
    });
    expect(runDiary(['--apply-record', '--run-key', RUN_KEY]).status).toBe(0);

    const entry = readDiaryEntry(contentRoot, DATE, JUROR);
    expect(entry?.scheduledEvents).toEqual([
      {
        event: 'clearing out the loft with my brother',
        participants: 'my brother',
        when: 'next month',
        movement: 'made',
        changeReason: null
      }
    ]);

    // David's next duty day. DRY_RUN prints the prompt instead of calling Gemini.
    const next = runDiary(['--target-date', '2026-08-07', '--dry-run']);
    expect(next.status).toBe(0);
    expect(next.stdout).toContain('WHAT YOU HAVE ALREADY SAID YOU WOULD DO');
    expect(next.stdout).toContain('- clearing out the loft with my brother');
    expect(next.stdout).toContain('  when: "next month" — 2026-09-01 to 2026-09-30');
    expect(next.stdout).toContain('  (said on 2026-08-02)');
  });

  it('is idempotent: re-applying the same run key changes nothing', () => {
    seedStoredResponse();
    runDiary(['--apply-record', '--run-key', RUN_KEY]);

    const stateAfterFirst = contentHash(readJurorStates(contentRoot, JUROR)!.character.state);
    const eventAfterFirst = contentHash(readDiaryEvent(contentRoot, DATE, JUROR));

    const second = runDiary(['--apply-record', '--run-key', RUN_KEY]);
    expect(second.status).toBe(0);
    expect(second.outputs.applied).toBe('false');

    expect(contentHash(readJurorStates(contentRoot, JUROR)!.character.state)).toBe(stateAfterFirst);
    expect(contentHash(readDiaryEvent(contentRoot, DATE, JUROR))).toBe(eventAfterFirst);
  });

  it('excludes a structurally invalid response as a normal completion, leaving the persona untouched', () => {
    // A delta far beyond one day of movement: rejected rather than clamped.
    seedStoredResponse({
      relationshipPatches: [
        {
          targetJurorId: 'sarah',
          trustDelta: 0.9,
          respectDelta: 0,
          tensionDelta: 0,
          currentView: 'fixture',
          unresolvedIncident: null,
          reason: 'fixture overshoot'
        }
      ]
    });

    const before = contentHash(readJurorStates(contentRoot, JUROR)!.relationships.state);
    const result = runDiary(['--apply-record', '--run-key', RUN_KEY]);

    // Green run, gap in the archive.
    expect(result.status).toBe(0);
    expect(result.outputs.structural_status).toBe('failed');
    expect(result.outputs.publication_status).toBe('excluded');
    expect(Number(result.outputs.error_count)).toBeGreaterThan(0);

    expect(readDiaryEntry(contentRoot, DATE, JUROR)).toBeNull();
    expect(readDiaryEvent(contentRoot, DATE, JUROR)).toBeNull();
    expect(contentHash(readJurorStates(contentRoot, JUROR)!.relationships.state)).toBe(before);

    const record = readDiaryRecord(contentRoot, RUN_KEY)!;
    expect(record.structural.status).toBe('failed');
    expect(record.publication.reason).toBe('structural_validation_failed');
    expect(record.generation.rawResponse).not.toBeNull();
  });

  it('refuses to regenerate a day that was already excluded', () => {
    seedStoredResponse({ diary: { ...createDiaryResponse().diary, body: { en: 'too short', ja: 'みじかい' } } });
    runDiary(['--apply-record', '--run-key', RUN_KEY]);

    const result = runDiary(['--target-date', DATE]);
    expect(result.status).toBe(0);
    expect(result.outputs.generation_performed).toBe('false');
    expect(result.outputs.publication_status).toBe('excluded');
    expect(result.outputs.proceed).toBe('false');
  });

  it('marks published only after the patches were applied', () => {
    seedStoredResponse();

    const premature = runDiary(['--update-status', 'published', '--run-key', RUN_KEY]);
    expect(premature.status).toBe(1);

    runDiary(['--apply-record', '--run-key', RUN_KEY]);
    const published = runDiary(['--update-status', 'published', '--run-key', RUN_KEY]);
    expect(published.status).toBe(0);

    const record = readDiaryRecord(contentRoot, RUN_KEY)!;
    expect(record.publication.status).toBe('published');
    expect(record.publication.publishedAt).not.toBeNull();

    // And a published day is a no-op for the generator.
    const rerun = runDiary(['--target-date', DATE]);
    expect(rerun.status).toBe(0);
    expect(rerun.outputs.publication_status).toBe('published');
    expect(rerun.outputs.proceed).toBe('false');
  });

  it('refuses a run key that disagrees with the duty roster', () => {
    const result = runDiary(['--target-date', DATE, '--run-key', buildDiaryId(DATE, 'marcus')]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('does not match the duty roster');
  });

  it('refuses to generate for a juror with no persona state', () => {
    fs.rmSync(path.join(contentRoot, 'diary', 'jurors', JUROR), { recursive: true, force: true });
    const result = runDiary(['--target-date', DATE]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('no persona state');
  });

  it('refuses a date before the configured start', () => {
    const result = runDiary(['--target-date', '2026-07-30']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('precedes the configured start');
  });
});
