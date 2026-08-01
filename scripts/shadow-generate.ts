import 'dotenv/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import crypto from 'crypto';
import { Evaluator } from '../src/lib/evaluation/evaluator';
import {
  assertProviderCredentials,
  resolveProvider,
  type LlmProvider
} from '../src/lib/evaluation/llm-transport';
import { resolveContentRoot } from '../src/lib/content-root';
import { readRunState } from '../src/lib/publication/state-store';
import {
  buildInitialRecord,
  readRecord,
  writeRecord,
  recordsDir,
  SECRET_ENV_VARS
} from '../src/lib/generation/record-store';
import { validateAndPersist } from '../src/lib/generation/pipeline';
import { measureEditorialVoice } from '../src/lib/evaluation/editorial-metrics';
import { EvidenceCollectionResultSchema } from '../src/schemas/evidence';
import { prepareCandidateWithIntegrityContext } from '../src/lib/daily-evaluation';
import { readRecentArticleOpenings } from '../src/lib/evaluation/recent-articles';

/**
 * Shadow generation: run the CURRENT prompt through a NON-Gemini provider against inputs that
 * already exist, and write the result to artifacts. Nothing else.
 *
 * This is the measurement instrument for the provider migration, and it is built so it cannot
 * become anything else:
 *
 *   - It never selects a candidate, never collects evidence and never calls Gemini. Its inputs
 *     are the stored candidate and the stored evidence bundle of a run that already happened,
 *     so the only thing that differs from the original run is which model answered. "The same
 *     inputs" is a stronger claim than reading the same files: the daily pipeline merges the
 *     collected identity and snapshot into the candidate before generating, and it shows the
 *     writer the archive as it stood that day. Both are reproduced here — the first always, the
 *     second when `--archive-as-of` is given — and `promptIdentical` in comparison-metadata.json
 *     is what proves it worked. A false there invalidates the comparison.
 *   - It never writes to the content repository. Validation runs against a throwaway content
 *     root in the system temp directory, so the real record, its quality history, the
 *     publication state and review.json are all physically out of reach.
 *   - It never publishes. publishRecord is not imported, so there is no code path from here to
 *     a public artifact.
 *
 * The workflow that runs it holds `contents: read` and performs no commit, push or deploy. Those
 * two facts — no write path in the code, no write permission in the workflow — are deliberately
 * redundant: either one alone would be enough, and neither is trusted on its own.
 */

interface ShadowArgs {
  runKey: string;
  outDir: string;
  archiveRoot: string | null;
}

function parseArgs(argv: string[]): ShadowArgs {
  let runKey = '';
  let outDir = path.join(process.cwd(), 'shadow-out');
  let archiveRoot: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run-key') runKey = argv[++i] ?? '';
    else if (argv[i] === '--out') outDir = path.resolve(argv[++i] ?? outDir);
    else if (argv[i] === '--archive-as-of') archiveRoot = path.resolve(argv[++i] ?? '');
  }
  if (!runKey) throw new Error('--run-key is required.');
  // The same whole-string guard the workflows apply to a dispatched run key.
  if (!/^season-[0-9]+-(manual-[0-9]+|request-[1-9][0-9]*|regenerate-[a-z0-9][a-z0-9-]*-[0-9]+|[0-9]{4}-[0-9]{2}-[0-9]{2}-daily(-[a-z0-9][a-z0-9-]*)?)$/.test(runKey)) {
    throw new Error(`--run-key has an invalid format: ${runKey}`);
  }
  if (archiveRoot && !fs.existsSync(path.join(archiveRoot, 'reviews'))) {
    throw new Error(`--archive-as-of must point at a content root containing reviews/: ${archiveRoot}`);
  }
  return { runKey, outDir, archiveRoot };
}

/**
 * Refuses to write an artifact containing a live credential value.
 *
 * The same guard the record store applies, for the same reason and against the same list: a
 * shadow artifact carries the raw model response, and a response is the one thing in this
 * pipeline that nobody wrote. Short values are ignored — below the record store's threshold a
 * "secret" is more likely to be a coincidence than a leak.
 */
function assertNoSecretsInArtifact(name: string, serialized: string): void {
  for (const key of SECRET_ENV_VARS) {
    const value = process.env[key];
    if (!value || value.length < 12) continue;
    if (serialized.includes(value)) {
      throw new Error(`[Shadow] Refusing to write ${name}: it contains the value of ${key}.`);
    }
  }
}

