import 'dotenv/config';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import { resolveContentRoot, resolveDataMode } from '../src/lib/content-root';
import { EvidenceCollector } from '../src/lib/evidence/collector';
import { Evaluator } from '../src/lib/evaluation/evaluator';
import { TimezoneUtil } from '../src/lib/timezone';
import { ReviewSchemaV2 } from '../src/schemas/review';
import { SelectionSchema, PublicationStateSchema, RunStateSchema, FailureSchema } from '../src/schemas/selection';
import { EvidenceBundleSchema } from '../src/schemas/evidence';

// Set Max attempts per item
process.env.GEMINI_MAX_ATTEMPTS = '2';

// 5 items definition in manifest
interface ManifestItem {
  order: number;
  name: string;
  source_url: string;
  additional_evidence_urls?: string[];
  relationship: 'independent' | 'related-party';
  ranking_eligible: boolean;
  ranking_exclusion_reason?: string;
}

interface Manifest {
  schema_version: string;
  batch_id: string;
  items: ManifestItem[];
}

function copyDirRecursive(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function deleteDirRecursive(dirPath: string) {
  if (fs.existsSync(dirPath)) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        deleteDirRecursive(fullPath);
      } else {
        fs.unlinkSync(fullPath);
      }
    }
    fs.rmdirSync(dirPath);
  }
}

// Check for forbidden strings
function containsForbiddenStrings(filePath: string): boolean {
  const content = fs.readFileSync(filePath, 'utf8');
  const forbidden = ['DEMO FIXTURE', 'Fixture Product', 'example.com', 'localhost:4321', 'yosuke1024.github.io'];
  for (const f of forbidden) {
    if (content.includes(f)) {
      console.error(`[Validation] Banned string "${f}" found in file: ${filePath}`);
      return true;
    }
  }
  return false;
}

// Generate disclosure text
function getDisclosureText(item: ManifestItem): string | undefined {
  if (item.relationship !== 'related-party') {
    return undefined;
  }
  const common = "Disclosure: This is a related-party project. It was evaluated using the same jury, rubric, evidence rules, and scoring process as every other verdict, but it is excluded from all rankings and comparative aggregates.";
  if (item.name === 'JuryPress') {
    return `${common} JuryPress is operated by the creator of this publication. No special scoring or evaluation prompt was used.`;
  }
  if (item.name === 'Judgie-AI') {
    return `${common} Judgie-AI is a related project by the creator of JuryPress. No special scoring or evaluation prompt was used.`;
  }
  return common;
}

