import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { JUDGE_SLUGS } from '../../src/schemas/jury';
import {
  DIARY_BOOTSTRAP_PROMPT_VERSION,
  DIARY_BOOTSTRAP_SCHEMA_VERSION
} from '../../src/schemas/diary-bootstrap';
import { buildInitialDiaryRecord, writeDiaryRecord } from '../../src/lib/diary/record-store';
import { readJurorStates, anyJurorStatesExist } from '../../src/lib/diary/state-store';
import { readDiaryConfigIfPresent } from '../../src/lib/diary/config';
import { DIARY_INITIAL_RELATIONSHIP } from '../../src/schemas/diary-state';
import { seedDiaryContentRoot } from '../helpers/diary-fixtures';

/**
 * Bootstrap is the only operation that writes persona state from nothing, so its guards matter
 * more than its output: it must refuse to run over a live experiment, and `--force` must mean
 * "overwrite state" without ever meaning "buy the response again".
 */
describe('Diary bootstrap', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const offlineNetwork = pathToFileURL(path.join(__dirname, '..', 'helpers', 'offline-network.ts')).href;

  let contentRoot: string;

  beforeEach(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-diary-bootstrap-'));
  });

  afterEach(() => {
    fs.rmSync(contentRoot, { recursive: true, force: true });
  });

  function runBootstrap(args: string[] = []): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--import', offlineNetwork, 'scripts/diary-bootstrap.ts', ...args],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          JURYPRESS_DATA_MODE: 'production',
          JURYPRESS_CONTENT_ROOT: contentRoot,
          JURYDIARY_GEMINI_API_KEY: 'test-diary-key-value',
          JURYDIARY_GEMINI_MAX_ATTEMPTS: '1',
          DRY_RUN: 'false'
        },
        encoding: 'utf8'
      }
    );
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  }

  function storeBootstrapResponse(): void {
    const jurors = JUDGE_SLUGS.map((slug) => ({
      jurorId: slug,
      canonFacts: [
        { factType: 'home', fact: `${slug} lives somewhere specific and unremarkable.` },
        { factType: 'hobby', fact: `${slug} has a hobby nobody asked about.` },
        { factType: 'hobby', fact: `${slug} has a second, quieter hobby.` },
        { factType: 'habit', fact: `${slug} repeats a small daily habit.` },
        { factType: 'habit', fact: `${slug} has a habit they would not describe out loud.` },
        { factType: 'weakness', fact: `${slug} avoids one particular kind of conversation.` }
      ],
      currentMood: 'settled',
      initialConcern: 'something small and unresolved',
      ongoingActivity: 'a project that is taking longer than expected',
      viewsOfPeers: JUDGE_SLUGS.filter((peer) => peer !== slug).map((peer) => ({
        targetJurorId: peer,
        currentView: `Early impression of ${peer}, still provisional.`
      }))
    }));

    writeDiaryRecord(
      contentRoot,
      buildInitialDiaryRecord({
        recordId: 'diary-bootstrap',
        date: '2026-08-01',
        jurorId: JUDGE_SLUGS[0],
        theme: 'memory',
        privateEventCategory: null,
        generatedAt: '2026-08-01T00:00:00.000Z',
        requestedModel: 'gemini-3.5-flash',
        modelUsed: 'gemini-3.5-flash',
        promptVersion: DIARY_BOOTSTRAP_PROMPT_VERSION,
        responseSchemaVersion: DIARY_BOOTSTRAP_SCHEMA_VERSION,
        promptHash: 'b'.repeat(64),
        rawResponse: JSON.stringify({ schemaVersion: DIARY_BOOTSTRAP_SCHEMA_VERSION, jurors }),
        usage: { inputTokens: 900, outputTokens: 1500, thinkingTokens: 400, totalTokens: 2800 },
        route: { attempts: 1, keySource: 'dedicated' }
      })
    );
  }

  it('derives all five personas from a stored response without calling Gemini', () => {
    storeBootstrapResponse();

    // Offline: any Gemini attempt would fail the run.
    const result = runBootstrap(['--start-date', '2026-08-01']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Reusing the stored bootstrap response');

    for (const slug of JUDGE_SLUGS) {
      const states = readJurorStates(contentRoot, slug);
      expect(states, `${slug} should have state`).not.toBeNull();
      if (!states) continue;

      expect(states.canon.state.facts.length).toBeGreaterThanOrEqual(4);
      expect(states.canon.state.facts.filter((fact) => fact.factType === 'home')).toHaveLength(1);
      expect(states.character.lastEventId).toBe('bootstrap');
      expect(states.memories.state.memories).toHaveLength(0);

      // Relationship numbers come from code, never the model: everyone starts neutral.
      const peers = Object.keys(states.relationships.state);
      expect(peers.sort()).toEqual(JUDGE_SLUGS.filter((peer) => peer !== slug).sort());
      for (const peer of peers) {
        const relationship = states.relationships.state[peer as keyof typeof states.relationships.state]!;
        expect(relationship.trust).toBe(DIARY_INITIAL_RELATIONSHIP.trust);
        expect(relationship.respect).toBe(DIARY_INITIAL_RELATIONSHIP.respect);
        expect(relationship.tension).toBe(DIARY_INITIAL_RELATIONSHIP.tension);
        expect(relationship.currentView.length).toBeGreaterThan(0);
      }
    }
  });

  it('writes a config whose start date defines the rotation', () => {
    storeBootstrapResponse();
    runBootstrap(['--start-date', '2026-08-01']);

    const config = readDiaryConfigIfPresent(contentRoot);
    expect(config?.startDate).toBe('2026-08-01');
    expect(config?.rotation).toEqual([...JUDGE_SLUGS]);
    expect(config?.timezone).toBe('Asia/Tokyo');
  });

  it('refuses to run over an existing experiment without --force', () => {
    seedDiaryContentRoot(contentRoot);
    storeBootstrapResponse();

    const result = runBootstrap();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Persona state already exists');
  });

  it('overwrites existing state only when forced, and still does not call Gemini', () => {
    seedDiaryContentRoot(contentRoot);
    storeBootstrapResponse();

    const result = runBootstrap(['--force', '--start-date', '2026-08-01']);
    expect(result.status).toBe(0);

    // The seeded fixture canon is replaced by the bootstrap response's canon.
    const states = readJurorStates(contentRoot, 'david')!;
    expect(states.canon.state.facts.some((fact) => fact.fact.includes('david'))).toBe(true);
  });

  it('fails without writing any state when no response can be obtained', () => {
    const result = runBootstrap();
    expect(result.status).toBe(1);
    expect(anyJurorStatesExist(contentRoot)).toBe(false);
    expect(readDiaryConfigIfPresent(contentRoot)).toBeNull();
  });
});
