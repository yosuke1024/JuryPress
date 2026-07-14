import 'dotenv/config';
import { Selector } from '../src/lib/selection/selector';
import { EvidenceCollector } from '../src/lib/evidence/collector';
import { Evaluator } from '../src/lib/evaluation/evaluator';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';

import { TimezoneUtil } from '../src/lib/timezone';
import { EvaluationOutputSchema } from '../src/schemas/evaluation';

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
  const evaluationFinal = evaluator.recalculateScores(evaluationRaw.output);
  console.log("Score Recalculation: SUCCESS");
  
  console.log(`SMOKE TEST RESULTS:
- Model: ${evaluationRaw.modelUsed}
- API Call Count: 1
- Attempt Count: ${evaluationRaw.attemptCount}
- Input Tokens: ${evaluationRaw.usage?.input_tokens}
- Output Tokens: ${evaluationRaw.usage?.output_tokens}
- Schema Validation Result: SUCCESS`);
}

import { resolveContentRoot, resolveDataMode } from '../src/lib/content-root';
import { SelectionSchema, FailureSchema, RunStateSchema, PublicationStateSchema } from '../src/schemas/selection';

async function main() {
  const args = process.argv.slice(2);
  const updateStatusIndex = args.indexOf('--update-status');
  if (updateStatusIndex !== -1 && updateStatusIndex + 1 < args.length) {
    const targetStatus = args[updateStatusIndex + 1];
    const slugArgIndex = args.indexOf('--slug');
    let targetSlug = '';
    if (slugArgIndex !== -1 && slugArgIndex + 1 < args.length) {
      targetSlug = args[slugArgIndex + 1];
    }
    
    const contentRoot = resolveContentRoot();
    const mode = resolveDataMode();
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
    
    const pubStatePath = path.join(statusPubStateDir, `${targetSlug}.json`);
    if (!fs.existsSync(pubStatePath)) {
      console.error(`Error: publication state file not found for slug: ${targetSlug}`);
      process.exit(1);
    }
    
    const rawState = JSON.parse(fs.readFileSync(pubStatePath, 'utf8'));
    const pubState = PublicationStateSchema.parse(rawState);
    
    if (!['generated', 'validated', 'committed', 'published', 'failed'].includes(targetStatus)) {
      console.error(`Error: invalid status for --update-status: ${targetStatus}`);
      process.exit(1);
    }
    
    pubState.publication_status = targetStatus as any;
    if (targetStatus === 'published') {
      pubState.published_at = new Date().toISOString();
    }
    
    fs.writeFileSync(pubStatePath, JSON.stringify(PublicationStateSchema.parse(pubState), null, 2));
    console.log(`[State Machine] Updated publication_status of ${targetSlug} to: ${targetStatus}`);
    
    if (targetStatus === 'published' && pubState.generation_run_id) {
      const runsDir = path.join(contentRoot, 'runs');
      const runLogPath = path.join(runsDir, `${pubState.generation_run_id}.json`);
      if (fs.existsSync(runLogPath)) {
        const rawRun = JSON.parse(fs.readFileSync(runLogPath, 'utf8'));
        const runLog = RunStateSchema.parse(rawRun);
        runLog.status = 'published';
        runLog.published_at = pubState.published_at;
        fs.writeFileSync(runLogPath, JSON.stringify(RunStateSchema.parse(runLog), null, 2));
        console.log(`[State Machine] Updated run status to published for run: ${pubState.generation_run_id}`);
      }
    }

    const githubOutputIndex = args.indexOf('--github-output');
    if (githubOutputIndex !== -1 && githubOutputIndex + 1 < args.length) {
      const outputFile = args[githubOutputIndex + 1];
      fs.writeFileSync(outputFile, `slug=${targetSlug}\n`);
      fs.appendFileSync(outputFile, `content_id=${pubState.content_id}\n`);
      fs.appendFileSync(outputFile, `generation_run_id=${pubState.generation_run_id || ''}\n`);
      fs.appendFileSync(outputFile, `publication_status=${targetStatus}\n`);
      fs.appendFileSync(outputFile, `generation_performed=false\n`);
      console.log(`[State Machine] Updated variables written to ${outputFile}`);
    }

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

  console.log(`Starting run for date: ${date.toISOString()} (Dry Run: ${isDryRun})`);

  let currentRunKey = '';
  let candidateForFailure: any = undefined;
  let stage = 'started';
  let selection: any = undefined;
  let candidate: any = undefined;
  let runLog: any = undefined;

  try {
    const contentRoot = resolveContentRoot();
    const seasonConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8'));
    currentRunKey = TimezoneUtil.getRunKey(seasonConfig.season, date);

    // 1. Scan for any pending/incomplete publication states
    let pendingSlug = '';
    let pendingState: any = undefined;
    const pendingPubStateDir = path.join(contentRoot, 'publication-state');
    if (fs.existsSync(pendingPubStateDir)) {
      const files = fs.readdirSync(pendingPubStateDir).filter(f => f.endsWith('.json'));
      const candidates: any[] = [];
      for (const file of files) {
        const fullPath = path.join(pendingPubStateDir, file);
        try {
          const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          const state = PublicationStateSchema.parse(raw);
          if (['committed', 'validated', 'generated', 'selected'].includes(state.publication_status)) {
            const { year, month } = TimezoneUtil.getJSTYearMonth(date);
            const reviewPath = path.join(contentRoot, 'reviews', year, month, state.slug, 'review.json');
            if (fs.existsSync(reviewPath)) {
              candidates.push(state);
            }
          }
        } catch (e) {}
      }

      if (candidates.length > 0) {
        const statusPriority: Record<string, number> = {
          'committed': 3,
          'validated': 2,
          'generated': 1,
          'selected': 1
        };
        candidates.sort((a, b) => {
          const priA = statusPriority[a.publication_status] || 0;
          const priB = statusPriority[b.publication_status] || 0;
          if (priA !== priB) {
            return priB - priA; // 優先度高い（committed）順
          }
          const timeA = new Date(a.generated_at || a.selected_at).getTime();
          const timeB = new Date(b.generated_at || b.selected_at).getTime();
          return timeA - timeB; // 古い（過去の）順
        });
        pendingState = candidates[0];
        pendingSlug = pendingState.slug;
      }
    }

    if (pendingState) {
      console.log(`[Idempotency] Found pending publication state: ${pendingSlug} (${pendingState.publication_status}). Reusing existing review.`);
      
      const githubOutputIndex = args.indexOf('--github-output');
      if (githubOutputIndex !== -1 && githubOutputIndex + 1 < args.length) {
        const outputFile = args[githubOutputIndex + 1];
        fs.writeFileSync(outputFile, `slug=${pendingSlug}\n`);
        fs.appendFileSync(outputFile, `content_id=${pendingState.content_id}\n`);
        fs.appendFileSync(outputFile, `generation_run_id=${pendingState.generation_run_id || ''}\n`);
        fs.appendFileSync(outputFile, `publication_status=${pendingState.publication_status}\n`);
        fs.appendFileSync(outputFile, `generation_performed=false\n`);
        console.log(`[Idempotency] Output variables written to ${outputFile}`);
      }
      return;
    }

    const runsDir = path.join(contentRoot, 'runs');
    const runLogPath = path.join(runsDir, `${currentRunKey}.json`);
    const resetRun = process.env.RESET_RUN === 'true';

    // State machine check for published
    if (fs.existsSync(runLogPath) && !resetRun) {
      const rawRun = JSON.parse(fs.readFileSync(runLogPath, 'utf8'));
      runLog = RunStateSchema.parse(rawRun);
      if (runLog.status === 'published') {
        console.log(`Run ${currentRunKey} is already published. Exiting cleanly.`);
        
        let slug = runLog.slug || '';
        let contentId = runLog.selection?.source_id || '';
        if (slug && !contentId) {
          const pubStatePath = path.join(contentRoot, 'publication-state', `${slug}.json`);
          if (fs.existsSync(pubStatePath)) {
            try {
              const state = JSON.parse(fs.readFileSync(pubStatePath, 'utf8'));
              contentId = state.content_id || '';
            } catch (e) {}
          }
        }

        const githubOutputIndex = args.indexOf('--github-output');
        if (githubOutputIndex !== -1 && githubOutputIndex + 1 < args.length) {
          const outputFile = args[githubOutputIndex + 1];
          fs.writeFileSync(outputFile, `slug=${slug}\n`);
          fs.appendFileSync(outputFile, `content_id=${contentId}\n`);
          fs.appendFileSync(outputFile, `generation_run_id=${currentRunKey}\n`);
          fs.appendFileSync(outputFile, `publication_status=published\n`);
          fs.appendFileSync(outputFile, `generation_performed=false\n`);
          console.log(`[Idempotency] Output variables written to ${outputFile}`);
        }
        return;
      }
    }

    let evidences: any = undefined;

    // Idempotency: Check if the selection was already processed and has a valid review
    const { year, month } = TimezoneUtil.getJSTYearMonth(date);
    
    // Select candidate
    if (runLog?.candidate) {
      console.log(`Reusing candidate from previous failed run: ${runLog.candidate.name}`);
      candidate = {
        name: runLog.candidate.name,
        canonicalUrl: runLog.candidate.canonical_url,
        sourceUrl: runLog.selection?.source_url || '',
        source: runLog.selection?.source || '',
        sourceId: runLog.selection?.source_id || '',
        sourceRank: runLog.selection?.source_rank || 1,
        popularityValue: runLog.selection?.popularity_value || 0,
        popularityUnit: runLog.selection?.popularity_unit || '',
        collectedAt: runLog.selection?.selected_at || new Date().toISOString(),
        metadata: runLog.selection?.candidate_metadata || {}
      };
      selection = runLog.selection;
    } else {
      const selector = new Selector();
      stage = 'selection';
      const result = await selector.selectForDate(date);
      selection = result.selection;
      candidate = result.candidate;
      evidences = result.evidences;
      
      // Inject data_class
      selection.data_class = 'production';

      if (!isDryRun) {
        fs.mkdirSync(runsDir, { recursive: true });
        const initialRunState = { 
          schema_version: '1.0.0',
          data_class: 'production',
          status: 'selected', 
          run_key: currentRunKey, 
          updated_at: new Date().toISOString(),
          candidate: { name: candidate.name, canonical_url: candidate.canonicalUrl },
          selection
        };
        fs.writeFileSync(runLogPath, JSON.stringify(RunStateSchema.parse(initialRunState), null, 2));
      }
    }
    candidateForFailure = { name: candidate.name, canonical_url: candidate.canonicalUrl };
    
    // Clean up slug
    const hash = crypto.createHash('md5').update(candidate.sourceId || '').digest('hex').substring(0, 6);
    const cleanName = candidate.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
    const slug = `${cleanName}-${hash}`;
    const outDir = path.join(contentRoot, 'reviews', year, month, slug);
    const pubStateDir = path.join(contentRoot, 'publication-state');
    const pubStatePath = path.join(pubStateDir, `${slug}.json`);

    // Verify canonical URL duplicate prevention (Idempotency check)
    // Check if the canonical URL or content ID has already been published
    if (!resetRun) {
      if (fs.existsSync(pubStatePath)) {
        const rawPubState = JSON.parse(fs.readFileSync(pubStatePath, 'utf8'));
        const pubState = PublicationStateSchema.parse(rawPubState);
        if (pubState.publication_status === 'published' || pubState.publication_status === 'validated' || pubState.publication_status === 'committed') {
          console.log(`Content ${slug} is already generated or published (${pubState.publication_status}). Skipping evaluation.`);
          
          // Re-trigger published in run state
          if (!isDryRun) {
            const finalRunState = { 
              schema_version: '1.0.0',
              data_class: 'production',
              status: 'published', 
              run_key: currentRunKey, 
              published_at: TimezoneUtil.getJSTString(date), 
              slug 
            };
            fs.writeFileSync(runLogPath, JSON.stringify(RunStateSchema.parse(finalRunState), null, 2));
          }
          return;
        }
      }
    }

    stage = 'evidence_collection';
    const collector = new EvidenceCollector();
    if (!evidences) {
      evidences = await collector.collect(candidate);
    }
    
    if (evidences.length < 2) {
      throw new Error(`Failed to collect sufficient evidence. Found ${evidences.length}, required 2.`);
    }

    stage = 'evaluation';
    const evaluator = new Evaluator();
    const evaluationRaw = await evaluator.evaluate(candidate, evidences);
    const evaluationFinal = evaluator.recalculateScores(evaluationRaw.output);
    
    const rawCount = collector.evidenceUsage.raw_character_count;
    const sanitizedCount = collector.evidenceUsage.sanitized_character_count;
    const sentCount = evaluationRaw.characters_sent_to_model || 0;
    const ratio = rawCount > 0 ? (1 - sentCount / rawCount) : null;

    if (!isDryRun) {
      // 1. Write evidence bundle (object structure)
      const evidenceBundle = {
        data_class: 'production',
        evidences: evidences
      };
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify(evidenceBundle, null, 2));
      fs.writeFileSync(path.join(outDir, 'selection.json'), JSON.stringify(selection, null, 2));
      
      const review = {
        schema_version: "2.0.0",
        data_class: "production",
        content_license: "all-rights-reserved",
        copyright_holder: "Yosuke Suzuki",
        season: 2,
        review_scope: "open-source-software-product",
        slug: slug,
        published_at: TimezoneUtil.getJSTString(date),
        model: evaluationRaw.modelUsed || seasonConfig.model,
        attempt_count: evaluationRaw.attemptCount || 1,
        generation_route: {
          successful_route: evaluationRaw.successfulRoute,
          failover_used: evaluationRaw.failoverUsed,
          primary_attempts: evaluationRaw.primaryAttemptCount,
          fallback_attempts: evaluationRaw.fallbackAttemptCount,
          total_attempts: evaluationRaw.attemptCount
        },
        prompt_version: "2.0.0",
        rubric_id: "open-source-product",
        rubric_version: "2.0.0",
        selection_policy_id: "open-source-product",
        selection_policy_version: "2.0.0",
        human_reviewed: false,
        relationship: "independent" as const,
        ranking_eligible: evaluationFinal.recalculated_jury_score !== null,
        ranking_exclusion_reason: evaluationFinal.recalculated_jury_score === null ? "evidence-limited-project" : undefined,
        evaluation_status: evaluationFinal.recalculated_jury_score === null ? 'evidence_limited' as const : 'complete' as const,
        assessment_coverage: evaluationFinal.recalculated_jury_score === null ? 0.8 : 1.0,
        jury_score: evaluationFinal.recalculated_jury_score,
        judge_score_range: evaluationFinal.judge_score_range,
        provenance: {
          no_fixture_provenance: true,
          api_metadata_verified: evidences ? evidences.some((e: any) => e.type === 'api_metadata') : false,
          recalculated_by_code: true,
          verified_at: new Date().toISOString()
        },
        evaluation: evaluationFinal,
        usage: evaluationRaw.usage || {
          input_tokens: 0,
          output_tokens: 0,
          estimated_cost: 0.0
        },
        evidence_usage: {
          raw_character_count: rawCount,
          sanitized_character_count: sanitizedCount,
          characters_sent_to_model: sentCount,
          budget_limit: 24000,
          reduction_ratio: ratio
        }
      };

      const { ReviewSchemaV2 } = await import('../src/schemas/review');
      fs.writeFileSync(path.join(outDir, 'review.json'), JSON.stringify(ReviewSchemaV2.parse(review), null, 2));
      
      // Update Publication State to 'generated'
      fs.mkdirSync(pubStateDir, { recursive: true });
      const pubState = {
        schema_version: '1.0.0',
        data_class: 'production',
        content_id: candidate.sourceId,
        slug: slug,
        source_canonical_url: candidate.canonicalUrl,
        selected_at: selection.selected_at,
        generated_at: new Date().toISOString(),
        generation_run_id: currentRunKey,
        publication_status: 'generated'
      };
      fs.writeFileSync(pubStatePath, JSON.stringify(PublicationStateSchema.parse(pubState), null, 2));

      // Update run status to generated, then we update to published in deploy steps
      const finalRunState = { 
        schema_version: '1.0.0',
        data_class: 'production',
        status: 'generated', 
        run_key: currentRunKey, 
        updated_at: new Date().toISOString(), 
        slug 
      };
      fs.writeFileSync(runLogPath, JSON.stringify(RunStateSchema.parse(finalRunState), null, 2));
      
      const githubOutputIndex = args.indexOf('--github-output');
      if (githubOutputIndex !== -1 && githubOutputIndex + 1 < args.length) {
        const outputFile = args[githubOutputIndex + 1];
        fs.writeFileSync(outputFile, `slug=${slug}\n`);
        fs.appendFileSync(outputFile, `content_id=${candidate.sourceId}\n`);
        fs.appendFileSync(outputFile, `generation_run_id=${currentRunKey}\n`);
        fs.appendFileSync(outputFile, `publication_status=generated\n`);
        fs.appendFileSync(outputFile, `generation_performed=true\n`);
        console.log(`[State Machine] Output variables written to ${outputFile}`);
      }

      console.log(`Successfully generated and saved review to ${slug}`);

      // GitHub Actions Step Summary Output
      const summaryFile = process.env.GITHUB_STEP_SUMMARY;
      if (summaryFile) {
        const summaryText = `
### JuryPress Generation Summary
- **Model**: ${review.model}
- **Successful Route**: ${evaluationRaw.successfulRoute}
- **Primary Attempt Count**: ${evaluationRaw.primaryAttemptCount}
- **Fallback Attempt Count**: ${evaluationRaw.fallbackAttemptCount}
- **Total Attempt Count**: ${evaluationRaw.attemptCount}
- **Failover Used**: ${evaluationRaw.failoverUsed}
- **Input Tokens**: ${evaluationRaw.usage?.input_tokens}
- **Output Tokens**: ${evaluationRaw.usage?.output_tokens}
`;
        fs.appendFileSync(summaryFile, summaryText);
      }
    } else {
      console.log(`Dry run complete. Slug: ${slug}`);
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
      
      const runLogPath = path.join(contentRoot, 'runs', `${runKeyToSave}.json`);
      fs.mkdirSync(path.dirname(runLogPath), { recursive: true });
      const failedRunState = { 
        schema_version: '1.0.0',
        data_class: 'production',
        status: 'failed', 
        run_key: runKeyToSave, 
        updated_at: new Date().toISOString(),
        candidate: candidate || runLog?.candidate,
        selection: selection || runLog?.selection
      };
      fs.writeFileSync(runLogPath, JSON.stringify(RunStateSchema.parse(failedRunState), null, 2));
    }
    process.exit(1);
  }
}

main();
