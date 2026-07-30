import 'dotenv/config';
import * as fs from 'node:fs';
import { resolveContentRoot } from '../src/lib/content-root';
import { TimezoneUtil } from '../src/lib/timezone';
import { getJudges } from '../src/lib/jury';
import { JUDGE_SLUGS, type JudgeSlug } from '../src/schemas/jury';
import {
  DIARY_BOOTSTRAP_PROMPT_VERSION,
  DIARY_BOOTSTRAP_SCHEMA_VERSION,
  DiaryBootstrapResponseGenSchema,
  validateDiaryBootstrapResponse,
  type DiaryBootstrapJuror
} from '../src/schemas/diary-bootstrap';
import {
  DIARY_STATE_SCHEMA_VERSION,
  DiaryCharacterStateSchema,
  DiaryLifeStateSchema,
  DiaryMemoriesSchema,
  DiaryPrivateCanonSchema,
  DiaryRelationshipsSchema,
  buildInitialRelationshipMap,
  type DiaryJurorStates
} from '../src/schemas/diary-state';
import type { DiaryCanonFactType } from '../src/schemas/diary';
import {
  buildDefaultDiaryConfig,
  diaryConfigExists,
  readDiaryConfigIfPresent,
  writeDiaryConfig
} from '../src/lib/diary/config';
import {
  anyJurorStatesExist,
  jurorStatesExist,
  writeJurorStates
} from '../src/lib/diary/state-store';
import {
  buildInitialDiaryRecord,
  readDiaryRecord,
  writeDiaryRecord
} from '../src/lib/diary/record-store';
import { generateDiaryStructured } from '../src/lib/diary/gemini';

/**
 * One-off initialisation of all five personas.
 *
 * Manual by design and never scheduled: it is the only operation that writes persona state
 * from nothing, and running it by accident against a live experiment would erase months of
 * accumulated life. Hence the `--force` gate, and hence the refusal to touch a juror who
 * already has state unless forced.
 *
 * Response-first applies here too. The bootstrap response is persisted before it is parsed,
 * and a re-run with a stored response re-derives the states from it rather than calling
 * Gemini again — so `--force` grants permission to overwrite state, never to spend quota.
 *
 *   npm run diary:bootstrap
 *   npm run diary:bootstrap -- --force
 */

const BOOTSTRAP_RUN_KEY = 'diary-bootstrap';

interface BootstrapArgs {
  force: boolean;
  startDate: string | null;
  githubOutput: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): BootstrapArgs {
  const args: BootstrapArgs = {
    force: false,
    startDate: null,
    githubOutput: null,
    dryRun: process.env.DRY_RUN === 'true'
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--force':
        args.force = true;
        break;
      case '--start-date':
        args.startDate = argv[++i] ?? null;
        break;
      case '--github-output':
        args.githubOutput = argv[++i] ?? null;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        throw new Error(`[Diary Bootstrap] Unknown argument: ${flag}`);
    }
  }
  return args;
}

function buildBootstrapPrompt(): string {
  const judges = getJudges();

  const personas = judges
    .map((judge) =>
      [
        `- ${judge.slug} (${judge.name}, ${judge.role})`,
        `  background: ${judge.background}`,
        `  voice: ${judge.personalityAndTone}`,
        `  values: ${judge.loves.join('; ')}`,
        `  dislikes: ${judge.hates.join('; ')}`
      ].join('\n')
    )
    .join('\n\n');

  return [
    'You are setting up a long-running fiction experiment called JuryDiary.',
    '',
    'Five existing AI jurors review open-source projects together. They are about to start keeping',
    'private diaries, and they need a small, believable fictional private life to start from.',
    '',
    '[THE FIVE JURORS — their professional personas are fixed and must not be contradicted]',
    personas,
    '',
    '[WHAT TO INVENT FOR EACH JUROR]',
    'Keep it deliberately sparse. These lives are meant to grow through the diaries themselves, so',
    'give each juror only a starting point:',
    '- exactly ONE home fact (factType "home") — where and how they live',
    '- at most ONE close person (factType "companion") — a friend, sibling or neighbour, unnamed or',
    '  first-name only, never a real person',
    '- TWO hobbies (factType "hobby")',
    '- TWO habits (factType "habit")',
    '- ONE private weakness or bad habit (factType "weakness")',
    '- at most ONE memorable object, place or animal (factType "possession" or "place")',
    'Also give each juror: a current mood, one thing quietly worrying them, and one thing they are',
    'in the middle of doing.',
    'Finally, for each juror, one sentence about how they currently see each of the other four —',
    'first impressions from working together, not a verdict.',
    '',
    '[RULES]',
    '- The five private lives must be clearly different from each other. Do not give them all pets,',
    '  all the same living situation, or all the same kind of hobby.',
    '- Nothing may contradict their professional persona above.',
    '- No real people, no real addresses, no real employers, no public figures.',
    '- Keep everything small and ordinary. No tragedies, no dramatic backstories, no secrets.',
    '- Views of the other jurors must be mild and provisional. Nobody is an enemy or a best friend yet.',
    '- Do not invent any numbers, scores or ratings.',
    '',
    '[OUTPUT]',
    `Return ONLY a JSON object matching the provided schema, with schemaVersion "${DIARY_BOOTSTRAP_SCHEMA_VERSION}",`,
    `covering exactly these five jurorIds: ${JUDGE_SLUGS.join(', ')}.`,
    'No preamble, no commentary, no markdown fences.'
  ].join('\n');
}

