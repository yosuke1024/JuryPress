import 'dotenv/config';
import { Selector } from '../src/lib/selection/selector';
import { EvidenceCollector } from '../src/lib/evidence/collector';
import { Evaluator } from '../src/lib/evaluation/evaluator';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';

import { TimezoneUtil } from '../src/lib/timezone';
import { EvaluationOutputSchema } from '../src/schemas/evaluation';
import { EvidenceBundleSchema, EvidenceCollectionResultSchema, type EvidenceCollectionResult } from '../src/schemas/evidence';
import { prepareCandidateWithIntegrityContext } from '../src/lib/daily-evaluation';
import { resolveContentRoot, resolveDataMode } from '../src/lib/content-root';
import {
  FailureSchema,
  type AnyRunState,
  type RunStatusV2
} from '../src/schemas/selection';
import { parseRunCliArgs, type RunCliArgs } from '../src/lib/publication/cli-args';
import { generateAndPersist, validateAndPersist } from '../src/lib/generation/pipeline';
import { buildReviewFromRecord } from '../src/lib/generation/build-review';
import { readRecord, writeRecord } from '../src/lib/generation/record-store';
import type { GenerationRecord } from '../src/schemas/generation-record';
import { buildManualRunKey, buildScheduledRunKey } from '../src/lib/publication/run-keys';
import {
  collectActiveExclusions,
  isRunStateV2,
  normalizeRunStatus,
  readRunState,
  readPublicationState,
  writePublicationState,
  writeRunState,
  RUN_STATUS_ORDER
} from '../src/lib/publication/state-store';

const PUBLICATION_STATUS_ORDER: Record<string, number> = {
  generated: 0,
  validated: 1,
  committed: 2,
  published: 3
};

function nextStageFor(status: string): string {
  switch (status) {
    case 'reserved':
    case 'generating':
      return 'generate';
    case 'generated':
      return 'validate';
    case 'validated':
      return 'build';
    case 'committed':
      return 'deploy';
    case 'published':
      return 'none';
    default:
      return 'generate';
  }
}

function appendGithubOutputs(outputFile: string | undefined, outputs: Record<string, string | number | boolean | null | undefined>): void {
  if (!outputFile) return;
  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value ?? ''}`)
    .join('\n');
  fs.appendFileSync(outputFile, `${lines}\n`);
  console.log(`[State Machine] Output variables written to ${outputFile}`);
}

function computeSlug(candidateName: string, sourceId: string): string {
  const hash = crypto.createHash('md5').update(sourceId || '').digest('hex').substring(0, 6);
  const cleanName = candidateName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${cleanName}-${hash}`;
}

async function runSmokeTest() {
  console.log("Running Live Gemini Smoke Test...");
  const evaluator = new Evaluator();
  const candidate = {
    name: 'Smoke Test Product',
    canonicalUrl: 'https://example.com',
    sourceUrl: 'https://example.com',
    source: 'GitHub',
    sourceId: '123',
    sourceRank: 1,
    popularityValue: 100,
    popularityUnit: 'stars',
    collectedAt: new Date().toISOString(),
    metadata: {}
  };
  const evidences = [
    {
      evidence_id: 'ev-1',
      type: 'official_site',
      url: 'https://example.com',
      title: 'Smoke Test Site',
      retrieved_at: new Date().toISOString(),
      content_hash: 'abc',
      summary: 'This is a smoke test product. It is designed to verify the Gemini API structure. It has high performance and simple UX.',
      claims: []
    },
    {
      evidence_id: 'ev-2',
      type: 'readme',
      url: 'https://example.com/readme',
      title: 'Smoke Test Readme',
      retrieved_at: new Date().toISOString(),
      content_hash: 'def',
      summary: 'Documentation for smoke test product. To install: run npm install. It solves automated testing problems.',
      claims: []
    }
  ];

  const evaluationRaw = await evaluator.evaluate(candidate, evidences);
  console.log("Gemini API Call Successful.");

  // Zod Verification
  EvaluationOutputSchema.parse(evaluationRaw.output);
  console.log("Schema Validation Result: SUCCESS");

  // Score recalculation
  const evaluationFinal = evaluator.recalculateScores(evaluationRaw.output, evidences, { prompt_version: "2.1.0" });
  console.log("Score Recalculation: SUCCESS");

  console.log(`SMOKE TEST RESULTS:
- Model: ${evaluationRaw.modelUsed}
- Thinking Level: ${evaluationRaw.thinkingLevel}
- API Call Count: 1
- Attempt Count: ${evaluationRaw.attemptCount}
- Input Tokens: ${evaluationRaw.usage?.input_tokens}
- Output Tokens: ${evaluationRaw.usage?.output_tokens}
- Schema Validation Result: SUCCESS`);
}

