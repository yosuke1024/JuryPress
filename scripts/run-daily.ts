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

async function main() {
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

  console.log(`Starting run for date: ${date.toISOString()} (JST Key: ${TimezoneUtil.getJSTDateKey(date)}) (Dry Run: ${isDryRun})`);

  let currentRunKey = '';
  let candidateForFailure: any = undefined;
  let stage = 'started';
  let selection: any = undefined;
  let candidate: any = undefined;
  let runLog: any = undefined;

  try {
    const seasonConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8'));
    currentRunKey = TimezoneUtil.getRunKey(seasonConfig.season, date);

    // Check state machine for existing published run FIRST
    const runLogPath = path.join(process.cwd(), 'data', 'runs', `${currentRunKey}.json`);
    const resetRun = process.env.RESET_RUN === 'true';
    if (fs.existsSync(runLogPath) && !resetRun) {
      runLog = JSON.parse(fs.readFileSync(runLogPath, 'utf8'));
      if (runLog.status === 'published') {
        console.log(`Run ${currentRunKey} is already published. Exiting cleanly.`);
        return;
      }
    }

    let selection: any = undefined;
    let candidate: any = undefined;
    let evidences: any = undefined;

    if (runLog?.candidate) {
      console.log(`Reusing candidate from previous failed run: ${runLog.candidate.name} (${runLog.candidate.canonical_url})`);
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
      
      // Update state to selected
      if (!isDryRun) {
        fs.mkdirSync(path.dirname(runLogPath), { recursive: true });
        fs.writeFileSync(runLogPath, JSON.stringify({ 
          status: 'selected', 
          run_key: currentRunKey, 
          updated_at: new Date().toISOString(),
          candidate,
          selection
        }, null, 2));
      }
    }
    candidateForFailure = { name: candidate.name, canonical_url: candidate.canonicalUrl };
    console.log(`Selected candidate: ${candidate.name} (${candidate.canonicalUrl}) from ${selection.source}`);

    stage = 'evidence_collection';
    if (!evidences) {
      console.log("Fetching evidence for reused candidate...");
      const collector = new EvidenceCollector();
      evidences = await collector.collect(candidate);
    }
    
    if (evidences.length < 2) {
      throw new Error(`Failed to collect sufficient evidence. Found ${evidences.length}, required 2.`);
    }
    console.log(`Collected ${evidences.length} pieces of evidence.`);

    stage = 'evaluation';
    const evaluator = new Evaluator();
    const evaluationRaw = await evaluator.evaluate(candidate, evidences);
    const evaluationFinal = evaluator.recalculateScores(evaluationRaw.output);
    
    console.log(`Evaluation complete. Jury Score: ${evaluationFinal.recalculated_jury_score.toFixed(1)}`);

    // Prepare slug (product name + stable hash of source id)
    const hash = crypto.createHash('md5').update(candidate.sourceId || '').digest('hex').substring(0, 6);
    const cleanName = candidate.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
    const slug = `${cleanName}-${hash}`;
    
    const { year, month } = TimezoneUtil.getJSTYearMonth(date);

    const outDir = path.join(process.cwd(), 'data', 'reviews', year, month, slug);
    
    const rawCount = collector.evidenceUsage.raw_character_count;
    const sanitizedCount = collector.evidenceUsage.sanitized_character_count;
    const sentCount = evaluationRaw.characters_sent_to_model || 0;
    const ratio = rawCount > 0 ? (1 - sentCount / rawCount) : null;

    if (!isDryRun) {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'selection.json'), JSON.stringify(selection, null, 2));
      fs.writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify(evidences, null, 2));
      
      const seasonConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8'));

      const review = {
        schema_version: "1.0.0",
        season: seasonConfig.season,
        slug: slug,
        published_at: TimezoneUtil.getJSTString(date), // JST consistency
        model: evaluationRaw.modelUsed || seasonConfig.model,
        attempt_count: evaluationRaw.attemptCount || 1,
        prompt_version: seasonConfig.evaluation_prompt_version,
        rubric_version: seasonConfig.rubric.source_commit,
        human_reviewed: false,
        jury_score: evaluationFinal.recalculated_jury_score,
        judge_score_range: evaluationFinal.judge_score_range,
        evaluation: evaluationFinal,
        usage: evaluationRaw.usage,
        evidence_usage: {
          raw_character_count: rawCount,
          sanitized_character_count: sanitizedCount,
          characters_sent_to_model: sentCount,
          budget_limit: 24000,
          reduction_ratio: ratio
        }
      };
      
      fs.writeFileSync(path.join(outDir, 'review.json'), JSON.stringify(review, null, 2));
      
      fs.writeFileSync(runLogPath, JSON.stringify({ status: 'published', run_key: currentRunKey, published_at: TimezoneUtil.getJSTString(date), slug }, null, 2));
      
      console.log(`Successfully saved review to ${outDir}`);
    } else {
      console.log(`Dry run complete. Slug: ${slug}`);
      const stepSummaryFile = process.env.GITHUB_STEP_SUMMARY;
      if (stepSummaryFile) {
        const estCost = evaluationRaw.usage ? ((evaluationRaw.usage.input_tokens || 0) * 0.075 / 1000000 + (evaluationRaw.usage.output_tokens || 0) * 0.3 / 1000000) : 0;
        const markdown = `
### JuryPress Dry Run Summary
- **Candidate**: ${candidate.name}
- **Source**: ${selection.source}
- **Evidence URLs**: ${evidences.length}
- **Raw Characters**: ${rawCount}
- **Characters Sent to Model**: ${sentCount}
- **Reduction Ratio**: ${ratio !== null ? (ratio * 100).toFixed(1) + '%' : 'N/A'}
- **Jury Score**: ${evaluationFinal.recalculated_jury_score.toFixed(1)}
- **Judge Range**: ${evaluationFinal.judge_score_range.min.toFixed(1)} – ${evaluationFinal.judge_score_range.max.toFixed(1)}
- **Model**: ${evaluationRaw.modelUsed}
- **Attempt Count**: ${evaluationRaw.attemptCount}
- **Token Usage**: Input: ${evaluationRaw.usage?.input_tokens}, Output: ${evaluationRaw.usage?.output_tokens}
- **Estimated Cost**: $${estCost.toFixed(6)}
`;
        fs.appendFileSync(stepSummaryFile, markdown);
      }
    }

  } catch (e: any) {
    console.error(`Error in stage ${stage}:`, e.message);
    if (!isDryRun) {
      const runKeyToSave = currentRunKey || `unknown-${Date.now()}`;
      const failLogPath = path.join(process.cwd(), 'data', 'failures', `${runKeyToSave}.json`);
      fs.mkdirSync(path.join(process.cwd(), 'data', 'failures'), { recursive: true });
      const failure = {
        run_key: runKeyToSave,
        status: "failed",
        stage: stage,
        candidate: candidateForFailure,
        attempts: stage === 'evaluation' ? 3 : 1,
        error_code: e.name || "UNKNOWN_ERROR",
        error_summary: e.message,
        failed_at: new Date().toISOString()
      };
      fs.writeFileSync(failLogPath, JSON.stringify(failure, null, 2));
      
      // Update state machine
      const runLogPath = path.join(process.cwd(), 'data', 'runs', `${runKeyToSave}.json`);
      fs.mkdirSync(path.dirname(runLogPath), { recursive: true });
      fs.writeFileSync(runLogPath, JSON.stringify({ 
        status: 'failed', 
        run_key: runKeyToSave, 
        updated_at: new Date().toISOString(),
        candidate: candidate || runLog?.candidate,
        selection: selection || runLog?.selection
      }, null, 2));
      
      console.log(`Failure saved to ${failLogPath}`);
    }
    process.exit(1);
  }
}

main();