/** The deepest ancestor of `target` that exists, so a not-yet-created --out can be canonicalized. */
function nearestExistingAncestor(target: string): string {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

/**
 * Refuses an output directory that lands inside the content repository.
 *
 * The claim this file makes is that a shadow run cannot write to production. Without this
 * check that claim rested on the caller's choice of `--out`: the workflow passes a safe path,
 * but the CLI would just as happily accept `data/` and scatter artifacts through the
 * publication SSOT. A guarantee that depends on the argument is not a guarantee.
 *
 * Both sides are canonicalized with `realpathSync` before comparison, because a lexical check
 * is defeated by a symlink: an `--out` that resolves to an innocent-looking path outside the
 * repository can still be a link INTO `data/`, and every later write would follow it. The
 * output directory may not exist yet, so its deepest existing ancestor is canonicalized
 * instead — that is the component a symlink would have to live on.
 *
 * The comparison appends a separator, so a sibling whose name merely starts with the content
 * root (`/x/data-scratch` next to `/x/data`) is correctly allowed.
 */
function assertOutsideContentRoot(outDir: string, contentRoot: string): void {
  const canonicalRoot = fs.existsSync(contentRoot)
    ? fs.realpathSync(path.resolve(contentRoot))
    : path.resolve(contentRoot);
  const canonicalOut = path.resolve(
    fs.realpathSync(nearestExistingAncestor(outDir)),
    path.relative(nearestExistingAncestor(outDir), path.resolve(outDir))
  );

  if (canonicalOut === canonicalRoot || canonicalOut.startsWith(canonicalRoot + path.sep)) {
    throw new Error(
      `--out must not point inside the content repository (${canonicalRoot}). ` +
      'Shadow generation never writes to production data.'
    );
  }
}

/**
 * Assigns the two candidates to A and B from the run key alone.
 *
 * Deterministic so a reviewer can re-derive the mapping afterwards, and not simply "Gemini is
 * always A" so the reviewer cannot infer the provider from the position. The key is written to a
 * separate file that a blind reader is expected not to open until they have scored both.
 */
function blindOrder(runKey: string): { a: 'stored' | 'shadow'; b: 'stored' | 'shadow' } {
  const digest = crypto.createHash('sha256').update(runKey).digest();
  return digest[0] % 2 === 0
    ? { a: 'stored', b: 'shadow' }
    : { a: 'shadow', b: 'stored' };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const provider: LlmProvider = resolveProvider();
  if (provider === 'gemini') {
    // The stored response IS the Gemini side of the comparison. Re-running it would spend
    // quota to reproduce something already on disk, and would compare two Gemini samples
    // rather than two providers.
    throw new Error(
      'Shadow generation requires a non-Gemini provider. The Gemini side of the comparison is ' +
      'the response already stored on the record. Set JURYPRESS_LLM_PROVIDER.'
    );
  }
  assertProviderCredentials(provider);

  // Read-only from here on. Nothing below writes to this path — and the artifact directory is
  // checked against it before anything is generated, so a mistyped --out fails before the
  // model is called rather than after.
  const contentRoot = resolveContentRoot();
  assertOutsideContentRoot(args.outDir, contentRoot);
  const seasonConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8'));

  const runState: any = readRunState(contentRoot, args.runKey);
  if (!runState) throw new Error(`[Shadow] No run state exists for ${args.runKey}.`);

  if (!runState.candidate) {
    throw new Error(`[Shadow] Run ${args.runKey} stores no candidate; shadow generation never selects one.`);
  }
  // The daily pipeline merges the collected project identity and metadata snapshot into the
  // candidate before it generates (`prepareCandidateWithIntegrityContext` in run-daily.ts), and
  // the run state stores the candidate as it was BEFORE that merge. Repeating the merge here is
  // what makes the two prompts the same prompt: without it the shadow model is asked to review
  // `owner/repo` instead of the product's canonical name, with `Metadata Snapshot: None` where
  // the original had the stars, licence and commit the prompt's fact rules are written against.
  // That is not a slower model or a worse one — it is a different question, and comparing the
  // answers would measure the wiring rather than the provider.
  const prepared = prepareCandidateWithIntegrityContext(
    runState.candidate,
    EvidenceCollectionResultSchema.parse(runState.collection_result)
  );
  const candidate = prepared.candidate;
  const collectionResult = prepared.context;
  const evidences = collectionResult.evidences;

  const storedRecord = readRecord(contentRoot, args.runKey);
  if (!storedRecord) throw new Error(`[Shadow] No generation record exists for ${args.runKey}.`);

  const promptVersion = storedRecord.generation.promptVersion
    ?? seasonConfig.evaluation_prompt_version
    ?? '2.1.0';

  console.log(`[Shadow] run=${args.runKey} provider=${provider} promptVersion=${promptVersion}`);

  // The prompt shows the writer the openings of the last three PUBLISHED reviews, so it depends
  // on how far the archive had grown when the run happened — not on the run's own inputs. Read
  // from today's archive it is guaranteed to differ, and for a recent run it even contains the
  // article being compared against. `--archive-as-of` points at the archive as it stood at the
  // run's generate commit; without it the recent-article block is the one thing that cannot
  // match, and promptIdentical is false no matter which run is chosen.
  const archiveRoot = args.archiveRoot ?? contentRoot;
  const recentArticles = readRecentArticleOpenings(archiveRoot);

  const evaluator = new Evaluator({ provider });
  const raw = await evaluator.generateRaw(candidate, evidences, {
    promptVersion,
    recentArticles
  });

  // Validation runs against a throwaway root. The real record is never opened for writing, so a
  // shadow run cannot append to its quality history or move its publication status.
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-shadow-'));
  fs.mkdirSync(recordsDir(scratchRoot), { recursive: true });

  const shadowRecord = buildInitialRecord({
    recordId: args.runKey,
    candidateId: candidate.sourceId ?? '',
    runKey: args.runKey,
    canonicalUrl: candidate.canonicalUrl ?? null,
    candidateName: candidate.name ?? null,
    slug: storedRecord.slug,
    receivedAt: new Date().toISOString(),
    model: raw.requestedModel,
    modelVersion: raw.modelUsed,
    promptVersion,
    promptHash: raw.promptHash,
    rawResponse: raw.rawResponse,
    originalContent: raw.parsed,
    usage: {
      promptTokens: raw.tokenUsage.input_tokens,
      completionTokens: raw.tokenUsage.output_tokens,
      totalTokens: raw.tokenUsage.total_tokens,
      thinkingTokens: raw.tokenUsage.thinking_tokens,
      cachedInputTokens: raw.tokenUsage.cached_input_tokens
    },
    route: {
      requestedModel: raw.requestedModel,
      thinkingLevel: raw.thinkingLevel,
      successfulRoute: raw.successfulRoute,
      failoverUsed: raw.failoverUsed,
      primaryAttempts: raw.primaryAttemptCount,
      fallbackAttempts: raw.fallbackAttemptCount,
      totalAttempts: raw.attemptCount,
      charactersSentToModel: raw.characters_sent_to_model
    },
    provider: {
      name: raw.provider,
      requestedModel: raw.requestedModel,
      modelUsed: raw.modelUsed,
      authenticationMode: raw.authenticationMode,
      engineVersion: typeof raw.transportMetadata.engineVersion === 'string'
        ? raw.transportMetadata.engineVersion
        : null,
      responseCapture: raw.responseCapture,
      transportMetadata: raw.transportMetadata
    }
  });
  writeRecord(scratchRoot, shadowRecord);

  const validated = validateAndPersist({ contentRoot: scratchRoot, recordId: args.runKey, evidences });

  fs.mkdirSync(args.outDir, { recursive: true });
  // Re-checked here, after the directory exists, because the first check ran against the
  // deepest ancestor that existed at the time. Cheap, and it closes the window between the two.
  assertOutsideContentRoot(args.outDir, contentRoot);

  const write = (name: string, value: unknown) => {
    const target = path.join(args.outDir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Artifacts leave the machine — they are uploaded and downloaded by a human — so they get
    // the same secret scan a stored record gets, not a weaker one.
    const serialized = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    assertNoSecretsInArtifact(name, serialized);
    fs.writeFileSync(target, serialized);
  };

  write('claude-raw-response.txt', raw.rawResponse);
  write('claude-result.json', raw.parsed);
  write('validation-result.json', {
    quality: validated.quality.status,
    parsed: raw.parsed !== null,
    errors: validated.quality.errors,
    warnings: validated.quality.warnings,
    validatorVersion: validated.quality.validatorVersion
  });
  write('comparison-metadata.json', {
    runKey: args.runKey,
    promptVersion,
    // The same prompt hash on both sides is the proof that only the provider moved. A
    // difference here means the comparison is invalid, whatever the articles look like.
    shadowPromptHash: raw.promptHash,
    storedPromptHash: storedRecord.generation.promptHash,
    promptIdentical: raw.promptHash === storedRecord.generation.promptHash,
    // The two inputs that make the prompt reproducible, reported so a false above can be read
    // without guessing: whether the archive was rewound, and how many openings it yielded.
    recentArticles: {
      archivePinnedToRun: args.archiveRoot !== null,
      openingCount: recentArticles.length
    },
    shadow: {
      provider: raw.provider,
      requestedModel: raw.requestedModel,
      modelUsed: raw.modelUsed,
      authenticationMode: raw.authenticationMode,
      responseCapture: raw.responseCapture,
      attemptCount: raw.attemptCount,
      tokenUsage: raw.tokenUsage,
      transportMetadata: raw.transportMetadata,
      jsonParsed: raw.parsed !== null,
      qualityStatus: validated.quality.status
    },
    stored: {
      provider: storedRecord.generation.provider?.name ?? null,
      requestedModel: storedRecord.generation.model,
      modelUsed: storedRecord.generation.modelVersion,
      usage: storedRecord.generation.usage,
      qualityStatus: storedRecord.quality.status
    }
  });
  write('editorial-metrics.json', {
    shadow: safeMeasure(validated.editorial.currentContent),
    stored: safeMeasure(storedRecord.editorial.currentContent)
  });

  // Blind pair: the two articles with no provider or model named anywhere, plus the key in a
  // separate file the reviewer opens only after scoring.
  const order = blindOrder(args.runKey);
  const contentOf = (which: 'stored' | 'shadow') =>
    which === 'stored' ? storedRecord.editorial.currentContent : validated.editorial.currentContent;
  write('blind/candidate-a.json', contentOf(order.a));
  write('blind/candidate-b.json', contentOf(order.b));
  write('blind/KEY-do-not-open-until-scored.json', {
    a: order.a === 'stored' ? (storedRecord.generation.provider?.name ?? 'gemini') : raw.provider,
    b: order.b === 'stored' ? (storedRecord.generation.provider?.name ?? 'gemini') : raw.provider
  });

  // The Actions summary carries status only. No article text, no raw response, no evidence,
  // no prompt — those live in the artifact, which is downloaded deliberately.
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    fs.appendFileSync(summaryFile, `
### JuryPress Shadow Generation
- **Run Key**: ${args.runKey}
- **Provider**: ${raw.provider}
- **Requested Model**: ${raw.requestedModel}
- **Model Used**: ${raw.modelUsed ?? 'unknown'}
- **Prompt Identical To Stored Run**: ${raw.promptHash === storedRecord.generation.promptHash}
- **Raw Response Capture**: ${raw.responseCapture.type} (verbatim: ${raw.responseCapture.verbatim})
- **JSON Parsed**: ${raw.parsed !== null}
- **Quality (shadow)**: ${validated.quality.status}
- **Quality (stored)**: ${storedRecord.quality.status}
- **Attempts**: ${raw.attemptCount}
- **Input Tokens**: ${raw.tokenUsage.input_tokens ?? 'unknown'}
- **Output Tokens**: ${raw.tokenUsage.output_tokens ?? 'unknown'}
- Production data was not read for writing and not modified.
`);
  }

  fs.rmSync(scratchRoot, { recursive: true, force: true });
  console.log(`[Shadow] Complete. Artifacts written to ${args.outDir}.`);
}

/** Voice readings are an instrument, never a gate — a broken reading must not fail the run. */
function safeMeasure(content: unknown): unknown {
  try {
    return measureEditorialVoice(content) ?? null;
  } catch {
    return null;
  }
}

main().catch(e => {
  console.error(`[Shadow] ${e.message}`);
  process.exit(1);
});