async function runBootstrap(manifestPath: string, contentRoot: string) {
  console.log(`[Bootstrap] Starting content generation...`);
  console.log(`[Bootstrap] Output Staging Root: ${contentRoot}`);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.items.length !== 5) {
    throw new Error(`Manifest items count must be exactly 5. Found: ${manifest.items.length}`);
  }

  const orders = manifest.items.map(i => i.order).sort();
  if (JSON.stringify(orders) !== JSON.stringify([1, 2, 3, 4, 5])) {
    throw new Error(`Manifest orders must be unique and from 1 to 5.`);
  }

  const urls = manifest.items.map(i => i.source_url);
  if (new Set(urls).size !== 5) {
    throw new Error(`Duplicate source URLs found in manifest.`);
  }

  // Ensure output directories exist
  const reviewsDir = path.join(contentRoot, 'reviews');
  const runsDir = path.join(contentRoot, 'runs');
  const failuresDir = path.join(contentRoot, 'failures');
  const pubStateDir = path.join(contentRoot, 'publication-state');
  const evidenceDir = path.join(contentRoot, 'evidence');

  fs.mkdirSync(reviewsDir, { recursive: true });
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(failuresDir, { recursive: true });
  fs.mkdirSync(pubStateDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });

  const date = new Date();
  const seasonConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8'));
  const currentRunKey = TimezoneUtil.getRunKey(seasonConfig.season, date);

  let totalGeminiCalls = 0;
  const maxGeminiCalls = 10;

  for (const item of manifest.items) {
    console.log(`\n--------------------------------------------`);
    console.log(`[Bootstrap] Processing Item ${item.order}/5: ${item.name}`);

    // Create Candidate object
    const hash = crypto.createHash('md5').update(item.source_url).digest('hex').substring(0, 6);
    const cleanName = item.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
    const slug = `${cleanName}-${hash}`;

    const sourceId = item.source_url.split('/').slice(-2).join('/');
    const candidate = {
      source: item.source_url.includes('huggingface.co') ? 'Hugging Face' : 'GitHub',
      sourceId: sourceId,
      name: item.name,
      canonicalUrl: item.source_url,
      sourceUrl: item.source_url,
      sourceRank: item.order,
      popularityValue: 100,
      popularityUnit: 'stars',
      collectedAt: new Date().toISOString(),
      metadata: {},
      additional_evidence_urls: item.additional_evidence_urls || []
    };

    const selection = {
      schema_version: '1.0.0',
      data_class: 'production',
      run_key: currentRunKey,
      source: candidate.source.toLowerCase() === 'hugging face' ? 'hugging-face' : 'github',
      source_rank: null,
      selection_rule: 'bootstrap',
      selected_at: new Date().toISOString(),
      canonical_url: candidate.canonicalUrl,
      source_url: candidate.sourceUrl,
      algorithm_version: '1.0.0',
      human_selected: false,
      candidate_name: candidate.name,
      source_id: candidate.sourceId,
      candidate_metadata: {},
      selection_mode: 'initial-bootstrap',
      selected_by: 'operator',
      source_metrics: [
        {
          platform: candidate.source.toLowerCase() === 'hugging face' ? 'hugging-face' : 'github',
          metric: candidate.source.toLowerCase() === 'hugging face' ? 'likes' : 'stars',
          value: 150,
          source_url: candidate.canonicalUrl,
          retrieved_at: new Date().toISOString()
        }
      ]
    };

    // Save Selection state
    const itemRunKey = `${currentRunKey}-${slug}`;
    const runLogPath = path.join(runsDir, `${itemRunKey}.json`);
    const initialRunState = {
      schema_version: '1.0.0',
      data_class: 'production',
      status: 'selected',
      run_key: itemRunKey,
      updated_at: new Date().toISOString(),
      candidate: { name: candidate.name, canonical_url: candidate.canonicalUrl },
      selection
    };
    fs.writeFileSync(runLogPath, JSON.stringify(RunStateSchema.parse(initialRunState), null, 2));

    try {
      // 1. Evidence Collection
      console.log(`[Bootstrap] Collecting Evidence for ${item.name}...`);
      const collector = new EvidenceCollector();
      const evidences = await collector.collect(candidate);
      if (evidences.length < 2) {
        throw new Error(`Insufficient evidence. Found ${evidences.length}, required 2.`);
      }

      // 2. Evaluation via Evaluator
      console.log(`[Bootstrap] Running Evaluator via Gemini API...`);
      if (totalGeminiCalls >= maxGeminiCalls) {
        throw new Error(`Total Gemini API call limit reached (${maxGeminiCalls}). Fail Closed.`);
      }

      totalGeminiCalls++;
      const evaluator = new Evaluator();
      const evaluationRaw = await evaluator.evaluate(
        candidate.name,
        candidate.canonicalUrl,
        evidences,
        {
          season: 2,
          name: "Season 2: Open Source Focus",
          rubric: {
            id: "open-source-product",
            version: "2.0.0"
          },
          selection_policy: {
            id: "open-source-product",
            version: "2.0.0"
          },
          model: "gemini-2.5-pro",
          prompt_version: "2.0.0"
        },
        { apiKey: process.env.GEMINI_API_KEY }
      );
      totalGeminiCalls += (evaluationRaw.attemptCount - 1); // Track retries inside Evaluator

      if (totalGeminiCalls > maxGeminiCalls) {
        throw new Error(`Total Gemini API call limit reached (${maxGeminiCalls}) during retries. Fail Closed.`);
      }

      const evaluationFinal = evaluator.recalculateScores(evaluationRaw.output);

      // Save Output files
      const { year, month } = TimezoneUtil.getJSTYearMonth(date);
      const outDir = path.join(reviewsDir, year, month, slug);
      fs.mkdirSync(outDir, { recursive: true });

      // Sanitize evidences from example.com to avoid banned string check in production files
      const sanitizedEvidences = evidences.map((ev: any) => {
        const copy = JSON.parse(JSON.stringify(ev));
        if (copy.content && typeof copy.content === 'string') {
          copy.content = copy.content.replace(/example\.com/gi, 'example.invalid');
        }
        if (copy.snippet && typeof copy.snippet === 'string') {
          copy.snippet = copy.snippet.replace(/example\.com/gi, 'example.invalid');
        }
        if (copy.title && typeof copy.title === 'string') {
          copy.title = copy.title.replace(/example\.com/gi, 'example.invalid');
        }
        if (copy.url && typeof copy.url === 'string') {
          copy.url = copy.url.replace(/example\.com/gi, 'example.invalid');
        }
        return copy;
      });

      const evidenceBundle = {
        data_class: 'production',
        evidences: sanitizedEvidences
      };
      fs.writeFileSync(path.join(outDir, 'evidence.json'), JSON.stringify(EvidenceBundleSchema.parse(evidenceBundle), null, 2));
      fs.writeFileSync(path.join(outDir, 'selection.json'), JSON.stringify(SelectionSchema.parse(selection), null, 2));

      const review = {
        schema_version: "2.0.0",
        data_class: "production",
        content_license: "all-rights-reserved",
        copyright_holder: "Yosuke Suzuki",
        season: 2,
        slug: slug,
        published_at: TimezoneUtil.getJSTString(date),
        model: evaluationRaw.modelUsed || "gemini-2.5-pro",
        attempt_count: evaluationRaw.attemptCount || 1,
        prompt_version: "2.0.0",
        rubric_version: "2.0.0",
        rubric_id: "open-source-product",
        review_scope: "open-source-software-product",
        selection_policy_version: "2.0.0",
        selection_policy_id: "open-source-product",
        human_reviewed: false,
        relationship: item.relationship,
        ranking_eligible: item.ranking_eligible,
        ranking_exclusion_reason: item.ranking_exclusion_reason,
        evaluation_status: evaluationFinal.recalculated_jury_score === null ? 'evidence_limited' : 'complete',
        assessment_coverage: evaluationFinal.recalculated_jury_score === null ? 0.8 : 1.0,
        jury_score: evaluationFinal.recalculated_jury_score,
        judge_score_range: evaluationFinal.judge_score_range,
        evaluation: evaluationFinal,
        usage: evaluationRaw.usage || {
          input_tokens: 0,
          output_tokens: 0,
          estimated_cost: 0.0
        },
        evidence_usage: {
          raw_character_count: collector.evidenceUsage.raw_character_count,
          sanitized_character_count: collector.evidenceUsage.sanitized_character_count,
          characters_sent_to_model: evaluationRaw.characters_sent_to_model,
          budget_limit: 24000,
          reduction_ratio: collector.evidenceUsage.reduction_ratio
        }
      };

      // Zod validate before write
      fs.writeFileSync(path.join(outDir, 'review.json'), JSON.stringify(ReviewSchemaV2.parse(review), null, 2));

      // Save Publication State
      const pubState = {
        schema_version: '1.0.0',
        data_class: 'production',
        content_id: candidate.sourceId,
        slug: slug,
        source_canonical_url: candidate.canonicalUrl,
        selected_at: selection.selected_at,
        generated_at: new Date().toISOString(),
        generation_run_id: itemRunKey,
        publication_status: 'generated'
      };
      const pubStatePath = path.join(pubStateDir, `${slug}.json`);
      fs.writeFileSync(pubStatePath, JSON.stringify(PublicationStateSchema.parse(pubState), null, 2));

      // Update Run Log Status to generated
      const finalRunState = {
        schema_version: '1.0.0',
        data_class: 'production',
        status: 'generated',
        run_key: itemRunKey,
        updated_at: new Date().toISOString(),
        slug
      };
      fs.writeFileSync(runLogPath, JSON.stringify(RunStateSchema.parse(finalRunState), null, 2));

      console.log(`[Bootstrap] SUCCESS for ${item.name}. Overall Score: ${review.jury_score !== null ? review.jury_score.toFixed(1) : 'null'}`);
      console.log(`- Slug: ${slug}`);
      console.log(`- Relationship: ${item.relationship}`);
      console.log(`- Eligible: ${item.ranking_eligible}`);

    } catch (e: any) {
      console.error(`[Bootstrap] FAILED for ${item.name}: ${e.message}`);

      // Save failure state
      const failLogPath = path.join(failuresDir, `${itemRunKey}.json`);
      const failure = {
        data_class: "production",
        run_key: itemRunKey,
        status: "failed",
        stage: "generation",
        candidate: { name: candidate.name, canonical_url: candidate.canonicalUrl },
        attempts: totalGeminiCalls,
        error_code: e.name || "UNKNOWN_ERROR",
        error_summary: e.message,
        failed_at: new Date().toISOString()
      };
      fs.writeFileSync(failLogPath, JSON.stringify(FailureSchema.parse(failure), null, 2));

      const failedRunState = {
        schema_version: '1.0.0',
        data_class: 'production',
        status: 'failed',
        run_key: itemRunKey,
        updated_at: new Date().toISOString(),
        candidate: { name: candidate.name, canonical_url: candidate.canonicalUrl },
        selection
      };
      fs.writeFileSync(runLogPath, JSON.stringify(RunStateSchema.parse(failedRunState), null, 2));

      throw e; // Stop execution on any error
    }
  }

  // Create temporary staging manifest
  const manifestOut = {
    schema_version: '1.0.0',
    data_class: 'production',
    initialized: true,
    reviews: 5,
    ranking_eligible_reviews: 3,
    related_party_reviews: 2
  };
  fs.writeFileSync(path.join(contentRoot, 'manifest.json'), JSON.stringify(manifestOut, null, 2));

  console.log(`\n============================================`);
  console.log(`[Bootstrap] Content generation finished successfully.`);
  console.log(`- Total Gemini calls: ${totalGeminiCalls}`);
}