/**
 * State-transition mode (--update-status). Forward transitions are applied; a same-status
 * update is a clean no-op; a would-be regression is refused (skipped, exit 0) so resumed
 * workflows can replay their stage steps without corrupting the state machine.
 */
function handleUpdateStatus(args: RunCliArgs, argv: string[]): void {
  const targetStatus = args.updateStatus as string;
  const contentRoot = resolveContentRoot();
  const mode = resolveDataMode();
  let targetSlug = args.slug || '';

  if (targetSlug && !/^[a-z0-9][a-z0-9-]*$/.test(targetSlug)) {
    console.error(`Error: --slug contains forbidden characters: ${targetSlug}`);
    process.exit(1);
  }
  if (mode === 'production' && !targetSlug) {
    throw new Error('--slug is required for production status updates.');
  }
  const statusPubStateDir = path.join(contentRoot, 'publication-state');

  if (!targetSlug) {
    if (fs.existsSync(statusPubStateDir)) {
      const files = fs.readdirSync(statusPubStateDir).filter(f => f.endsWith('.json'));
      if (files.length > 0) {
        const sorted = files.map(f => ({
          name: f,
          mtime: fs.statSync(path.join(statusPubStateDir, f)).mtime.getTime()
        })).sort((a, b) => b.mtime - a.mtime);
        targetSlug = sorted[0].name.replace('.json', '');
      }
    }
  }

  if (!targetSlug) {
    console.error("Error: --update-status requested but no slug specified and no state files found.");
    process.exit(1);
  }

  const pubState: any = readPublicationState(contentRoot, targetSlug);
  if (!pubState) {
    console.error(`Error: publication state file not found for slug: ${targetSlug}`);
    process.exit(1);
  }

  if (!['generated', 'validated', 'committed', 'published', 'failed'].includes(targetStatus)) {
    console.error(`Error: invalid status for --update-status: ${targetStatus}`);
    process.exit(1);
  }

  const currentOrder = PUBLICATION_STATUS_ORDER[pubState.publication_status];
  const targetOrder = PUBLICATION_STATUS_ORDER[targetStatus];
  let applied = false;

  if (targetStatus === 'failed') {
    if (pubState.publication_status === 'published') {
      console.error(`Error: refusing to mark published content ${targetSlug} as failed.`);
      process.exit(1);
    }
    pubState.publication_status = 'failed';
    applied = true;
  } else if (currentOrder === undefined || targetOrder === undefined || pubState.publication_status === 'failed') {
    // Recovering from failed (or an unknown legacy value) applies the requested status.
    pubState.publication_status = targetStatus;
    applied = true;
  } else if (targetOrder > currentOrder) {
    pubState.publication_status = targetStatus;
    applied = true;
  } else if (targetOrder === currentOrder) {
    console.log(`[State Machine] ${targetSlug} is already ${targetStatus}. No-op.`);
  } else {
    console.log(`[State Machine] Skipping regression of ${targetSlug}: ${pubState.publication_status} -> ${targetStatus} is not allowed.`);
  }

  const runKey = pubState.run_key || pubState.generation_run_id;

  if (applied) {
    if (targetStatus === 'published') {
      pubState.published_at = new Date().toISOString();
    }

    // Keep the run state machine in sync BEFORE persisting the publication state, and
    // fail closed when the sync errors: swallowing it as a warning would let the workflow
    // commit a publication state that contradicts its run state. Legacy 1.0.0 run states
    // only understand published; 2.0.0 run states track every stage.
    if (runKey) {
      try {
        const runState = readRunState(contentRoot, runKey);
        if (!runState) {
          console.log(`[State Machine] No run state exists for run ${runKey}; updating the publication state only.`);
        } else if (isRunStateV2(runState)) {
          const nextRunStatus = targetStatus as RunStatusV2;
          const nextOrder = RUN_STATUS_ORDER[nextRunStatus];
          const currentStatus = normalizeRunStatus(runState);
          // A 'failed' target never syncs (run-state failures need failure metadata this
          // flow does not have); otherwise apply forward transitions and failed-state
          // recovery at or after the recorded previous status.
          if (nextOrder !== undefined) {
            let shouldWrite = false;
            if (currentStatus === 'failed') {
              const previous = runState.failure?.previous_status ?? 'reserved';
              const previousOrder = RUN_STATUS_ORDER[previous === 'failed' ? 'reserved' : previous] ?? 0;
              if (nextOrder >= previousOrder) {
                shouldWrite = true;
              } else {
                console.log(`[State Machine] Run ${runKey} failed at "${previous}"; a "${targetStatus}" update cannot recover it — leaving recovery to the ${previous} stage update.`);
              }
            } else if (nextOrder > RUN_STATUS_ORDER[currentStatus]) {
              shouldWrite = true;
            }
            if (shouldWrite) {
              writeRunState(contentRoot, {
                ...runState,
                status: nextRunStatus,
                updated_at: new Date().toISOString(),
                failure: undefined,
                ...(targetStatus === 'published' ? { published_at: pubState.published_at } : {})
              });
              console.log(`[State Machine] Updated run status to ${targetStatus} for run: ${runKey}`);
            }
          }
        } else if (targetStatus === 'published') {
          writeRunState(contentRoot, {
            ...(runState as any),
            status: 'published',
            published_at: pubState.published_at
          });
          console.log(`[State Machine] Updated run status to published for run: ${runKey}`);
        }
      } catch (error: any) {
        console.error(`[State Machine] Failed to sync run state for ${runKey}: ${error.message}. Failing closed without writing the publication state.`);
        process.exit(1);
      }
    }

    // The generation record is what the public allow-list reads, so the publication lifecycle
    // has to reach it or a published article would stay invisible. Sync it BEFORE writing the
    // publication state and fail closed on error: a publication state claiming "published"
    // while its record still says "ready" is exactly the contradiction the hash/status checks
    // exist to prevent.
    if (runKey && targetStatus === 'published') {
      try {
        const record = readRecord(contentRoot, runKey);
        if (!record) {
          console.log(`[State Machine] No generation record exists for ${runKey}; updating the publication state only.`);
        } else if (record.quality.status !== 'passed') {
          console.error(`[State Machine] Refusing to publish ${runKey}: its quality status is "${record.quality.status}", not "passed".`);
          process.exit(1);
        } else if (record.publication.status !== 'published') {
          writeRecord(contentRoot, {
            ...record,
            publication: {
              status: 'published',
              reason: null,
              publishedAt: pubState.published_at
            }
          });
          console.log(`[State Machine] Marked generation record ${runKey} as published.`);
        }
      } catch (error: any) {
        console.error(`[State Machine] Failed to sync the generation record for ${runKey}: ${error.message}. Failing closed.`);
        process.exit(1);
      }
    }

    writePublicationState(contentRoot, pubState);
    console.log(`[State Machine] Updated publication_status of ${targetSlug} to: ${targetStatus}`);
  }

  appendGithubOutputs(args.githubOutput, {
    run_key: runKey || '',
    slug: targetSlug,
    content_id: pubState.content_id,
    generation_run_id: pubState.generation_run_id || '',
    publication_status: pubState.publication_status,
    generation_performed: false
  });
}

