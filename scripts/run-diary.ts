import 'dotenv/config';
import * as fs from 'node:fs';
import { resolveContentRoot } from '../src/lib/content-root';
import { TimezoneUtil } from '../src/lib/timezone';
import { getJudge } from '../src/lib/jury';
import {
  DIARY_PROMPT_VERSION,
  DIARY_RESPONSE_SCHEMA_VERSION,
  DIARY_VALIDATOR_VERSION,
  DiaryResponseGenSchema,
  DiaryEntrySchema,
  buildDiaryId,
  type DiaryEntry
} from '../src/schemas/diary';
import { DiaryFailureSchema } from '../src/schemas/diary-record';
import type { JudgeSlug } from '../src/schemas/jury';
import { readDiaryConfig } from '../src/lib/diary/config';
import { isDateKey, resolveDutyJuror, resolveNextDuty } from '../src/lib/diary/rotation';
import { resolveDailyBrief } from '../src/lib/diary/theme';
import { readJurorStates, writeJurorStates } from '../src/lib/diary/state-store';
import {
  buildInitialDiaryRecord,
  readDiaryRecord,
  writeDiaryRecord
} from '../src/lib/diary/record-store';
import {
  diaryEntryExists,
  readAllDiaryEntries,
  writeDiaryEntry,
  writeDiaryEvent
} from '../src/lib/diary/entry-store';
import { buildDiaryContext } from '../src/lib/diary/context';
import { buildDiaryPrompt } from '../src/lib/diary/prompt';
import { generateDiaryStructured } from '../src/lib/diary/gemini';
import { validateDiaryResponse } from '../src/lib/diary/validator';
import { applyDiaryPatches, isAlreadyApplied } from '../src/lib/diary/patch-engine';
import { listReviewSlugs } from '../src/lib/diary/review-context';
import { diaryFailurePath, writeJsonAtomic } from '../src/lib/diary/storage';
import { sanitizeErrorSummary } from '../src/lib/evaluation/gemini-transport';

/**
 * JuryDiary's daily CLI.
 *
 * Split into three invocations on purpose, mirroring the article pipeline: the workflow commits
 * the verbatim response between `generate` and `--apply-record`, so the durability of a paid-for
 * response never depends on the code that interprets it. Re-running any stage converges — a run
 * whose response is stored never calls Gemini again, and a day already applied is a no-op.
 *
 *   npx tsx scripts/run-diary.ts [--target-date YYYY-MM-DD] [--run-key <key>]
 *   npx tsx scripts/run-diary.ts --apply-record --run-key <key>
 *   npx tsx scripts/run-diary.ts --update-status published --run-key <key>
 *
 * Exit codes follow the house rule: a structurally invalid diary is a *normal completion*
 * (exit 0, excluded, green workflow, gap in the archive). Exit 1 is reserved for a run that
 * could not be completed at all — no response, unreadable state, refusal to publish.
 */

interface DiaryCliArgs {
  mode: 'generate' | 'apply' | 'update-status';
  targetDate: string | null;
  runKey: string | null;
  status: string | null;
  githubOutput: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): DiaryCliArgs {
  const args: DiaryCliArgs = {
    mode: 'generate',
    targetDate: null,
    runKey: null,
    status: null,
    githubOutput: null,
    dryRun: process.env.DRY_RUN === 'true'
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    switch (flag) {
      case '--apply-record':
        args.mode = 'apply';
        break;
      case '--update-status':
        args.mode = 'update-status';
        args.status = argv[++i] ?? null;
        break;
      case '--target-date':
        args.targetDate = argv[++i] ?? null;
        break;
      case '--run-key':
        args.runKey = argv[++i] ?? null;
        break;
      case '--github-output':
        args.githubOutput = argv[++i] ?? null;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      default:
        throw new Error(`[Diary] Unknown argument: ${flag}`);
    }
  }

  return args;
}

type OutputValue = string | number | boolean | null;