function buildStatesForJuror(
  juror: DiaryBootstrapJuror,
  startDate: string,
  updatedAt: string
): DiaryJurorStates {
  const jurorId = juror.jurorId as JudgeSlug;
  const envelope = {
    schema_version: DIARY_STATE_SCHEMA_VERSION,
    jurorId,
    updatedAt,
    lastEventId: 'bootstrap'
  };

  const views: Partial<Record<JudgeSlug, string>> = {};
  for (const view of juror.viewsOfPeers) {
    views[view.targetJurorId as JudgeSlug] = view.currentView.trim();
  }

  return {
    canon: DiaryPrivateCanonSchema.parse({
      ...envelope,
      state: {
        facts: juror.canonFacts.map((fact, index) => ({
          id: `fact-bootstrap-${jurorId}-${String(index + 1).padStart(2, '0')}`,
          factType: fact.factType as DiaryCanonFactType,
          fact: fact.fact.trim(),
          addedOn: startDate,
          source: 'bootstrap' as const,
          diaryId: null
        }))
      }
    }),
    character: DiaryCharacterStateSchema.parse({
      ...envelope,
      state: {
        currentMood: juror.currentMood.trim(),
        recentConcerns: [juror.initialConcern.trim()],
        emergingTraits: [],
        beliefsUnderPressure: [],
        unresolvedThoughts: []
      }
    }),
    life: DiaryLifeStateSchema.parse({
      ...envelope,
      state: {
        currentConcerns: [],
        ongoingActivities: [juror.ongoingActivity.trim()],
        recentEvents: [],
        unresolvedThreads: []
      }
    }),
    // Relationship numbers come from code, never from the model: everyone starts neutral.
    relationships: DiaryRelationshipsSchema.parse({
      ...envelope,
      state: buildInitialRelationshipMap(jurorId, views)
    }),
    memories: DiaryMemoriesSchema.parse({ ...envelope, state: { memories: [] } })
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const contentRoot = resolveContentRoot();

  const existingJurors = JUDGE_SLUGS.filter((slug) => jurorStatesExist(contentRoot, slug));
  if (anyJurorStatesExist(contentRoot) && !args.force) {
    throw new Error(
      `[Diary Bootstrap] Persona state already exists for: ${existingJurors.join(', ')}. ` +
        'Re-running would discard an in-flight experiment. Pass --force only if that is intended.'
    );
  }

  const startDate =
    args.startDate ??
    readDiaryConfigIfPresent(contentRoot)?.startDate ??
    TimezoneUtil.getJSTDateKey();

  const existingRecord = readDiaryRecord(contentRoot, BOOTSTRAP_RUN_KEY);
  let rawResponse: string;
  let modelUsed: string | null = null;

  if (existingRecord && existingRecord.generation.rawResponse !== null) {
    // --force permits overwriting state. It never permits buying the same response twice.
    console.log('[Diary Bootstrap] Reusing the stored bootstrap response. Not calling Gemini.');
    rawResponse = existingRecord.generation.rawResponse;
    modelUsed = existingRecord.generation.modelUsed;
  } else {
    const prompt = buildBootstrapPrompt();
    console.log(`[Diary Bootstrap] Prompt built: ${prompt.length} characters.`);

    if (args.dryRun) {
      console.log('[Diary Bootstrap] DRY RUN — not calling Gemini.');
      console.log(prompt);
      return;
    }

    const result = await generateDiaryStructured({
      prompt,
      schema: DiaryBootstrapResponseGenSchema
    });

    // Persist verbatim before parsing, exactly as the daily path does.
    writeDiaryRecord(
      contentRoot,
      buildInitialDiaryRecord({
        recordId: BOOTSTRAP_RUN_KEY,
        date: startDate,
        jurorId: JUDGE_SLUGS[0],
        theme: 'memory',
        privateEventCategory: null,
        generatedAt: new Date().toISOString(),
        requestedModel: result.requestedModel,
        modelUsed: result.modelUsed,
        promptVersion: DIARY_BOOTSTRAP_PROMPT_VERSION,
        responseSchemaVersion: DIARY_BOOTSTRAP_SCHEMA_VERSION,
        promptHash: result.promptHash,
        rawResponse: result.rawResponse,
        usage: result.usage,
        route: { attempts: result.attempts, keySource: result.keySource }
      })
    );
    console.log('[Diary Bootstrap] Response persisted to the generation record.');

    rawResponse = result.rawResponse;
    modelUsed = result.modelUsed;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(rawResponse);
  } catch {
    parsed = null;
  }

  const verdict = validateDiaryBootstrapResponse(parsed);
  if (verdict.status === 'failed' || !verdict.response) {
    throw new Error(
      `[Diary Bootstrap] Stored response is not usable:\n  ${verdict.errors.join('\n  ')}`
    );
  }

  const updatedAt = new Date().toISOString();
  for (const juror of verdict.response.jurors) {
    const states = buildStatesForJuror(juror, startDate, updatedAt);
    writeJurorStates(contentRoot, juror.jurorId, states);
    console.log(`[Diary Bootstrap] Wrote persona state for ${juror.jurorId}.`);
  }

  if (!diaryConfigExists(contentRoot)) {
    const config = writeDiaryConfig(contentRoot, buildDefaultDiaryConfig(startDate));
    console.log(
      `[Diary Bootstrap] Wrote config with startDate ${config.startDate}. ` +
        'Review it before enabling autonomous publishing.'
    );
  }

  if (args.githubOutput) {
    fs.appendFileSync(
      args.githubOutput,
      [
        `bootstrap_completed=true`,
        `jurors_written=${verdict.response.jurors.length}`,
        `start_date=${startDate}`,
        `model_used=${modelUsed ?? ''}`,
        ''
      ].join('\n')
    );
  }

  console.log(
    `[Diary Bootstrap] Done. ${verdict.response.jurors.length} personas initialised from ${startDate}.`
  );
}

main().catch((error: any) => {
  console.error(`[Diary Bootstrap] ${error?.message ?? error}`);
  process.exit(1);
});