/**
 * Phase 2 of the response-first pipeline: judge the response that phase 1 persisted.
 *
 * Exits 0 on a quality failure. That is the point: a stored response that does not meet the
 * bar is a completed run with an excluded result, not a broken workflow. Only a validator
 * that cannot run, or a record that cannot be persisted, is an error.
 *
 * Never calls Gemini. Never selects a different candidate to make up the numbers.
 */
function handleValidateRecord(args: RunCliArgs): void {
  const contentRoot = resolveContentRoot();
  const recordId = args.runKey as string;
  const seasonConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8'));

  const runState = readRunState(contentRoot, recordId);
  if (!runState) {
    throw new Error(`[Validate] No run state exists for ${recordId}; cannot resolve the evidence bundle.`);
  }
  const collectionResult = EvidenceCollectionResultSchema.parse((runState as any).collection_result);
  const evidences = collectionResult.evidences;

  const record = validateAndPersist({
    contentRoot,
    recordId,
    evidences,
    // Proves the validated content can actually become a review. A build failure is a content
    // defect (the response cannot produce publishable output), so it becomes a quality error
    // and excludes the record — it must never turn the workflow red.
    buildPublishedContent: content => {
      buildReviewFromRecord({
        record: readRecord(contentRoot, recordId)!,
        collectionResult,
        seasonConfig,
        date: new Date(),
        content
      });
    }
  });

  const passed = record.quality.status === 'passed';
  console.log(`[Validate] ${recordId}: generation=${record.generation.status} quality=${record.quality.status} publication=${record.publication.status}`);
  for (const finding of record.quality.errors) {
    // A GitHub Actions error annotation, not a process failure: the run still exits 0.
    console.log(`::warning title=Quality error::[${finding.code}] ${finding.path}: ${finding.message}`);
  }
  for (const finding of record.quality.warnings) {
    console.log(`::warning title=Quality warning::[${finding.code}] ${finding.path}: ${finding.message}`);
  }

  // Only content that passed is written into reviews/. Excluded content never reaches the
  // directory the site builds from, so it cannot leak through a build that forgets to filter.
  if (passed) {
    const built = buildReviewFromRecord({ record, collectionResult, seasonConfig, date: new Date() });
    const { year, month } = TimezoneUtil.getJSTYearMonth(new Date());
    const outDir = path.join(contentRoot, 'reviews', year, month, record.slug as string);
    const evidenceBundle = EvidenceBundleSchema.parse({
      data_class: 'production',
      evidences,
      metadata_snapshot: collectionResult.metadata_snapshot,
      evaluation_integrity_version: collectionResult.evaluation_integrity_version
    });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify(evidenceBundle, null, 2));
    fs.writeFileSync(path.join(outDir, 'selection.json'), JSON.stringify((runState as any).selection, null, 2));
    fs.writeFileSync(path.join(outDir, 'review.json'), JSON.stringify(built, null, 2));
    console.log(`[Validate] Wrote the publishable review for ${record.slug}.`);
  }

  appendGithubOutputs(args.githubOutput, {
    run_key: recordId,
    slug: record.slug || '',
    record_id: record.recordId,
    record_hash: record.quality.validatedContentHash || '',
    generation_status: record.generation.status,
    quality_status: record.quality.status,
    publication_status: record.publication.status,
    validator_version: record.quality.validatorVersion || '',
    error_count: record.quality.errors.length,
    warning_count: record.quality.warnings.length,
    repair_count: record.quality.repairs.length,
    new_published_articles: passed ? 1 : 0
  });

  writeValidationSummary(record);
}