/** Values are single-line by construction; newlines are stripped so nothing can inject steps. */
function appendGithubOutputs(filePath: string | null, outputs: Record<string, OutputValue>): void {
  const lines = Object.entries(outputs).map(
    ([key, value]) => `${key}=${String(value ?? '').replace(/[\r\n]+/g, ' ')}`
  );
  console.log(`\n[Diary] Outputs:\n${lines.join('\n')}`);
  if (filePath) fs.appendFileSync(filePath, `${lines.join('\n')}\n`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function writeFailure(
  contentRoot: string,
  runKey: string,
  stage: 'rotation' | 'context' | 'generation' | 'validation' | 'application' | 'persistence',
  error: any,
  meta: { jurorId: string | null; date: string | null }
): void {
  try {
    const failure = DiaryFailureSchema.parse({
      data_class: 'production',
      run_key: runKey,
      status: 'failed',
      stage,
      jurorId: meta.jurorId,
      date: meta.date,
      attempts: typeof error?.totalAttempts === 'number' ? error.totalAttempts : 1,
      error_code: error?.name || 'Error',
      // Sanitized category only — a failure record must never carry a credential.
      error_summary: error?.lastErrorCategory || sanitizeErrorSummary(error),
      failed_at: nowIso()
    });
    writeJsonAtomic(diaryFailurePath(contentRoot, runKey), failure);
    console.error(`[Diary] Failure recorded at ${diaryFailurePath(contentRoot, runKey)}`);
  } catch (failureError: any) {
    console.error(`[Diary] Could not record failure: ${failureError.message}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Generate                                                                   */
/* -------------------------------------------------------------------------- */

async function runGenerate(args: DiaryCliArgs): Promise<number> {
  const contentRoot = resolveContentRoot();
  const config = readDiaryConfig(contentRoot);

  const date = args.targetDate ?? TimezoneUtil.getJSTDateKey();
  if (!isDateKey(date)) {
    throw new Error(`[Diary] Invalid target date: ${date}`);
  }

  const jurorId = resolveDutyJuror(config, date);
  const runKey = buildDiaryId(date, jurorId);

  // An explicit run key is a resume, not an override: it must agree with whose turn it is.
  if (args.runKey && args.runKey !== runKey) {
    throw new Error(
      `[Diary] Run key ${args.runKey} does not match the duty roster for ${date} (${runKey}).`
    );
  }

  const { theme, privateEventCategory } = resolveDailyBrief(date, jurorId);
  console.log(`[Diary] ${date} — ${jurorId} — theme: ${theme}${privateEventCategory ? ` (${privateEventCategory})` : ''}`);

  const existing = readDiaryRecord(contentRoot, runKey);

  if (existing?.publication.status === 'published') {
    console.log('[Diary] Already published. Nothing to do.');
    appendGithubOutputs(args.githubOutput, {
      run_key: runKey,
      juror_slug: jurorId,
      entry_date: date,
      theme,
      generation_performed: false,
      resumed: true,
      proceed: false,
      publication_status: 'published'
    });
    return 0;
  }

  if (existing?.publication.status === 'excluded') {
    console.log('[Diary] Terminal excluded record. Not regenerating.');
    appendGithubOutputs(args.githubOutput, {
      run_key: runKey,
      juror_slug: jurorId,
      entry_date: date,
      theme,
      generation_performed: false,
      resumed: true,
      proceed: false,
      publication_status: 'excluded'
    });
    return 0;
  }

  // The response-first guarantee: a stored response is never bought twice.
  if (existing && existing.generation.rawResponse !== null) {
    console.log('[Diary] Response already stored for this run key. Skipping Gemini.');
    appendGithubOutputs(args.githubOutput, {
      run_key: runKey,
      juror_slug: jurorId,
      entry_date: date,
      theme,
      generation_performed: false,
      resumed: true,
      proceed: true,
      publication_status: 'generated',
      model_used: existing.generation.modelUsed
    });
    return 0;
  }

  if (diaryEntryExists(contentRoot, date, jurorId)) {
    console.log('[Diary] An entry already exists for this day. Nothing to do.');
    appendGithubOutputs(args.githubOutput, {
      run_key: runKey,
      juror_slug: jurorId,
      entry_date: date,
      theme,
      generation_performed: false,
      resumed: true,
      proceed: false,
      publication_status: 'published'
    });
    return 0;
  }

  const states = readJurorStates(contentRoot, jurorId);
  if (!states) {
    throw new Error(
      `[Diary] ${jurorId} has no persona state. Run the bootstrap operation before generating.`
    );
  }

  const context = buildDiaryContext({
    contentRoot,
    juror: getJudge(jurorId as JudgeSlug),
    date,
    theme,
    privateEventCategory,
    states,
    entries: readAllDiaryEntries(contentRoot)
  });

  const prompt = buildDiaryPrompt(context);
  console.log(`[Diary] Prompt built: ${prompt.length} characters.`);
  if (context.readingTarget) {
    console.log(
      `[Diary] Reading assignment: ${context.readingTarget.diaryId}` +
        `${context.readingTarget.mentionsReader ? ' (it mentions them)' : ''}`
    );
  }

  if (args.dryRun) {
    console.log('[Diary] DRY RUN — not calling Gemini.');
    console.log(prompt);
    appendGithubOutputs(args.githubOutput, {
      run_key: runKey,
      juror_slug: jurorId,
      entry_date: date,
      theme,
      generation_performed: false,
      proceed: false,
      publication_status: 'pending'
    });
    return 0;
  }

  const result = await generateDiaryStructured({ prompt, schema: DiaryResponseGenSchema });

  // Persist verbatim, before anything reads it.
  const record = buildInitialDiaryRecord({
    recordId: runKey,
    date,
    jurorId,
    theme,
    privateEventCategory,
    readingTargetId: context.readingTarget?.diaryId ?? null,
    generatedAt: nowIso(),
    requestedModel: result.requestedModel,
    modelUsed: result.modelUsed,
    promptVersion: DIARY_PROMPT_VERSION,
    responseSchemaVersion: DIARY_RESPONSE_SCHEMA_VERSION,
    promptHash: result.promptHash,
    rawResponse: result.rawResponse,
    usage: result.usage,
    route: { attempts: result.attempts, keySource: result.keySource }
  });
  writeDiaryRecord(contentRoot, record);
  console.log(`[Diary] Response persisted to the generation record (${result.rawResponse.length} characters).`);

  appendGithubOutputs(args.githubOutput, {
    run_key: runKey,
    juror_slug: jurorId,
    entry_date: date,
    theme,
    generation_performed: true,
    resumed: false,
    proceed: true,
    publication_status: 'generated',
    model_used: result.modelUsed,
    key_source: result.keySource,
    input_tokens: result.usage.inputTokens,
    output_tokens: result.usage.outputTokens,
    thinking_tokens: result.usage.thinkingTokens
  });
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Apply                                                                      */
/* -------------------------------------------------------------------------- */

async function runApply(args: DiaryCliArgs): Promise<number> {
  if (!args.runKey) {
    throw new Error('[Diary] --apply-record requires --run-key.');
  }

  const contentRoot = resolveContentRoot();
  const record = readDiaryRecord(contentRoot, args.runKey);
  if (!record) {
    throw new Error(`[Diary] No generation record for ${args.runKey}.`);
  }

  const baseOutputs = {
    run_key: record.recordId,
    juror_slug: record.jurorId,
    entry_date: record.date,
    theme: record.theme
  };

  if (record.publication.status === 'published' || record.publication.status === 'excluded') {
    console.log(`[Diary] Record is terminal (${record.publication.status}). Nothing to apply.`);
    appendGithubOutputs(args.githubOutput, {
      ...baseOutputs,
      applied: false,
      proceed: false,
      publication_status: record.publication.status
    });
    return 0;
  }

  if (record.generation.status !== 'succeeded' || record.generation.rawResponse === null) {
    throw new Error(`[Diary] ${args.runKey} has no stored response to apply.`);
  }

  if (record.application.status === 'applied') {
    console.log('[Diary] Patches already applied for this run key.');
    appendGithubOutputs(args.githubOutput, {
      ...baseOutputs,
      applied: false,
      proceed: true,
      publication_status: record.publication.status
    });
    return 0;
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(record.generation.rawResponse);
  } catch {
    parsed = null;
  }

  const verdict = validateDiaryResponse({
    parsed,
    expected: {
      date: record.date,
      jurorId: record.jurorId,
      theme: record.theme,
      privateEventCategory: record.privateEventCategory,
      allowedReviewSlugs: listReviewSlugs(contentRoot),
      readingTargetId: record.readingTargetId
    }
  });

  const checkedAt = nowIso();

  if (verdict.status === 'failed' || !verdict.response) {
    // A normal completion: the day is lost, the workflow is green, nothing is published and
    // no persona state moves. Exactly what a structurally broken response should cost.
    for (const finding of verdict.errors) {
      console.log(`::warning title=${finding.code}::${finding.path} ${finding.message}`);
    }
    const excluded = writeDiaryRecord(contentRoot, {
      ...record,
      structural: {
        status: 'failed',
        checkedAt,
        validatorVersion: DIARY_VALIDATOR_VERSION,
        errors: verdict.errors,
        warnings: verdict.warnings
      },
      application: { status: 'skipped', eventId: null, appliedAt: null },
      publication: {
        status: 'excluded',
        reason: 'structural_validation_failed',
        publishedAt: null
      }
    });
    console.log(`[Diary] Structurally invalid response — excluded. ${verdict.errors.length} error(s).`);
    appendGithubOutputs(args.githubOutput, {
      ...baseOutputs,
      applied: false,
      proceed: false,
      structural_status: 'failed',
      error_count: verdict.errors.length,
      warning_count: verdict.warnings.length,
      publication_status: excluded.publication.status
    });
    return 0;
  }

  for (const finding of verdict.warnings) {
    console.log(`::notice title=${finding.code}::${finding.path} ${finding.message}`);
  }

  const states = readJurorStates(contentRoot, record.jurorId);
  if (!states) {
    throw new Error(`[Diary] ${record.jurorId} has no persona state to apply onto.`);
  }

  const appliedAt = nowIso();
  let eventId = record.recordId;

  if (isAlreadyApplied(states, record.recordId)) {
    // A previous attempt applied the patches but did not finish writing the day. Do not apply
    // twice; carry on and complete what is missing.
    console.log('[Diary] Persona state already carries this day. Completing the remaining writes.');
  } else {
    const applied = applyDiaryPatches({
      states,
      response: verdict.response,
      diaryId: record.recordId,
      date: record.date,
      appliedAt,
      model: record.generation.modelUsed,
      promptVersion: record.generation.promptVersion ?? DIARY_PROMPT_VERSION,
      responseSchemaVersion: record.generation.responseSchemaVersion ?? DIARY_RESPONSE_SCHEMA_VERSION
    });
    // Event first, then state: if this is interrupted, the next run sees state that has not
    // moved and re-applies cleanly from the stored response.
    writeDiaryEvent(contentRoot, applied.event);
    writeJurorStates(contentRoot, record.jurorId, applied.states);
    eventId = applied.event.eventId;
    console.log(`[Diary] Patches applied and event ${eventId} written.`);
  }

  if (!diaryEntryExists(contentRoot, record.date, record.jurorId)) {
    const entry: DiaryEntry = DiaryEntrySchema.parse({
      schema_version: '1.0',
      id: record.recordId,
      date: record.date,
      jurorId: record.jurorId,
      theme: record.theme,
      privateEventCategory: record.privateEventCategory,
      title: verdict.response.diary.title,
      body: verdict.response.diary.body,
      mood: verdict.response.diary.mood,
      shareQuote: verdict.response.diary.shareQuote,
      relatedReviewSlugs: verdict.response.relatedReviewIds,
      respondsToDiaryId: verdict.response.respondsTo?.diaryId ?? null,
      publishedAt: appliedAt,
      generation: {
        model: record.generation.modelUsed,
        promptVersion: record.generation.promptVersion ?? DIARY_PROMPT_VERSION
      }
    });
    writeDiaryEntry(contentRoot, entry);
    console.log(`[Diary] Entry written for ${record.date}.`);
  }

  const updated = writeDiaryRecord(contentRoot, {
    ...record,
    structural: {
      status: 'passed',
      checkedAt,
      validatorVersion: DIARY_VALIDATOR_VERSION,
      errors: [],
      warnings: verdict.warnings
    },
    application: { status: 'applied', eventId, appliedAt },
    publication: record.publication
  });

  appendGithubOutputs(args.githubOutput, {
    ...baseOutputs,
    applied: true,
    proceed: true,
    structural_status: 'passed',
    error_count: 0,
    warning_count: verdict.warnings.length,
    event_id: eventId,
    publication_status: updated.publication.status
  });
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Update status                                                              */
/* -------------------------------------------------------------------------- */

async function runUpdateStatus(args: DiaryCliArgs): Promise<number> {
  if (!args.runKey) throw new Error('[Diary] --update-status requires --run-key.');
  if (args.status !== 'published') {
    throw new Error(`[Diary] Unsupported status: ${args.status}. Only "published" is supported.`);
  }

  const contentRoot = resolveContentRoot();
  const record = readDiaryRecord(contentRoot, args.runKey);
  if (!record) throw new Error(`[Diary] No generation record for ${args.runKey}.`);

  if (record.publication.status === 'published') {
    console.log('[Diary] Already marked published.');
    appendGithubOutputs(args.githubOutput, {
      run_key: record.recordId,
      publication_status: 'published',
      state_changed: false
    });
    return 0;
  }

  // Fail closed rather than promote something that never passed both gates.
  if (record.publication.status === 'excluded') {
    throw new Error(`[Diary] Refusing to publish an excluded record: ${args.runKey}.`);
  }
  if (record.structural.status !== 'passed' || record.application.status !== 'applied') {
    throw new Error(
      `[Diary] Refusing to publish ${args.runKey}: structural=${record.structural.status}, application=${record.application.status}.`
    );
  }

  const updated = writeDiaryRecord(contentRoot, {
    ...record,
    publication: { status: 'published', reason: null, publishedAt: nowIso() }
  });

  console.log(`[Diary] ${args.runKey} marked published.`);
  appendGithubOutputs(args.githubOutput, {
    run_key: updated.recordId,
    juror_slug: updated.jurorId,
    entry_date: updated.date,
    publication_status: 'published',
    state_changed: true
  });
  return 0;
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let runKeyForFailure = args.runKey ?? 'diary-bootstrap';
  let jurorForFailure: string | null = null;
  let dateForFailure: string | null = null;

  try {
    if (args.mode === 'apply') {
      process.exit(await runApply(args));
    }
    if (args.mode === 'update-status') {
      process.exit(await runUpdateStatus(args));
    }

    // Resolve identity early so a later failure can be filed against the right day.
    const contentRoot = resolveContentRoot();
    const config = readDiaryConfig(contentRoot);
    const date = args.targetDate ?? TimezoneUtil.getJSTDateKey();
    if (isDateKey(date)) {
      dateForFailure = date;
      const juror = resolveDutyJuror(config, date);
      jurorForFailure = juror;
      runKeyForFailure = buildDiaryId(date, juror);
    }

    process.exit(await runGenerate(args));
  } catch (error: any) {
    console.error(`[Diary] ${error?.message ?? error}`);

    if (args.mode === 'generate') {
      try {
        writeFailure(resolveContentRoot(), runKeyForFailure, 'generation', error, {
          jurorId: jurorForFailure,
          date: dateForFailure
        });
      } catch {
        // Content root itself was unusable; the console error above is the only record.
      }
    }
    process.exit(1);
  }
}

main();
