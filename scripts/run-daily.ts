import 'dotenv/config';
import { Selector } from '../src/lib/selection/selector';
import { EvidenceCollector } from '../src/lib/evidence/collector';
import { Evaluator } from '../src/lib/evaluation/evaluator';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';

import { TimezoneUtil } from '../src/lib/timezone';

async function main() {
  const isDryRun = process.env.DRY_RUN === 'true';
  const targetDateStr = process.env.TARGET_DATE;
  const date = targetDateStr ? new Date(targetDateStr) : new Date();

  console.log(`Starting run for date: ${date.toISOString()} (JST Key: ${TimezoneUtil.getJSTDateKey(date)}) (Dry Run: ${isDryRun})`);

  let currentRunKey = '';
  let candidateForFailure: any = undefined;
  let stage = 'started';

  try {
    const seasonConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8'));
    currentRunKey = TimezoneUtil.getRunKey(seasonConfig.season, date);

    // Check state machine for existing published run FIRST
    const runLogPath = path.join(process.cwd(), 'data', 'runs', `${currentRunKey}.json`);
    if (fs.existsSync(runLogPath)) {
      const runLog = JSON.parse(fs.readFileSync(runLogPath, 'utf8'));
      if (runLog.status === 'published') {
        console.log(`Run ${currentRunKey} is already published. Exiting cleanly.`);
        return;
      }
    }

    const selector = new Selector();
    stage = 'selection';
    const { selection, candidate } = await selector.selectForDate(date);
    candidateForFailure = { name: candidate.name, canonical_url: candidate.canonicalUrl };
    
    console.log(`Selected candidate: ${candidate.name} (${candidate.canonicalUrl}) from ${selection.source}`);

    // Update state to selected
    if (!isDryRun) {
      fs.mkdirSync(path.dirname(runLogPath), { recursive: true });
      fs.writeFileSync(runLogPath, JSON.stringify({ status: 'selected', run_key: currentRunKey, updated_at: new Date().toISOString() }, null, 2));
    }

    stage = 'evidence_collection';
    const collector = new EvidenceCollector();
    const evidences = await collector.collect(candidate);
    
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
    const hash = crypto.createHash('md5').update(candidate.sourceId).digest('hex').substring(0, 6);
    const cleanName = candidate.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
    const slug = `${cleanName}-${hash}`;
    
    const { year, month } = TimezoneUtil.getJSTYearMonth(date);

    const outDir = path.join(process.cwd(), 'data', 'reviews', year, month, slug);
    
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
        usage: evaluationRaw.usage
      };
      
      fs.writeFileSync(path.join(outDir, 'review.json'), JSON.stringify(review, null, 2));
      
      fs.writeFileSync(runLogPath, JSON.stringify({ status: 'published', run_key: currentRunKey, published_at: TimezoneUtil.getJSTString(date), slug }, null, 2));
      
      console.log(`Successfully saved review to ${outDir}`);
    } else {
      console.log(`Dry run complete. Slug: ${slug}`);
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
      fs.writeFileSync(runLogPath, JSON.stringify({ status: 'failed', run_key: runKeyToSave, updated_at: new Date().toISOString() }, null, 2));
      
      console.log(`Failure saved to ${failLogPath}`);
    }
    process.exit(1);
  }
}

main();