/** §8 Actions summary. Reports the three axes separately — they are separate outcomes. */
function writeValidationSummary(record: any): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  const lines = [
    '### JuryPress Generation Result',
    '',
    `Candidate: ${record.candidate.name || record.candidate.id}`,
    `Run key: ${record.candidate.runKey}`,
    '',
    `Generation: ${record.generation.status}`,
    `Quality validation: ${record.quality.status}`,
    `Publication: ${record.publication.status}`,
    `New published articles: ${record.quality.status === 'passed' ? 1 : 0}`,
    '',
    `Record path: data/generations/${record.recordId}.json`,
    `Record hash: ${record.quality.validatedContentHash || 'n/a'}`,
    `Validator version: ${record.quality.validatorVersion || 'n/a'}`,
    ''
  ];
  if (record.quality.errors.length > 0) {
    lines.push('Errors:');
    for (const f of record.quality.errors) lines.push(`- [${f.code}] ${f.path}: ${f.message}`);
    lines.push('');
  }
  if (record.quality.warnings.length > 0) {
    lines.push('Warnings:');
    for (const f of record.quality.warnings) lines.push(`- [${f.code}] ${f.path}: ${f.message}`);
    lines.push('');
  }
  if (record.quality.repairs.length > 0) {
    lines.push('Deterministic repairs applied:');
    for (const r of record.quality.repairs) lines.push(`- [${r.code}] ${r.path}`);
    lines.push('');
  }
  fs.appendFileSync(summaryFile, `${lines.join('\n')}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  const args = parseRunCliArgs(argv);

  if (args.updateStatus) {
    handleUpdateStatus(args, argv);
    return;
  }

  if (args.validateRecord) {
    if (!args.runKey) {
      console.error('Error: --validate-record requires --run-key.');
      process.exit(1);
    }
    handleValidateRecord(args);
    return;
  }

  if (process.env.LIVE_GEMINI_SMOKE_TEST === 'true') {
    await runSmokeTest().catch(e => {
      console.error("Smoke test failed:", e.message);
      process.exit(1);
    });
    return;
  }

  const isDryRun = process.env.DRY_RUN === 'true';
  const targetDateStr = process.env.TARGET_DATE;
  const date = targetDateStr ? new Date(targetDateStr) : new Date();

  console.log(`Starting run for date: ${date.toISOString()} (Dry Run: ${isDryRun}, Operation: ${args.operation}, Trigger: ${args.trigger})`);

  let currentRunKey = '';
  let candidateForFailure: any = undefined;
  let stage = 'started';
  let selection: any = undefined;
  let candidate: any = undefined;
  let collectionResult: EvidenceCollectionResult | undefined;
  let runState: AnyRunState | null = null;
  let lastPersistedStatus: RunStatusV2 | null = null;
  let generationRecord: GenerationRecord | undefined;

  try {
    const contentRoot = resolveContentRoot();
    const seasonConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8'));

    // 1. Resolve the run key deterministically from operation/trigger.
    if (args.runKey) {
      currentRunKey = args.runKey;
    } else if (args.operation === 'publish_new' && args.trigger === 'manual') {
      currentRunKey = buildManualRunKey(seasonConfig.season, args.workflowRunId as string);
    } else {
      currentRunKey = buildScheduledRunKey(seasonConfig.season, date);
    }
    console.log(`Run key: ${currentRunKey}`);

    // 2. Load any existing state for this exact run key (never "any pending run").
    runState = readRunState(contentRoot, currentRunKey);
    if (runState) {
      lastPersistedStatus = normalizeRunStatus(runState);
    }

    // A failure BEFORE any reservation existed (e.g. the selector itself failed) leaves a
    // candidate-less failed state. That run never reserved anything, so a publish_new
    // retry re-runs selection instead of failing closed on the empty state.
    if (
      runState
      && args.operation === 'publish_new'
      && normalizeRunStatus(runState) === 'failed'
      && !isRunStateV2(runState)
      && !(runState as any).candidate
    ) {
      console.log(`[Resume] Run ${currentRunKey} failed before reserving a candidate. Re-running selection.`);
      runState = null;
      lastPersistedStatus = null;
    }

    if (args.operation === 'resume_pending' && !runState) {
      console.error(`[Resume] No run state exists for run key ${currentRunKey}. Failing closed.`);
      process.exit(1);
    }
    if (args.generateReserved && !runState) {
      console.error(`[Reservation] --generate-reserved requires an existing reservation for ${currentRunKey}, but none exists. Failing closed.`);
      process.exit(1);
    }

    // 3. Published runs are a clean no-op, regardless of operation.
    if (runState && normalizeRunStatus(runState) === 'published') {
      console.log(`Run ${currentRunKey} is already published. Exiting cleanly.`);
      const slug = (runState as any).slug || '';
      let contentId = isRunStateV2(runState)
        ? runState.candidate_reservation.content_id
        : ((runState as any).selection?.source_id || '');
      if (slug && !contentId) {
        const pubState: any = readPublicationState(contentRoot, slug);
        contentId = pubState?.content_id || '';
      }
      appendGithubOutputs(args.githubOutput, {
        run_key: currentRunKey,
        slug,
        content_id: contentId,
        generation_run_id: currentRunKey,
        publication_status: 'published',
        generation_performed: false,
        reservation_created: false,
        resumed: true,
        next_stage: 'none'
      });
      return;
    }

    // 4. Reservation stage. publish_new without an existing state selects a candidate and
    //    persists the reservation BEFORE any Gemini call; every other case reuses the
    //    stored reservation and never re-runs the selector.
    let reservationCreated = false;
    if (!runState) {
      const selector = new Selector();
      stage = 'selection';
      const exclusions = collectActiveExclusions(contentRoot);
      const result = await selector.selectForDate(date, {
        canonicalUrls: exclusions.canonicalUrls,
        contentIds: exclusions.contentIds
      });
      selection = result.selection;
      candidate = result.candidate;
      collectionResult = result.collection_result;

      // Inject data_class and the actual run key of this run.
      selection.data_class = 'production';
      selection.run_key = currentRunKey;

      const now = new Date().toISOString();
      const reservedState = {
        schema_version: '2.0.0' as const,
        data_class: 'production' as const,
        status: 'reserved' as const,
        run_key: currentRunKey,
        trigger: args.trigger,
        operation: args.operation,
        workflow_run_id: args.workflowRunId || '',
        reserved_at: now,
        updated_at: now,
        candidate_reservation: {
          content_id: candidate.sourceId,
          canonical_url: candidate.canonicalUrl,
          candidate_name: candidate.name
        },
        candidate,
        selection,
        collection_result: collectionResult
      };
      if (!isDryRun) {
        runState = writeRunState(contentRoot, reservedState as any);
        lastPersistedStatus = 'reserved';
      } else {
        runState = reservedState as any;
      }
      reservationCreated = true;
      console.log(`[Reservation] Reserved candidate "${candidate.name}" (${candidate.canonicalUrl}) for run ${currentRunKey}`);
    } else {
      // Reuse the stored reservation/candidate.
      if (isRunStateV2(runState)) {
        candidate = runState.candidate;
        selection = runState.selection;
        collectionResult = runState.collection_result;
        console.log(`[Reservation] Reusing reserved candidate for run ${currentRunKey}: ${runState.candidate_reservation.candidate_name} (${runState.status})`);
      } else {
        const legacy: any = runState;
        console.log(`Reusing candidate from previous run: ${legacy.candidate?.name}`);
        candidate = legacy.candidate ? {
          name: legacy.candidate.name,
          canonicalUrl: legacy.candidate.canonical_url,
          sourceUrl: legacy.selection?.source_url || '',
          source: legacy.selection?.source || '',
          sourceId: legacy.selection?.source_id || '',
          sourceRank: legacy.selection?.source_rank || 1,
          popularityValue: legacy.selection?.popularity_value || 0,
          popularityUnit: legacy.selection?.popularity_unit || '',
          collectedAt: legacy.selection?.selected_at || new Date().toISOString(),
          metadata: legacy.selection?.candidate_metadata || {}
        } : undefined;
        selection = legacy.selection;
        collectionResult = legacy.collection_result;
      }
    }

    candidateForFailure = candidate ? { name: candidate.name, canonical_url: candidate.canonicalUrl } : undefined;

    const resumed = !reservationCreated;
    const currentStatus: RunStatusV2 = runState ? normalizeRunStatus(runState) : 'reserved';
    const effectiveStatus: RunStatusV2 = currentStatus === 'failed'
      ? ((isRunStateV2(runState!) && runState!.failure ? runState!.failure.previous_status : 'reserved') as RunStatusV2)
      : currentStatus;

    if (!candidate && effectiveStatus !== 'generated' && effectiveStatus !== 'validated' && effectiveStatus !== 'committed') {
      throw new Error(`Run ${currentRunKey} has no stored candidate to resume from.`);
    }

    const slug = (runState as any)?.slug
      || computeSlug(candidate?.name || '', candidate?.sourceId || '');

    // 5. Reserve-only mode stops here; the workflow commits the reservation, then calls
    //    back with --generate-reserved.
    if (args.reserveOnly) {
      appendGithubOutputs(args.githubOutput, {
        run_key: currentRunKey,
        slug: (runState as any)?.slug || '',
        content_id: candidate?.sourceId || '',
        generation_run_id: currentRunKey,
        publication_status: effectiveStatus,
        generation_performed: false,
        reservation_created: reservationCreated,
        resumed,
        next_stage: nextStageFor(effectiveStatus)
      });
      console.log(`[Reservation] Reserve-only run complete for ${currentRunKey}.`);
      return;
    }

    // 6. Generation stage — only when this run has not already obtained a response.
    //
    // The check is "does a record exist", NOT "does a review exist". A review only appears
    // after validation, so keying on it would let a resumed run whose content was excluded —
    // or whose validation step crashed — call Gemini a second time for the same run key. The
    // record exists from the moment a response arrives, which is exactly the boundary that
    // makes "one Gemini call per run" true.
    const { year, month } = TimezoneUtil.getJSTYearMonth(date);
    const existingRecord = isDryRun ? null : readRecord(contentRoot, currentRunKey);
    let generationPerformed = false;
    let evaluationRaw: any = undefined;

    if (existingRecord) {
      console.log(`[Resume] Run ${currentRunKey} already has a stored response (quality=${existingRecord.quality.status}). Skipping Gemini generation.`);
      generationRecord = existingRecord;
      // Compare on effectiveStatus so a run that failed mid-generation still advances to
      // generated once its response is found (failed → generated is a valid recovery).
      if (!isDryRun && runState && isRunStateV2(runState) && RUN_STATUS_ORDER[effectiveStatus] < RUN_STATUS_ORDER['generated']) {
        runState = writeRunState(contentRoot, {
          ...runState,
          status: 'generated',
          slug,
          updated_at: new Date().toISOString(),
          failure: undefined
        });
        lastPersistedStatus = 'generated';
      }
    } else if (RUN_STATUS_ORDER[effectiveStatus] <= RUN_STATUS_ORDER['generating']) {
      stage = 'evidence_collection';
      if (!collectionResult) {
        const collector = new EvidenceCollector();
        collectionResult = await collector.collectWithContext(candidate);
      }
      collectionResult = EvidenceCollectionResultSchema.parse(collectionResult);
      let evidences: any = collectionResult.evidences;

      if (evidences.length < 2) {
        throw new Error(`Failed to collect sufficient evidence. Found ${evidences.length}, required 2.`);
      }

      if (!isDryRun && runState && isRunStateV2(runState) && normalizeRunStatus(runState) !== 'generating') {
        runState = writeRunState(contentRoot, {
          ...runState,
          status: 'generating',
          updated_at: new Date().toISOString()
        });
        lastPersistedStatus = 'generating';
      }

      stage = 'evaluation';
      const evaluator = new Evaluator();
      const prepared = prepareCandidateWithIntegrityContext(candidate, collectionResult);
      candidate = prepared.candidate;
      collectionResult = prepared.context;

      if (!isDryRun) {
        // Response-first: one Gemini call, then the verbatim response goes to disk before
        // anything is allowed to parse, judge or reject it. The workflow commits the record
        // immediately after this step returns, so the response survives any later crash.
        // Validation is a SEPARATE invocation (--validate-record) for exactly that reason.
        const result = await generateAndPersist({
          contentRoot,
          runKey: currentRunKey,
          candidate,
          evidences,
          slug,
          promptVersion: seasonConfig.evaluation_prompt_version || '2.1.0',
          evaluator
        });
        generationRecord = result.record;
        evaluationRaw = result.raw;
        console.log(`[Generation] Persisted the response for ${slug} to the generation record ${currentRunKey}.`);
      } else {
        const raw = await evaluator.generateRaw(candidate, evidences);
        evaluationRaw = raw;
        console.log(`Dry run complete. Slug: ${slug}, parsed: ${raw.parsed !== null}`);
      }
      generationPerformed = true;
    } else {
      console.log(`[Resume] Run ${currentRunKey} is at status ${effectiveStatus}; no generation needed.`);
    }

    // 7. Persist post-generation state (publication state + run state).
    let publicationStatus = 'generated';
    if (!isDryRun) {
      const existingPubState: any = readPublicationState(contentRoot, slug);
      if (existingPubState && !generationPerformed) {
        // A failed publication state re-enters the pipeline at the validation stage; it
        // must never ride the "not published" gates straight to deploy unvalidated.
        if (existingPubState.publication_status === 'failed') {
          console.log(`[Resume] Publication state for ${slug} is failed. Re-entering at validation.`);
          publicationStatus = 'generated';
        } else {
          publicationStatus = existingPubState.publication_status;
        }
      } else {
        const pubState = {
          schema_version: '2.0.0' as const,
          data_class: 'production' as const,
          content_id: candidate?.sourceId || existingPubState?.content_id || '',
          slug,
          source_canonical_url: candidate?.canonicalUrl || existingPubState?.source_canonical_url,
          selected_at: selection?.selected_at || existingPubState?.selected_at || new Date().toISOString(),
          generated_at: new Date().toISOString(),
          generation_run_id: currentRunKey,
          run_key: currentRunKey,
          trigger: args.trigger,
          operation: args.operation,
          workflow_run_id: args.workflowRunId || '',
          publication_status: 'generated' as const
        };
        writePublicationState(contentRoot, pubState);
        publicationStatus = 'generated';
      }

      if (runState && isRunStateV2(runState) && generationPerformed) {
        runState = writeRunState(contentRoot, {
          ...runState,
          status: 'generated',
          slug,
          updated_at: new Date().toISOString(),
          failure: undefined
        });
        lastPersistedStatus = 'generated';
      } else if (runState && !isRunStateV2(runState) && generationPerformed) {
        runState = writeRunState(contentRoot, {
          ...(runState as any),
          status: 'generated',
          slug,
          updated_at: new Date().toISOString()
        });
        lastPersistedStatus = 'generated';
      }
    }

    appendGithubOutputs(args.githubOutput, {
      run_key: currentRunKey,
      slug,
      content_id: candidate?.sourceId || '',
      generation_run_id: currentRunKey,
      publication_status: publicationStatus,
      generation_performed: generationPerformed,
      reservation_created: reservationCreated,
      resumed,
      next_stage: nextStageFor(publicationStatus),
      model_used: evaluationRaw?.modelUsed || '',
      thinking_level: evaluationRaw?.thinkingLevel || '',
      input_tokens: evaluationRaw?.tokenUsage?.input_tokens ?? '',
      output_tokens: evaluationRaw?.tokenUsage?.output_tokens ?? '',
      thinking_tokens: evaluationRaw?.tokenUsage?.thinking_tokens ?? '',
      total_tokens: evaluationRaw?.tokenUsage?.total_tokens ?? ''
    });

    // GitHub Actions Step Summary Output
    const summaryFile = process.env.GITHUB_STEP_SUMMARY;
    if (summaryFile && generationPerformed && evaluationRaw) {
      // Safe generation metadata only: never API keys, project names or thinking content.
      const summaryText = `
### JuryPress Generation Summary
- **Run Key**: ${currentRunKey}
- **Slug**: ${slug}
- **Model**: ${evaluationRaw.modelUsed}
- **Thinking Level**: ${evaluationRaw.thinkingLevel}
- **Successful Route**: ${evaluationRaw.successfulRoute}
- **Failover Used**: ${evaluationRaw.failoverUsed}
- **Primary Attempt Count**: ${evaluationRaw.primaryAttemptCount}
- **Fallback Attempt Count**: ${evaluationRaw.fallbackAttemptCount}
- **Total Attempt Count**: ${evaluationRaw.attemptCount}
- **Input Tokens**: ${evaluationRaw.tokenUsage?.input_tokens ?? 'n/a'}
- **Output Tokens**: ${evaluationRaw.tokenUsage?.output_tokens ?? 'n/a'}
- **Thinking Tokens**: ${evaluationRaw.tokenUsage?.thinking_tokens ?? 'n/a'}
- **Total Tokens**: ${evaluationRaw.tokenUsage?.total_tokens ?? 'n/a'}
`;
      fs.appendFileSync(summaryFile, summaryText);
    }

  } catch (e: any) {
    console.error(`Error in stage ${stage}:`, e.message);
    if (!isDryRun) {
      const contentRoot = resolveContentRoot();
      const runKeyToSave = currentRunKey || `unknown-${Date.now()}`;
      const failLogPath = path.join(contentRoot, 'failures', `${runKeyToSave}.json`);
      fs.mkdirSync(path.join(contentRoot, 'failures'), { recursive: true });

      const attemptsCount = e.totalAttempts !== undefined ? e.totalAttempts : (stage === 'evaluation' ? 3 : 1);
      const errorMsg = e.lastErrorCategory || e.message;

      const failure = {
        data_class: "production",
        run_key: runKeyToSave,
        status: "failed",
        stage: stage,
        candidate: candidateForFailure,
        attempts: attemptsCount,
        error_code: e.name || "UNKNOWN_ERROR",
        error_summary: errorMsg,
        failed_at: new Date().toISOString()
      };
      fs.writeFileSync(failLogPath, JSON.stringify(FailureSchema.parse(failure), null, 2));

      try {
        if (runState && isRunStateV2(runState)) {
          const previousStatus: RunStatusV2 = lastPersistedStatus && lastPersistedStatus !== 'failed'
            ? lastPersistedStatus
            : (runState.failure?.previous_status ?? 'reserved');
          writeRunState(contentRoot, {
            ...runState,
            status: 'failed',
            updated_at: new Date().toISOString(),
            failure: {
              stage,
              retryable: !(String(e.message || '')).includes('[Integrity Violation]'),
              previous_status: previousStatus,
              error_category: e.lastErrorCategory || e.name || 'UNKNOWN_ERROR',
              failed_at: new Date().toISOString()
            }
          });
        } else if (currentRunKey && runState) {
          writeRunState(contentRoot, {
            ...(runState as any),
            status: 'failed',
            updated_at: new Date().toISOString()
          });
        } else {
          // Failure before any reservation existed (e.g. selection failed, or no run key
          // was resolved yet): record a legacy-shaped failed run state directly — the
          // synthetic "unknown-*" keys are outside the strict run-key format on purpose.
          const failedState = {
            schema_version: '1.0.0',
            data_class: 'production',
            status: 'failed',
            run_key: runKeyToSave,
            updated_at: new Date().toISOString(),
            candidate: candidateForFailure,
            selection,
            collection_result: collectionResult
          };
          const runLogPath = path.join(contentRoot, 'runs', `${runKeyToSave.replace(/[^a-zA-Z0-9_-]/g, '-')}.json`);
          fs.mkdirSync(path.dirname(runLogPath), { recursive: true });
          fs.writeFileSync(runLogPath, JSON.stringify(failedState, null, 2));
        }
      } catch (stateError: any) {
        console.error(`[State Machine] Failed to persist failed run state: ${stateError.message}`);
      }
    }
    process.exit(1);
  }
}

main();