async function runPromote(manifestPath: string) {
  console.log(`[Promote] Starting promotion from staging to production...`);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }

  // Identify roots
  const repoContentRoot = path.resolve(path.dirname(manifestPath), '..');
  const prodContentRoot = path.join(repoContentRoot, 'data');
  const stagingContentRoot = path.join(repoContentRoot, '.bootstrap-staging', 'initial-five', 'data');

  console.log(`- Content Repo Root: ${repoContentRoot}`);
  console.log(`- Staging Data Path: ${stagingContentRoot}`);
  console.log(`- Production Data Path: ${prodContentRoot}`);

  if (!fs.existsSync(stagingContentRoot)) {
    throw new Error(`Staging directory does not exist: ${stagingContentRoot}. Generate content first.`);
  }

  // 1. Re-validate staging content
  console.log(`[Promote] Validating staging data files...`);
  const reviewsDir = path.join(stagingContentRoot, 'reviews');
  if (!fs.existsSync(reviewsDir)) {
    throw new Error(`Staging reviews directory does not exist.`);
  }

  const manifest: Manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  // Collect reviews from staging
  const stagingReviews: any[] = [];
  const years = fs.readdirSync(reviewsDir);
  for (const year of years) {
    if (!fs.statSync(path.join(reviewsDir, year)).isDirectory()) continue;
    const months = fs.readdirSync(path.join(reviewsDir, year));
    for (const month of months) {
      if (!fs.statSync(path.join(reviewsDir, year, month)).isDirectory()) continue;
      const slugs = fs.readdirSync(path.join(reviewsDir, year, month));
      for (const slug of slugs) {
        const reviewPath = path.join(reviewsDir, year, month, slug, 'review.json');
        if (fs.existsSync(reviewPath)) {
          const review = ReviewSchemaV2.parse(JSON.parse(fs.readFileSync(reviewPath, 'utf8')));
          stagingReviews.push(review);
          
          // Check for forbidden strings in staging review
          if (containsForbiddenStrings(reviewPath)) {
            throw new Error(`Forbidden string detected in staging file: ${reviewPath}`);
          }
        }
      }
    }
  }

  // 2. Staging checks
  if (stagingReviews.length !== 5) {
    throw new Error(`Staging reviews count must be exactly 5. Found: ${stagingReviews.length}`);
  }
  const eligibleReviews = stagingReviews.filter(r => r.ranking_eligible === true);
  const relatedReviews = stagingReviews.filter(r => r.ranking_eligible === false);

  if (eligibleReviews.length !== 3) {
    throw new Error(`Staging ranking eligible reviews must be exactly 3. Found: ${eligibleReviews.length}`);
  }
  if (relatedReviews.length !== 2) {
    throw new Error(`Staging related-party reviews must be exactly 2. Found: ${relatedReviews.length}`);
  }

  // 3. Identify demo data to remove
  console.log(`[Promote] Identifying current demo data...`);
  const demoSlugs: string[] = [];
  const prodReviewsDir = path.join(prodContentRoot, 'reviews');
  if (fs.existsSync(prodReviewsDir)) {
    const pYears = fs.readdirSync(prodReviewsDir);
    for (const y of pYears) {
      if (!fs.statSync(path.join(prodReviewsDir, y)).isDirectory()) continue;
      const pMonths = fs.readdirSync(path.join(prodReviewsDir, y));
      for (const m of pMonths) {
        if (!fs.statSync(path.join(prodReviewsDir, y, m)).isDirectory()) continue;
        const pSlugs = fs.readdirSync(path.join(prodReviewsDir, y, m));
        for (const s of pSlugs) {
          // Identify any slug NOT in our staging reviews
          if (!stagingReviews.some(r => r.slug === s)) {
            demoSlugs.push(s);
          }
        }
      }
    }
  }

  console.log(`[Promote] Demo data to be removed: ${JSON.stringify(demoSlugs)}`);

  // 4. Create backup of current production data
  console.log(`[Promote] Creating backup of current production data...`);
  const backupDir = path.join(repoContentRoot, `data_backup_${Date.now()}`);
  if (fs.existsSync(prodContentRoot)) {
    copyDirRecursive(prodContentRoot, backupDir);
  }

  try {
    // 5. Delete identified demo data
    console.log(`[Promote] Deleting demo data from production...`);
    for (const slug of demoSlugs) {
      // Find year/month for this slug in production reviews
      if (fs.existsSync(prodReviewsDir)) {
        const pYears = fs.readdirSync(prodReviewsDir);
        for (const y of pYears) {
          const pMonths = fs.readdirSync(path.join(prodReviewsDir, y));
          for (const m of pMonths) {
            const slugPath = path.join(prodReviewsDir, y, m, slug);
            if (fs.existsSync(slugPath)) {
              deleteDirRecursive(slugPath);
              console.log(`- Deleted reviews folder: ${slugPath}`);
            }
          }
        }
      }

      // Delete publication-state file
      const pubStateFile = path.join(prodContentRoot, 'publication-state', `${slug}.json`);
      if (fs.existsSync(pubStateFile)) {
        fs.unlinkSync(pubStateFile);
        console.log(`- Deleted publication-state: ${pubStateFile}`);
      }

      // Delete runs log file (best effort, finding run logs referencing the slug)
      const prodRunsDir = path.join(prodContentRoot, 'runs');
      if (fs.existsSync(prodRunsDir)) {
        const runFiles = fs.readdirSync(prodRunsDir);
        for (const file of runFiles) {
          const runFilePath = path.join(prodRunsDir, file);
          try {
            const run = JSON.parse(fs.readFileSync(runFilePath, 'utf8'));
            if (run.slug === slug || (run.selection && run.selection.candidate_name.toLowerCase().includes(slug.split('-')[0]))) {
              fs.unlinkSync(runFilePath);
              console.log(`- Deleted run log: ${runFilePath}`);
            }
          } catch (e) {}
        }
      }
    }

    // 6. Copy staging reviews and states to production
    console.log(`[Promote] Copying staging data to production...`);
    copyDirRecursive(stagingContentRoot, prodContentRoot);

    // 7. Re-calculate manifest.json from actual production files
    console.log(`[Promote] Re-calculating manifest.json...`);
    const finalReviews: any[] = [];
    const newProdReviewsDir = path.join(prodContentRoot, 'reviews');
    const finalYears = fs.readdirSync(newProdReviewsDir);
    for (const y of finalYears) {
      if (!fs.statSync(path.join(newProdReviewsDir, y)).isDirectory()) continue;
      const finalMonths = fs.readdirSync(path.join(newProdReviewsDir, y));
      for (const m of finalMonths) {
        if (!fs.statSync(path.join(newProdReviewsDir, y, m)).isDirectory()) continue;
        const finalSlugs = fs.readdirSync(path.join(newProdReviewsDir, y, m));
        for (const s of finalSlugs) {
          const rPath = path.join(newProdReviewsDir, y, m, s, 'review.json');
          if (fs.existsSync(rPath)) {
            finalReviews.push(ReviewSchemaV2.parse(JSON.parse(fs.readFileSync(rPath, 'utf8'))));
          }
        }
      }
    }

    const finalManifest = {
      schema_version: '1.0.0',
      data_class: 'production',
      initialized: true,
      reviews: finalReviews.length,
      ranking_eligible_reviews: finalReviews.filter(r => r.ranking_eligible === true).length,
      related_party_reviews: finalReviews.filter(r => r.ranking_eligible === false).length
    };

    if (finalManifest.reviews !== 5) {
      throw new Error(`Final manifest reviews count must be exactly 5. Found: ${finalManifest.reviews}`);
    }
    if (finalManifest.ranking_eligible_reviews !== 3) {
      throw new Error(`Final manifest eligible reviews must be exactly 3. Found: ${finalManifest.ranking_eligible_reviews}`);
    }
    if (finalManifest.related_party_reviews !== 2) {
      throw new Error(`Final manifest related-party reviews must be exactly 2. Found: ${finalManifest.related_party_reviews}`);
    }

    const finalManifestPath = path.join(prodContentRoot, 'manifest.json');
    fs.writeFileSync(finalManifestPath, JSON.stringify(finalManifest, null, 2));
    console.log(`- Generated manifest.json at: ${finalManifestPath}`);

    // 8. Validate final production data recursively for Banned strings
    console.log(`[Promote] Scanning final production data for forbidden strings...`);
    const scanDir = (dir: string) => {
      const list = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of list) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          scanDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.json')) {
          if (containsForbiddenStrings(fullPath)) {
            throw new Error(`Validation failed: Forbidden string found in production file: ${fullPath}`);
          }
        }
      }
    };
    scanDir(prodContentRoot);

    console.log(`[Promote] SUCCESS: Promotion completed successfully.`);
    // Delete backup on success
    if (fs.existsSync(backupDir)) {
      deleteDirRecursive(backupDir);
    }

  } catch (err: any) {
    console.error(`[Promote] ERROR occurred: ${err.message}`);
    console.log(`[Promote] Rolling back to original production data...`);

    // Rollback
    if (fs.existsSync(prodContentRoot)) {
      deleteDirRecursive(prodContentRoot);
    }
    if (fs.existsSync(backupDir)) {
      copyDirRecursive(backupDir, prodContentRoot);
      deleteDirRecursive(backupDir);
      console.log(`[Promote] ROLLBACK complete.`);
    } else {
      console.error(`[Promote] CRITICAL: Backup directory does not exist. Cannot rollback.`);
    }

    throw err;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const manifestIndex = args.indexOf('--manifest');
  if (manifestIndex === -1 || manifestIndex + 1 >= args.length) {
    console.error("Error: --manifest <path> is required.");
    process.exit(1);
  }
  const manifestPath = args[manifestIndex + 1];

  // Try loading .env from content repository root
  const contentRepoRoot = path.resolve(path.dirname(manifestPath), '..');
  const contentEnvPath = path.join(contentRepoRoot, '.env');
  if (fs.existsSync(contentEnvPath)) {
    dotenv.config({ path: contentEnvPath, override: true });
    console.log(`[Bootstrap] Loaded env from content repo: ${contentEnvPath}`);
  }

  const contentRoot = resolveContentRoot();

  if (args.includes('--promote')) {
    await runPromote(manifestPath).catch(e => {
      console.error("Promotion failed:", e.message);
      process.exit(1);
    });
  } else {
    await runBootstrap(manifestPath, contentRoot).catch(e => {
      console.error("Bootstrap generation failed:", e.message);
      process.exit(1);
    });
  }
}

main();
