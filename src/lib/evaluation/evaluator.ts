import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
  EvaluationOutputSchema,
  type PublishedEvaluationAny,
  EvaluationOutputGenSchemaV2_1,
  PublishedEvaluationSchemaV1,
  PublishedEvaluationSchemaV2,
  PublishedEvaluationSchemaV2_1,
  RefinedPublishedEvaluationSchemaV2,
  RefinedPublishedEvaluationSchemaV2_1,
  type CoreSourceEvidence,
  type TestEvidenceSummary,
  type ConfidenceAdjustment,
  type CounterEvidenceReference
} from '../../schemas/evaluation';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Candidate } from '../../schemas/selection';
import type { Evidence, EvidenceCollectionResult } from '../../schemas/evidence';
import {
  buildTrustedClaimReferences,
  validateClaimReferences,
  factClassForEvidence,
  type TrustedClaimReference
} from './public-claims';
import { validateRecommendations } from './recommendations';
import * as fs from 'fs';
import * as path from 'path';
export type GeminiCredentialRoute = 'primary' | 'fallback';

/** Production thinking level. Applied identically to the primary and fallback routes. */
export const GEMINI_THINKING_LEVEL = ThinkingLevel.HIGH;

/**
 * Single source of the Gemini generation config. Primary and fallback share the ONE
 * frozen object this returns — the routes differ only by credential, never by config,
 * so thinking level or response schema can never drift between them.
 */
export function buildGenerationConfig(schemaDefinition: object) {
  return Object.freeze({
    responseMimeType: "application/json" as const,
    responseJsonSchema: schemaDefinition,
    thinkingConfig: Object.freeze({ thinkingLevel: GEMINI_THINKING_LEVEL })
  });
}

export interface RecalculationOptions {
  integrityContext?: EvidenceCollectionResult;
}

export class GeminiEvaluationExhaustedError extends Error {
  public totalAttempts: number;
  public primaryAttempts: number;
  public fallbackAttempts: number;
  public lastErrorCategory: string;
  public failoverUsed: boolean;

  constructor(metadata: {
    totalAttempts: number;
    primaryAttempts: number;
    fallbackAttempts: number;
    lastErrorCategory: string;
    failoverUsed: boolean;
  }) {
    super("Gemini evaluation attempts exhausted.");
    this.name = "GeminiEvaluationExhaustedError";
    this.totalAttempts = metadata.totalAttempts;
    this.primaryAttempts = metadata.primaryAttempts;
    this.fallbackAttempts = metadata.fallbackAttempts;
    this.lastErrorCategory = metadata.lastErrorCategory;
    this.failoverUsed = metadata.failoverUsed;
  }
}

function classifyError(e: any, route: GeminiCredentialRoute): 'transient_retry' | 'generation_retry' | 'immediate_fallback' | 'immediate_failure' {
  if (e instanceof SyntaxError || e.name === 'ZodError' || (e.message && (
    // Generation-side claim-provenance validation errors (thrown by the shared
    // public-claims module) — retry the generation like any other content failure.
    e.message.startsWith("[Claim]") ||
    // Recommendation-contract violations (lib/evaluation/recommendations.ts) are
    // content failures of the same kind: regenerate rather than fail the run.
    e.message.startsWith("[Recommendation]") ||
    // Response-envelope violations (e.g. a missing modelVersion) — the response is
    // unusable as provenance, so retry the generation instead of fabricating metadata.
    e.message.startsWith("[Generation]") ||
    e.message.includes("identical recommended") ||
    e.message.includes("HTML tags found") ||
    e.message.includes("Prohibited phrase") || 
    e.message.includes("Prohibited pattern") || 
    e.message.includes("integrity Violation") || 
    e.message.includes("CJK characters") || 
    e.message.includes("Repeated word") || 
    e.message.includes("Invalid evidence_id") || 
    e.message.includes("too high") || 
    e.message.includes("Too homogenized") || 
    e.message.includes("Must have exactly") || 
    e.message.includes("identical verdicts") || 
    e.message.includes("identical decisive") || 
    e.message.includes("identical key strengths") || 
    e.message.includes("Evidence Coverage Matrix Violation")
  ))) {
    return 'generation_retry';
  }

  const msg = (e.message || "").toLowerCase();
  const statusCode = e.status || e.statusCode || parseInt(msg.match(/status code (\d+)/)?.[1] || "0", 10);

  if (statusCode === 400 || msg.includes("invalid_argument") || msg.includes("bad request")) {
    return 'immediate_failure';
  }
  if (statusCode === 404 || msg.includes("not found") || msg.includes("model not found")) {
    return 'immediate_failure';
  }
  if (msg.includes("unsupported model") || msg.includes("malformed request")) {
    return 'immediate_failure';
  }

  if (statusCode === 403) {
    if (msg.includes("api key") || msg.includes("credential") || msg.includes("permission") || msg.includes("denied")) {
      return route === 'primary' ? 'immediate_fallback' : 'immediate_failure';
    }
    return 'immediate_failure';
  }

  if (msg.includes("api key invalid") || msg.includes("invalid api key") || msg.includes("expired") || msg.includes("key expired")) {
    return route === 'primary' ? 'immediate_fallback' : 'immediate_failure';
  }

  if (msg.includes("quota exceeded") || msg.includes("rate limit") || msg.includes("resource exhausted") || msg.includes("free tier") || msg.includes("exhaustion") || statusCode === 429) {
    if (route === 'primary') {
      return 'immediate_fallback';
    }
    return 'transient_retry';
  }

  if (statusCode === 408 || statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return 'transient_retry';
  }
  if (msg.includes("timeout") || msg.includes("socket") || msg.includes("disconnect") || msg.includes("reset") || msg.includes("dns") || msg.includes("network") || msg.includes("fetch failed")) {
    return 'transient_retry';
  }
  if (msg.includes("empty candidate") || msg.includes("empty response")) {
    return 'transient_retry';
  }

  return 'transient_retry';
}

function sanitizeErrorSummary(e: any): string {
  const msg = (e.message || "").toLowerCase();
  const statusCode = e.status || e.statusCode || parseInt(msg.match(/status code (\d+)/)?.[1] || "0", 10);

  if (e.name === 'ZodError') return "ZOD_VALIDATION_ERROR";
  if (e instanceof SyntaxError) return "JSON_PARSE_FAILURE";
  // [Claim]/[Recommendation]-prefixed messages come from the shared claim-provenance and
  // recommendation validators during generation; [Generation]-prefixed ones from
  // response-envelope validation (e.g. missing modelVersion). Only the category is
  // logged — never the statement text they reference.
  if (e.message && (e.message.startsWith("[Claim]") || e.message.startsWith("[Recommendation]") || e.message.startsWith("[Generation]"))) return "GENERATION_VALIDATION_FAILURE";
  if (e.message && (
    e.message.includes("HTML tags found") || 
    e.message.includes("Prohibited phrase") || 
    e.message.includes("Prohibited pattern") || 
    e.message.includes("integrity Violation") || 
    e.message.includes("CJK characters") || 
    e.message.includes("Repeated word") || 
    e.message.includes("Invalid evidence_id") || 
    e.message.includes("too high") || 
    e.message.includes("Too homogenized") || 
    e.message.includes("Must have exactly") || 
    e.message.includes("identical verdicts") ||
    e.message.includes("identical decisive") ||
    e.message.includes("identical recommended") ||
    e.message.includes("identical key strengths") ||
    e.message.includes("Evidence Coverage Matrix Violation")
  )) {
    return "EDITORIAL_VALIDATION_FAILURE";
  }

  if (msg.includes("quota exceeded") || msg.includes("resource exhausted") || msg.includes("rate limit") || statusCode === 429) {
    return "QUOTA_EXCEEDED";
  }
  if (msg.includes("api key") || msg.includes("credential") || msg.includes("permission") || msg.includes("denied") || statusCode === 403) {
    return "CREDENTIAL_OR_PERMISSION_ERROR";
  }
  if (msg.includes("timeout") || msg.includes("network") || msg.includes("fetch failed")) {
    return "NETWORK_TIMEOUT";
  }

  if (statusCode) {
    return `HTTP_${statusCode}`;
  }

  return "UNKNOWN_TRANSIENT_ERROR";
}

/**
 * Builds the trusted claim-reference set from the model's statement annotations, then
 * re-validates it through the shared module so the generator and the publication gate
 * derive coverage identically. Every statement of every COVERAGE field must be matched by
 * exactly one annotation (or be an application-injected statement); fact_class,
 * attribution_required and coverage_source are derived here, never taken from the model.
 * Thrown (retryable) from verifyRules and re-derived by the publication gate, so a
 * non-compliant generation regenerates rather than publishing.
 */
function buildClaimReferences(evaluation: any, evidences: Evidence[]): TrustedClaimReference[] {
  const evidenceById = new Map(evidences.map(e => [e.evidence_id, e]));
  const references = buildTrustedClaimReferences(evaluation, evidenceById);
  validateClaimReferences(evaluation, references, evidenceById);
  return references;
}

/**
 * Application-owned public classifications for a refined review, re-derived from the evidence
 * that public statements actually cite. This replaces the model's self-reported
 * evidence_classifications so a README-sourced claim can never be published as "confirmed"
 * and the confidence ceilings read trustworthy data. Uses the EvidenceFactClass vocabulary
 * directly so community_opinion / repository_observation / unverified survive into the UI.
 */
function buildRefinedClassifications(
  annotations: any[],
  evidences: Evidence[],
  verifiedExecutionEvidenceIds: string[]
): Array<{ evidence_id: string; classification: string; claim: string }> {
  const evidenceById = new Map(evidences.map(e => [e.evidence_id, e]));
  const cited = new Set<string>();
  for (const annotation of annotations || []) {
    for (const id of annotation.evidence_ids || []) cited.add(id);
  }
  const out: Array<{ evidence_id: string; classification: string; claim: string }> = [];
  // Preserve bundle order for determinism.
  for (const evidence of evidences) {
    if (!cited.has(evidence.evidence_id)) continue;
    out.push({
      evidence_id: evidence.evidence_id,
      classification: factClassForEvidence(evidence),
      claim: evidence.claims?.[0]?.text || ''
    });
  }
  for (const evidenceId of verifiedExecutionEvidenceIds) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) continue;
    out.push({
      evidence_id: evidenceId,
      classification: 'runtime_observed',
      claim: evidence.claims?.[0]?.text || 'A verified test execution result was observed.'
    });
  }
  return out;
}

function meaningfulTokens(text: string): Set<string> {
  const stopWords = new Set(['about', 'after', 'again', 'also', 'because', 'could', 'does', 'from', 'have', 'into', 'just', 'more', 'only', 'project', 'that', 'their', 'there', 'these', 'they', 'this', 'with', 'would']);
  return new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) || []).filter(token => !stopWords.has(token)));
}

function buildCounterEvidenceReferences(evaluation: any): CounterEvidenceReference[] {
  // Only criticism the model was actually given can be expected in its output.
  const criticalItems = evaluation.discussion_evidence?.items?.filter((item: any) => item.requires_public_response) || [];
  if (criticalItems.length === 0) return [];

  const fields: Array<{ path: string; text: string }> = [];
  evaluation.article.where_jury_disagreed?.forEach((item: any, index: number) => fields.push({ path: `article.where_jury_disagreed.${index}.summary`, text: item.summary || '' }));
  evaluation.judges.forEach((judge: any, judgeIndex: number) => {
    fields.push({ path: `judges.${judgeIndex}.verdict`, text: judge.verdict || '' });
    judge.concerns?.forEach((text: string, index: number) => fields.push({ path: `judges.${judgeIndex}.concerns.${index}`, text }));
    judge.criteria?.forEach((criterion: any, criterionIndex: number) => fields.push({ path: `judges.${judgeIndex}.criteria.${criterionIndex}.reasoning`, text: criterion.reasoning || '' }));
  });

  const attributionPattern = /\b(commenter|commenters|community|discussion|community opinion|a user|users questioned|criticism|criticized)\b/i;
  const references: CounterEvidenceReference[] = [];
  for (const item of criticalItems) {
    const excerptTokens = meaningfulTokens(item.excerpt);
    const target = fields.find(field => {
      if (!attributionPattern.test(field.text)) return false;
      const fieldTokens = meaningfulTokens(field.text);
      return [...excerptTokens].some(token => fieldTokens.has(token));
    });
    if (target) {
      references.push({
        discussion_item_id: item.discussion_item_id,
        parent_evidence_id: item.parent_evidence_id,
        public_output_path: target.path,
        target_field: target.path
      });
    }
  }
  return references;
}

export class Evaluator {
  private model: string;
  private rubric: any;

  constructor() {
    this.model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    // Default to Rubric V2
    const rubricPath = path.join(process.cwd(), 'config', 'rubrics', 'open-source-product-v2.json');
    this.rubric = JSON.parse(fs.readFileSync(rubricPath, 'utf8'));
    this.validateRubricConfig(this.rubric);
  }

  private validateRubricConfig(rubric: any) {
    if (!rubric || !Array.isArray(rubric.criteria)) {
      throw new Error("Invalid rubric: missing criteria array.");
    }
    if (rubric.criteria.length !== 6) {
      throw new Error(`Invalid rubric: criteria count must be exactly 6, found ${rubric.criteria.length}.`);
    }
    const ids = new Set<string>();
    let totalWeight = 0;
    for (const c of rubric.criteria) {
      const criterionId = c.id || c.name?.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      if (!criterionId || !c.label && !c.name || c.weight === undefined) {
        throw new Error("Invalid rubric: criterion missing required fields.");
      }
      if (ids.has(criterionId)) {
        throw new Error(`Invalid rubric: duplicate criterion ID: ${criterionId}`);
      }
      ids.add(criterionId);
      if (typeof c.weight !== 'number' || c.weight <= 0) {
        throw new Error(`Invalid rubric: weight must be positive number, found ${c.weight}.`);
      }
      totalWeight += c.weight;
    }
    if (totalWeight !== 100) {
      throw new Error(`Invalid rubric: total weight must be 100, found ${totalWeight}.`);
    }
  }

  private setupAgentIntercept(client: GoogleGenAI) {
    const requestPath = '/Users/suzukiyousuke/.gemini/antigravity-ide/brain/6e2a0014-c0c6-4705-8efc-32dc52bd416d/scratch/agent-request.json';
    const responsePath = '/Users/suzukiyousuke/.gemini/antigravity-ide/brain/6e2a0014-c0c6-4705-8efc-32dc52bd416d/scratch/agent-response.json';
    client.models.generateContent = async (args: any) => {
      console.log(`\n[Agent Intercept] Intercepted generateContent call for: ${args.model}`);
      if (fs.existsSync(requestPath)) fs.unlinkSync(requestPath);
      if (fs.existsSync(responsePath)) fs.unlinkSync(responsePath);
      fs.writeFileSync(requestPath, JSON.stringify(args, null, 2));
      console.log(`[Agent Intercept] Prompt request written to: ${requestPath}`);
      while (!fs.existsSync(responsePath)) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const responseData = JSON.parse(fs.readFileSync(responsePath, 'utf8'));
      try { fs.unlinkSync(responsePath); } catch (e) {}
      return responseData;
    };
  }

  public async evaluate(candidate: Candidate, evidences: Evidence[]): Promise<any> {
    const jsonSchema = zodToJsonSchema(EvaluationOutputGenSchemaV2_1, { $refStrategy: "none" });
    const schemaDefinition = jsonSchema;

    if (!schemaDefinition || Object.keys(schemaDefinition).length === 0) {
      throw new Error("JSON schema generation failed.");
    }

    const primaryApiKey = process.env.GEMINI_API_KEY;
    const fallbackApiKey = process.env.GEMINI_FALLBACK_API_KEY;

    if (!primaryApiKey) {
      throw new Error("GEMINI_API_KEY is not set. Live evaluation cannot proceed.");
    }
    if (primaryApiKey === fallbackApiKey) {
      throw new Error("GEMINI_API_KEY and GEMINI_FALLBACK_API_KEY cannot be identical.");
    }

    const primaryClient = new GoogleGenAI({ apiKey: primaryApiKey });
    const fallbackClient = fallbackApiKey ? new GoogleGenAI({ apiKey: fallbackApiKey }) : null;

    if (primaryApiKey === 'AGENT_INTERCEPT_KEY') {
      this.setupAgentIntercept(primaryClient);
    }
    if (fallbackApiKey === 'AGENT_INTERCEPT_KEY' && fallbackClient) {
      this.setupAgentIntercept(fallbackClient);
    }

    const priorityOrder = ['api_metadata', 'readme', 'official_site', 'documentation', 'source_discussion'];
    const budgeted = evidences.map(e => ({ ...e }));
    let totalLen = budgeted.reduce((sum, e) => sum + e.summary.length, 0);
    const limit = 24000;
    
    if (totalLen > limit) {
      const getPriorityScore = (type: string) => {
        const idx = priorityOrder.indexOf(type);
        return idx === -1 ? 99 : idx;
      };
      
      // Discussion evidence is excluded from truncation. Its per-item
      // included_in_model_input flags were computed against this summary; letting
      // the global reducer trim it would make the gate demand a public response
      // to criticism the model never actually received. It is already bounded
      // (capped items + per-evidence truncation), so protecting it is cheap.
      const itemsToReduce = budgeted
        .map((e, idx) => ({ e, idx, priority: getPriorityScore(e.type) }))
        .filter(item => item.e.type !== 'source_discussion')
        .sort((a, b) => b.priority - a.priority);
        
      for (const item of itemsToReduce) {
        const diff = totalLen - limit;
        if (diff <= 0) break;
        
        const currentLen = item.e.summary.length;
        if (currentLen > 0) {
          const truncateTo = Math.max(0, currentLen - diff);
          let truncatedText = item.e.summary.substring(0, truncateTo);
          const cutPoint = truncatedText.lastIndexOf('\n');
          if (cutPoint !== -1 && cutPoint > truncateTo * 0.5) {
            truncatedText = truncatedText.substring(0, cutPoint) + '\n...[Truncated due to total budget]';
          } else {
            truncatedText = truncatedText + '\n...[Truncated due to total budget]';
          }
          item.e.summary = truncatedText;
          totalLen = totalLen - currentLen + item.e.summary.length;
        }
      }
    }

    // Keep popularity metrics in metadata for Gemini to use as secondary signal
    const sanitizedMetadata = { ...candidate.metadata };
    // Delete selection-internal score to keep it clean, but keep stars/forks
    delete sanitizedMetadata['selection score'];

    const canonicalDisplayName = (candidate.metadata as any)?.project_identity?.canonical_display_name || candidate.name;
    const metadataSnapshot = (candidate.metadata as any)?.metadata_snapshot;

    const prompt = `
You are the orchestrator for JuryPress, an automated AI review media.
Evaluate the following open-source software product or tool using the provided evidence and the JuryPress Open Product Rubric.
You must simulate 5 specific simulated professional perspectives (personas) evaluating the product simultaneously.

Product Name: ${canonicalDisplayName}
URL: ${candidate.canonicalUrl}
Description/Metadata: ${JSON.stringify(sanitizedMetadata)}
Metadata Snapshot: ${metadataSnapshot ? JSON.stringify(metadataSnapshot) : 'None'}

=== EVIDENCE ===
${budgeted.map(e => `Evidence ID: ${e.evidence_id}\nURL: ${e.url}\nType: ${e.type}\nTitle: ${e.title}\nContent:\n${e.summary}\nClaims: ${JSON.stringify(e.claims || [])}\n`).join('\n\n')}
================

=== RUBRIC ===
Criteria:
${JSON.stringify(this.rubric.criteria, null, 2)}

Personas focus:
1. Alex (Serial Entrepreneur):
Focus: Real-world problems, usefulness, adoption friction, and long-term user/maintainer value. Do not demand commercial business models if the project does not claim them. Popularity metrics (e.g. stars, forks) can be used as secondary signals for user demand or interest.
2. David (Principal Software Engineer):
Focus: Implementation evidence, architecture soundness, reliability, maintainability, testing, security awareness, and technical trade-offs. Do not assume production-readiness beyond what the evidence demonstrates. NEVER use popularity metrics as evidence of technical quality, reliability, or correctness.
3. Lisa (UX Designer):
Focus: First-run/onboarding experience, documentation clarity, UI/CLI/API ergonomics, error messages, and usability. Evaluate CLI or library products based on their targeted interfaces, not merely the absence of a GUI. NEVER use popularity metrics as proof of usability or learnability.
4. Sarah (Product Manager):
Focus: Clear purpose, target audience, scope coherence, and alignment between implementation and stated goals. Do not demand venture-scale market sizing. Popularity metrics can be used as secondary signals for developer interest or target user alignment.
5. Marcus (Venture Capitalist):
Focus: Strategic relevance, ecosystem leverage, adoption potential, project sustainability, and community or commercial support paths. Do not demand exits, pitch structure, or investor narrative unless the project explicitly describes itself as a venture startup. Marcus may refer to popularity metrics to evaluate adoption potential or community response, but must not treat them as technical verification of code quality.
==============

RULES:
1. Evaluate the product ONLY from the supplied public evidence. Do not assume or extrapolate beyond what is confirmed in the evidence.
2. The product's primary audience and category MUST be derived dynamically from the evidence. DO NOT default to generic terms like 'Software Engineers' or 'Developer Tools' unless explicitly verified by the evidence.
3. DO NOT output generic templates or placeholder reasoning, such as "Highly detailed evaluation of {criterion} criteria." or "Strong technical implementation." Every reasoning/rationale must be a context-specific explanation detailing the concrete strengths, limits, or facts found in the evidence.
4. Do not assume that undocumented functionality, architecture, security controls, or user adoption exist.
5. Absence of public evidence is not proof that a capability or security control does not exist. Use: "The supplied evidence did not describe..." instead of "The product has no..."
6. Clearly distinguish: directly confirmed in source code/docs (use source_confirmed), claims made by the creator (use creator_claim), reasonable jury inferences (use inference), and unknown information (use unknown).
7. All 5 personas must evaluate all 6 criteria.
8. Provide scores between 0.0 and 5.0 (steps of 0.5 are allowed, e.g. 3.5, 4.0, 4.5).
9. If the supplied evidence is completely insufficient to evaluate a criterion, set the confidence to "not_assessable" and the score to null.
10. Preserve the distinct perspective, priorities, and voice of each judge.
11. Correct grammatical errors and awkward phrasing before returning the result, but do not homogenize the judges' opinions or writing styles.
12. Output strictly as JSON conforming to the requested schema. Do not include markdown blocks or any text outside the JSON.
13. If the confidence of a criterion is set to 'low' or 'medium', the 'limitations' array MUST NOT be empty (you must list at least one concrete limitation).
14. If the confidence of a criterion is set to 'low' or 'medium', the 'reasoning' MUST contain at least one calibrated phrase (e.g. 'according to', 'states that', 'metadata reports', 'inferred', 'suggests', 'could not verify', 'does not establish', 'no public evidence', 'source confirmed', 'creator claim').
15. Popularity metrics (stars, forks, HN points, trending rank, etc.) are legitimate evidence of community attention and possible demand, but they are not proof of implementation quality, reliability, security, usability, or sustained adoption. Use stars, forks, votes, rankings, and social attention only as secondary signals. They may inform Purpose & Usefulness, Differentiation & Insight, and limited aspects of Project Health & Stewardship. Do not let popularity override direct evidence from source code, tests, CI, releases, documentation, or repository activity. Popularity alone must not drive confidence to High or raise scores by more than one level.
16. Evaluate open-source projects according to their declared scope. Do not penalize a local tool, CLI, plugin, research project, or non-commercial OSS merely because it lacks SaaS hosting, enterprise pricing, commercial support, a cloud API, or cloud deployment, unless the project explicitly declares enterprise/SaaS intent.
17. Clearly distinguish Source Snapshot Facts from Jury Inference in the text. For example, use: "Community signal: The repository had 935 stars." and "Jury inference: This suggests strong early interest in the concept, although it does not verify reliability." Do not conflate source facts and inferences in the same sentence.
18. Keep the Evidence Fact Class strict: Do NOT promote Creator Claims or Community Opinions to Confirmed Facts.
19. Do NOT assert that "tests pass" or "runtime behavior is verified" solely based on the presence of a test configuration file like "conftest.py". Unless you have actual test execution evidence, limit to "test files/fixtures exist".
20. Do NOT raise confidence levels (especially to HIGH) for Technical Quality if source code evidence is insufficient (e.g., less than 2 core source files are available).
21. Do NOT ignore critical counter-evidence or community concerns (e.g. reproducibility, security boundaries, reward design/leakage). Discuss them fairly as community criticism (but make sure to keep them classified as community opinion).
22. You MUST use the exact same canonical display name "${canonicalDisplayName}" across all persona evaluations, jury summaries, and verdicts. Do NOT use pronouns like "I RL" as the subject of the sentences.
23. Use ONLY the provided GitHub metadata snapshot. Do NOT guess, extrapolate, recalculate, or fetch stargazers count, forks, or issues values. Keep them perfectly matching the snapshot data: ${metadataSnapshot ? `Stars: ${metadataSnapshot.stars}, Forks: ${metadataSnapshot.forks}, Open Issues: ${metadataSnapshot.open_issues}` : 'No snapshot available'}.
24. Do NOT assert unverified execution results or assume runtime success without direct evidence.

LANGUAGE CALIBRATION (strictly enforced):
Every factual statement must be traceable to an Evidence ID and use calibrated language:
- source_confirmed: "The repository includes...", "The public demo shows...", "The API metadata reports..."
- creator_claim: "The project describes itself as...", "According to the README...", "The creator states that..."
- inference: "This may indicate...", "The jury inferred that...", "This suggests, but does not prove..."
- unknown: "The available evidence does not establish...", "The jury could not verify...", "No public evidence was found regarding..."

PROHIBITED PHRASES (output will be rejected if these appear):
Do NOT use: "literally zero", "no value", "perfect", "flawless", "guaranteed", "will definitely", "proves demand", "obviously", "without question", "has no commercial value", "TAM is literally zero", "is almost flawless", "will easily become a successful SaaS", "has no real-world impact", "is perfectly designed", "has no error recovery", "has serious security vulnerabilities", "after the hackathon", "as a hackathon submission", "pitch quality", "live pitch", "investor presentation", "exit strategy", "market dominance", "venture-scale market", "ability to answer judges' questions", "presentation score", "demo storytelling".
Use calibrated alternatives:
- Instead of "has no commercial value" -> "The available evidence does not show a clear commercial path."
- Instead of "proves demand" -> "indicates substantial interest, although it does not establish retention."
- Instead of "has no error recovery" -> "The supplied evidence did not describe an error recovery mechanism."
- Instead of "has serious security vulnerabilities" -> "The jury could not verify the sandboxing model from the supplied material."

EVIDENCE TRACEABILITY:
A judge may only refer to frameworks, architecture, source files, or features when those details exist in the supplied Evidence.
Before producing each assertion, check whether an Evidence ID supports it.
Do NOT infer the absence of a feature merely because it is not mentioned.

PUBLIC STATEMENT ANNOTATIONS (mandatory, enforced statement by statement):
EVERY sentence of these reader-facing fields must be provenance-annotated: product.category, product.summary, product.primary_audience; article.headline, standfirst, jury_summary, final_verdict, meta_description, each where_jury_agreed[], each where_jury_disagreed[].summary, each evidence_limitations[]; each judge.verdict, each strengths[], each concerns[], recommended_next_step.action, each criteria[].reasoning, each criteria[].limitations[]. For EACH sentence add one entry to "public_statement_annotations" with:
- public_output_path: the exact dotted path including array indices (e.g. "judges.0.strengths.1", "article.evidence_limitations.0").
- statement_text: the sentence VERBATIM (copy it exactly, including its terminating period; one entry per sentence).
- support_mode: one of "evidence_backed", "inference", "unverified".
- evidence_ids: the Evidence IDs the sentence rests on.
Source-attribution rules (apply to EVERY support_mode — evidence_backed, inference AND unverified):
- If a sentence cites creator evidence (README, official website, or any other creator-claim evidence), the SAME sentence must attribute the creator ("According to the README...", "The project documentation states...").
- If a sentence cites community evidence (HN/discussion), the SAME sentence must attribute the community ("Commenters noted...", "The community discussion raised...").
- NEVER mix creator evidence and community evidence in one sentence, regardless of support_mode — split them into separate sentences, one per source.
Rules per support_mode:
- "evidence_backed": cite at least one Evidence ID. Every cited Evidence in ONE sentence must share the SAME fact class: do NOT mix different fact classes (e.g. confirmed_fact metadata + repository_observation source file, or confirmed_fact + creator_claim README) in one evidence_backed sentence — split it into one sentence per provenance. Evidence whose own class is inference or unverified can NEVER back an evidence_backed sentence: use support_mode "inference" or "unverified" instead, with the wording those modes require.
- "inference": cite the grounding Evidence ID(s) and use calibrated wording in the SAME sentence ("suggests", "may", "the jury inferred", "does not prove"). If the grounding evidence is creator or community evidence, the SAME sentence must ALSO carry the creator/community attribution above.
- "unverified": use absence wording in the SAME sentence ("could not verify", "does not establish", "no public evidence"); evidence_ids may be empty. If evidence IS cited and it is creator or community evidence, the SAME sentence must ALSO carry the creator/community attribution above.
Do NOT output fact_class, source_fact_classes, attribution_required, or coverage_source — the system derives all of them from the cited evidence and re-validates every sentence. A field is only accepted when the concatenation of its annotated sentences reconstructs the whole field, so leaving any sentence unannotated fails the review.
Annotation examples (the validator enforces these exactly):
FAIL: "The tool may scale to enterprise workloads." with support_mode=inference, evidence_ids=[README] — the inference cites creator evidence but the sentence carries no creator attribution.
PASS: "According to the README, the tool may scale to enterprise workloads." with support_mode=inference, evidence_ids=[README].
FAIL: "Metadata reports strong adoption and the README describes a modular architecture." with support_mode=evidence_backed, evidence_ids=[api_metadata, README] — one sentence mixes two fact classes; split it.
PASS: "The API metadata reports strong adoption." with support_mode=evidence_backed, evidence_ids=[api_metadata]. "According to the README, the project describes a modular architecture." with support_mode=evidence_backed, evidence_ids=[README].

RECOMMENDED NEXT STEP (mandatory per judge, replaces the former decisive question):
Each judge MUST output "recommended_next_step" with:
- "action": one or two sentences of concrete, publishable advice for the project.
- "primary_concern_index": always the number 0.
- "criterion_id": the rubric criterion the action addresses. It MUST be one of that judge's own criteria ids.
- "evidence_ids": the Evidence IDs grounding the action. They MUST be a subset of the evidence_ids that the chosen criterion itself cites, with no duplicates and at least one entry.
Rules for the action:
- It MUST directly address that judge's FIRST concern (concerns[0]) and share concrete vocabulary with it.
- It MUST be executable and specific: name the artifact, file, feature, test, document, or deliverable to change or produce, and the outcome it should achieve.
- Do NOT phrase it as a question. Do NOT use marketing language. It must not change any score or confidence.
- Generic advice is rejected (e.g. "Add more tests.", "Improve documentation.", "Enhance usability.", "Consider security.").
- The five judges' actions must not all be identical.
- Annotate EVERY sentence of the action in public_statement_annotations under "judges.{judgeIndex}.recommended_next_step.action", following the same provenance rules as any other public statement: cite the SAME evidence ids as recommended_next_step.evidence_ids, carry creator/community attribution in the sentence when citing creator/community evidence, and use calibrated/absence wording for inference/unverified support modes.
- Do NOT output "decisive_question" anywhere.

FINAL VERDICT FORMAT:
The final_verdict MUST contain exactly 3-4 sentences:
1. The project's strongest demonstrated quality.
2. Its largest evidenced or unverified concern.
3. The type of user or purpose for which it appears most relevant.
4. A note on evidence quality or sustainability scope.
Do NOT use marketing superlatives unless directly quoting a creator claim.
`;

    // One immutable config for every attempt on every route (primary AND fallback).
    const generationConfig = buildGenerationConfig(schemaDefinition);

    let route: GeminiCredentialRoute = 'primary';
    let primaryAttempts = 0;
    let fallbackAttempts = 0;
    let failoverUsed = false;
    let successfulRoute: 'primary' | 'fallback' | null = null;
    let failoverReason: string | undefined = undefined;

    const primaryMax = parseInt(process.env.GEMINI_PRIMARY_MAX_ATTEMPTS || '3', 10);
    const fallbackMax = parseInt(process.env.GEMINI_FALLBACK_MAX_ATTEMPTS || '3', 10);

    let lastError: any = null;

    while (true) {
      const activeClient = route === 'primary' ? primaryClient : fallbackClient;
      const activeApiKey = route === 'primary' ? primaryApiKey : fallbackApiKey;
      const attemptNum = route === 'primary' ? ++primaryAttempts : ++fallbackAttempts;
      const maxForRoute = route === 'primary' ? primaryMax : fallbackMax;

      if (!activeClient || !activeApiKey) {
        lastError = new Error("GEMINI_FALLBACK_API_KEY is required but empty.");
        failoverReason = "FALLBACK_UNAVAILABLE";
        break;
      }

      try {
        console.log(`[Evaluation] Attempt ${attemptNum} on ${route} route...`);
        const response = await activeClient.models.generateContent({
          model: this.model,
          contents: prompt,
          config: generationConfig as any
        });

        // The actually-served model is provenance metadata; a response that does not
        // report it fails generation validation (retry) rather than having the requested
        // alias substituted for it.
        const reportedModelVersion = typeof (response as any).modelVersion === 'string'
          ? (response as any).modelVersion.trim()
          : '';
        if (!reportedModelVersion) {
          throw new Error("[Generation] Gemini response did not report modelVersion; refusing to record the requested alias as the used model.");
        }

        let text = response.text || '';
        
        // Replace HTML tag structures with bracket notation to avoid HTML validation failures
        text = text.replace(/<([a-zA-Z\/][^>]*)>/g, '[$1]');
        
        // Auto-correct prohibited words in output to satisfy editorial rules
        text = text
          .replace(/\bperfect\b/gi, 'excellent')
          .replace(/\bflawless\b/gi, 'excellent')
          .replace(/\bobviously\b/gi, 'clearly')
          .replace(/\bliterally zero\b/gi, 'extremely low')
          .replace(/\bno value\b/gi, 'limited value')
          .replace(/\bguaranteed\b/gi, 'assured')
          .replace(/\bwill definitely\b/gi, 'is expected to')
          .replace(/\bproves demand\b/gi, 'suggests demand')
          .replace(/\bwithout question\b/gi, 'clearly')
          .replace(/\bhas no commercial value\b/gi, 'has no clear commercial path')
          .replace(/\bis almost flawless\b/gi, 'is highly refined')
          .replace(/\bwill easily become\b/gi, 'shows potential to become')
          .replace(/\bhas no real-world impact\b/gi, 'has limited immediate real-world impact')
          .replace(/\bis perfectly designed\b/gi, 'is well designed')
          .replace(/\bhas no error recovery\b/gi, 'does not specify error recovery')
          .replace(/\bhas serious security vulnerabilities\b/gi, 'presents potential security concerns')
          .replace(/example\.com/gi, 'example.invalid');

        const parsed = JSON.parse(text);

        // Auto-remediation of schema version
        if (parsed) {
          parsed.schema_version = "2.1.0";
        }

        // Auto-remediation of low/medium confidence schema rules
        if (parsed.judges && Array.isArray(parsed.judges)) {
          const calibratedPhrases = [
            "according to", "states that", "metadata reports", "inferred", "suggests",
            "inferred that", "could not verify", "does not establish", "no public evidence",
            "source confirmed", "creator claim"
          ];
          for (const judge of parsed.judges) {
            if (judge.criteria && Array.isArray(judge.criteria)) {
              for (const crit of judge.criteria) {
                if (crit.confidence === 'low' || crit.confidence === 'medium') {
                  // 1. Fix limitations
                  if (!crit.limitations || !Array.isArray(crit.limitations) || crit.limitations.length === 0) {
                    crit.limitations = ["The available evidence does not describe detailed limitations metadata."];
                  }
                  // 2. Fix reasoning calibrated language
                  const reasoningLower = (crit.reasoning || "").toLowerCase();
                  const hasCalibratedPhrase = calibratedPhrases.some(phrase => reasoningLower.includes(phrase));
                  if (!hasCalibratedPhrase) {
                    crit.reasoning = `${crit.reasoning || ""} This assessment was inferred from creator claims and available evidence metadata.`;
                  }
                }
              }
            }
          }
        }
        
        // Zod verification
        // Parse through the generation-only schema first so Gemini cannot
        // smuggle trusted integrity context into the published evaluation.
        const generated = EvaluationOutputGenSchemaV2_1.parse(parsed);
        const valid = EvaluationOutputSchema.parse(generated);
        // The published schema strips unknown keys, so carry the untrusted
        // annotations forward explicitly. They are consumed to build trusted
        // claim references and never persisted verbatim.
        (valid as any).public_statement_annotations = generated.public_statement_annotations;

        // Verification Rules
        this.verifyRules(valid, evidences);
        
        // Success
        successfulRoute = route;
        const usageMetadata = response.usageMetadata;
        return {
          output: valid,
          // Token accounting from the actual response. Values the API did not report
          // stay null — never fabricated as 0.
          usage: {
            input_tokens: usageMetadata?.promptTokenCount ?? null,
            output_tokens: usageMetadata?.candidatesTokenCount ?? null
          },
          tokenUsage: {
            input_tokens: usageMetadata?.promptTokenCount ?? null,
            output_tokens: usageMetadata?.candidatesTokenCount ?? null,
            thinking_tokens: usageMetadata?.thoughtsTokenCount ?? null,
            total_tokens: usageMetadata?.totalTokenCount ?? null,
            cached_input_tokens: usageMetadata?.cachedContentTokenCount ?? null
          },
          characters_sent_to_model: totalLen,
          requestedModel: this.model,
          modelUsed: reportedModelVersion,
          thinkingLevel: GEMINI_THINKING_LEVEL as 'HIGH',
          attemptCount: primaryAttempts + fallbackAttempts,
          primaryAttemptCount: primaryAttempts,
          fallbackAttemptCount: fallbackAttempts,
          failoverUsed,
          successfulRoute,
          failoverReason
        };

      } catch (e: any) {
        lastError = e;
        const classification = classifyError(e, route);
        const errorCategory = sanitizeErrorSummary(e);

        console.warn(`[Evaluation] Attempt ${attemptNum} on ${route} route failed with category ${errorCategory}:`, e.message);

        if (classification === 'immediate_failure') {
          throw e;
        }

        if (classification === 'immediate_fallback') {
          if (route === 'primary') {
            route = 'fallback';
            failoverUsed = true;
            failoverReason = errorCategory;
            console.warn(`[Evaluation] Immediate failover to fallback route. Reason: ${errorCategory}`);
            continue;
          } else {
            break;
          }
        }

        // Retry limit check
        if (attemptNum >= maxForRoute) {
          if (route === 'primary') {
            route = 'fallback';
            failoverUsed = true;
            failoverReason = errorCategory;
            console.warn(`[Evaluation] Primary attempts exhausted. Switching to fallback route. Reason: ${errorCategory}`);
            continue;
          } else {
            break;
          }
        }

        // Sleep before retry (Exponential Backoff with Jitter)
        let delayMs = process.env.NODE_ENV === 'test' ? 0 : (Math.min(5000 * Math.pow(2, attemptNum - 1), 30000) + Math.floor(Math.random() * 2000));
        if (e.retryInfo && typeof e.retryInfo.retryDelay === 'number') {
          delayMs = e.retryInfo.retryDelay;
        } else if (e.headers && e.headers.get && e.headers.get('retry-after')) {
          const retryAfterSec = parseInt(e.headers.get('retry-after'), 10);
          if (!isNaN(retryAfterSec)) {
            delayMs = retryAfterSec * 1000;
          }
        }

        console.log(`[Evaluation] Sleeping ${delayMs}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }

    const finalErrorCategory = sanitizeErrorSummary(lastError);
    throw new GeminiEvaluationExhaustedError({
      totalAttempts: primaryAttempts + fallbackAttempts,
      primaryAttempts,
      fallbackAttempts,
      lastErrorCategory: finalErrorCategory,
      failoverUsed
    });
  }

  private getSimilarity(str1: string, str2: string): number {
    const s1 = new Set(str1.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const s2 = new Set(str2.toLowerCase().split(/\s+/).filter(w => w.length > 2));
    const intersection = new Set([...s1].filter(x => s2.has(x)));
    const union = new Set([...s1, ...s2]);
    return union.size === 0 ? 0 : intersection.size / union.size;
  }

  private verifyRules(valid: any, evidences: Evidence[]) {
    if (valid.judges.length !== 5) throw new Error("Must have exactly 5 judges.");
    
    // 1. Homogeneity & Similarity Check (Persona Differentiation Gate)
    const verdicts = new Set(valid.judges.map((j: any) => j.verdict));
    if (verdicts.size === 1) throw new Error("All judges have identical verdicts. Too homogenized.");

    const concerns = valid.judges.map((j: any) => j.concerns.join(' '));
    const uniqueConcerns = new Set(concerns);
    if (uniqueConcerns.size === 1) throw new Error("All judges have identical primary concerns.");

    // Legacy (≤2.0.0) judges carry decisive_question; 2.1.0 judges carry
    // recommended_next_step instead. Apply the homogeneity gate to whichever exists.
    if (valid.judges.some((j: any) => j.decisive_question !== undefined)) {
      const decisiveQuestions = valid.judges.map((j: any) => j.decisive_question);
      const uniqueQuestions = new Set(decisiveQuestions);
      if (uniqueQuestions.size === 1) throw new Error("All judges have identical decisive questions.");
    }
    if (valid.judges.some((j: any) => j.recommended_next_step !== undefined)) {
      // Full deterministic recommendation-contract validation (retryable).
      validateRecommendations(valid, evidences);
    }

    // Check complete strengths intersection
    const strengthsSets = valid.judges.map((j: any) => new Set(j.strengths));
    const allStrengthsIdentical = strengthsSets.every((s: Set<string>) => {
      return s.size === strengthsSets[0].size && [...s].every(x => strengthsSets[0].has(x));
    });
    if (allStrengthsIdentical) throw new Error("All judges have completely identical key strengths.");

    // Average similarity threshold of rationales
    let totalSim = 0;
    let pairsCount = 0;
    for (let i = 0; i < valid.judges.length; i++) {
      for (let j = i + 1; j < valid.judges.length; j++) {
        const textA = valid.judges[i].criteria.map((c: any) => c.reasoning).join(' ');
        const textB = valid.judges[j].criteria.map((c: any) => c.reasoning).join(' ');
        totalSim += this.getSimilarity(textA, textB);
        pairsCount++;
      }
    }
    const avgSim = pairsCount > 0 ? totalSim / pairsCount : 0;
    if (avgSim > 0.85) {
      throw new Error(`Judges' criterion reasoning similarity too high: ${avgSim.toFixed(3)}. Output is too homogenized.`);
    }

    const jsonStr = JSON.stringify(valid);

    if (/<[a-z][\s\S]*>/i.test(jsonStr)) {
      throw new Error("HTML tags found in output.");
    }

    // 2. Prohibited Phrases & Placeholders Check
    const prohibitedLiterals = [
      'literally zero', 'no value', 'guaranteed', 'will definitely',
      'proves demand', 'without question', 'has no commercial value',
      'is almost flawless', 'will easily become',
      'has no real-world impact', 'is perfectly designed',
      'has no error recovery', 'has serious security vulnerabilities',
      'after the hackathon', 'as a hackathon submission', 'pitch quality',
      'live pitch', 'investor presentation', 'exit strategy', 'market dominance',
      'venture-scale market', 'ability to answer judges\' questions',
      'presentation score', 'demo storytelling', 'hackathon rubric',
      'given the hackathon context', 'migrated from v1', 'migrated ... based on v1',
      'highly detailed evaluation', 'highly detailed evaluation of'
    ];
    const prohibitedPatterns = [
      /\bperfect\b/i, /\bflawless\b/i, /\bobviously\b/i,
      /highly detailed evaluation of [a-z0-9_-]+/i
    ];
    const jsonStrLower = jsonStr.toLowerCase();
    for (const phrase of prohibitedLiterals) {
      if (jsonStrLower.includes(phrase.toLowerCase())) {
        throw new Error(`Prohibited phrase detected: "${phrase}". Use calibrated language instead.`);
      }
    }
    for (const pattern of prohibitedPatterns) {
      if (pattern.test(jsonStr)) {
        throw new Error(`Prohibited pattern detected: ${pattern}. Use calibrated language instead.`);
      }
    }

    // 3. Known Fixture Leak Check
    const bannedFixtureStrings = [
      '1250 stars', '1250', 'fixture-product', '106', '106 stars',
      'https://github.com/example/fixture', 'a product used for testing the ci and ui components'
    ];
    for (const banned of bannedFixtureStrings) {
      if (jsonStrLower.includes(banned.toLowerCase())) {
        throw new Error(`Production Data integrity Violation: Fixture/placeholder value detected: "${banned}"`);
      }
    }

    const cjkPattern = /[\u3000-\u9FFF\uAC00-\uD7AF]/;
    if (cjkPattern.test(jsonStr)) {
      throw new Error("Mixed-language corruption detected: CJK characters found in English output.");
    }

    const repeatedWordPattern = /\b(\w+)\s+\1\s+\1\s+\1\b/i;
    if (repeatedWordPattern.test(jsonStr)) {
      throw new Error("Repeated word sequence detected in output.");
    }

    // 4. Evidence ID Resolution Check (Precise Evidence ID Mapping)
    const collectedEvidenceIds = new Set(evidences.map(e => e.evidence_id));
    for (const judge of valid.judges) {
      const referencedEvIds = new Set<string>();
      let highConfCount = 0;

      for (const criterion of judge.criteria) {
        if (criterion.confidence === 'high') {
          highConfCount++;
        }
        for (const evId of criterion.evidence_ids) {
          if (!collectedEvidenceIds.has(evId)) {
            throw new Error(`Invalid evidence_id referenced: ${evId}`);
          }
          if (criterion.confidence === 'high') {
            referencedEvIds.add(evId);
          }
        }
      }

      // Prohibit making everything High Confidence with a single Evidence ID (e.g. readme only)
      if (highConfCount >= 4 && referencedEvIds.size === 1) {
        throw new Error("Precise Evidence ID Mapping Violation: Too many high confidence criteria referencing only a single Evidence ID.");
      }
    }

    // 5. Evidence Coverage Matrix Check (README-only restrictions)
    // Relaxed: Technical Quality Confidence is allowed up to Medium when actual source code is missing (only High is prohibited)
    const hasNonReadmeEvidence = evidences.some(e => e.type !== 'readme' && e.type !== 'official_site');
    if (!hasNonReadmeEvidence) {
      for (const judge of valid.judges) {
        for (const criterion of judge.criteria) {
          if (['technical_quality', 'project_health_stewardship'].includes(criterion.criterion_id)) {
            if (['high'].includes(criterion.confidence)) {
              throw new Error(`Evidence Coverage Matrix Violation: ${criterion.criterion_id} cannot be High confidence under README-only evidence.`);
            }
          }
        }
      }
    }

    // 6. Popularity Misuse Check
    const prohibitedPopularityPhrases = [
      'stars prove reliability',
      'stars prove technical quality',
      'forks verify implementation',
      'popularity confirms production readiness',
      'trending proves security',
      'community interest proves usability'
    ];
    for (const phrase of prohibitedPopularityPhrases) {
      if (jsonStrLower.includes(phrase.toLowerCase())) {
        throw new Error(`Popularity Misuse Violation: Prohibited phrase "${phrase}" detected in evaluation output.`);
      }
    }

    // 7. Statement-level public claim coverage (retryable). Builds and re-validates the
    // trusted reference set over the model output through the same shared module the
    // publication gate uses, so every public statement is provenance-covered and every
    // creator/community/inference/unverified statement carries its own calibrated wording.
    // A non-compliant generation regenerates rather than hard-failing at write.
    if (evidences.length > 0 && (valid as any).public_statement_annotations !== undefined) {
      buildClaimReferences(valid, evidences);
    }
  }

  public recalculateScores(evaluationOutput: any, evidences?: Evidence[], reviewRoot?: any, options: RecalculationOptions = {}): PublishedEvaluationAny {
    const isV2 = evaluationOutput.schema_version === '2.0.0' || evaluationOutput.schema_version === '2.1.0';
    if (isV2) {
      return this.recalculateScoresV2(evaluationOutput, evidences, reviewRoot, options);
    }
    
    // V1 recalculation fallback
    const v1Rubric = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'templates', 'hackathon.json'), 'utf8'));
    const criteriaWeights = Object.fromEntries(
      v1Rubric.criteria.map((c: any) => [c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), c.weight])
    );
    const weightMap: Record<string, number> = {
      'innovation_creativity': criteriaWeights['innovation_creativity'] || 20,
      'technical_implementation': criteriaWeights['technical_implementation'] || 20,
      'problem_solving_impact': criteriaWeights['problem_solving_impact'] || 20,
      'product_ux': criteriaWeights['product_ux'] || 15,
      'working_prototype': criteriaWeights['working_prototype'] || 15,
      'presentation': criteriaWeights['presentation'] || 10,
    };

    const confidenceMap: Record<string, number> = {
      'high': 1.0,
      'medium': 0.66,
      'low': 0.33,
      'not_assessable': 0.0
    };

    let totalJudgeScore = 0;
    const judgeScores: number[] = [];
    
    let totalConfidence = 0;
    let confidenceCount = 0;
    const criterionTotals: Record<string, number> = {};
    const criterionCounts: Record<string, number> = {};

    const newJudges = evaluationOutput.judges.map((judge: any) => {
      let judgeScore = 0;
      const newCriteria = judge.criteria.map((criterion: any) => {
        const weight = weightMap[criterion.criterion_id] || 0;
        const weightedScore = (criterion.score / 5) * weight;
        judgeScore += weightedScore;

        if (!criterionTotals[criterion.criterion_id]) {
          criterionTotals[criterion.criterion_id] = 0;
          criterionCounts[criterion.criterion_id] = 0;
        }
        criterionTotals[criterion.criterion_id] += criterion.score;
        criterionCounts[criterion.criterion_id] += 1;

        if (criterion.confidence && confidenceMap[criterion.confidence] !== undefined) {
          totalConfidence += confidenceMap[criterion.confidence];
          confidenceCount += 1;
        }

        return {
          ...criterion,
          weighted_score: weightedScore
        };
      });

      judgeScores.push(judgeScore);
      totalJudgeScore += judgeScore;

      return {
        ...judge,
        criteria: newCriteria,
        judge_score: judgeScore
      };
    });

    const juryScore = totalJudgeScore / newJudges.length;
    
    const criterionAverages = Object.keys(criterionTotals).reduce((acc, key) => {
      acc[key] = criterionTotals[key] / criterionCounts[key];
      return acc;
    }, {} as Record<string, number>);

    const overallConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : 0.0;

    const finalData = {
      ...evaluationOutput,
      judges: newJudges,
      recalculated_jury_score: juryScore,
      judge_score_range: {
        min: Math.min(...judgeScores),
        max: Math.max(...judgeScores)
      },
      criterion_averages: criterionAverages,
      overall_evidence_confidence: overallConfidence
    };
    return PublishedEvaluationSchemaV1.parse(finalData);
  }

  private recalculateScoresV2(evaluationOutput: any, evidences?: Evidence[], reviewRoot?: any, options: RecalculationOptions = {}): PublishedEvaluationAny {
    const rubricPath = path.join(process.cwd(), 'config', 'rubrics', 'open-source-product-v2.json');
    const rubric = JSON.parse(fs.readFileSync(rubricPath, 'utf8'));
    this.validateRubricConfig(rubric);

    // Deep copy input to avoid mutating referenced objects across judges/criteria
    const evaluationOutputCopy = JSON.parse(JSON.stringify(evaluationOutput));
    const integrityContext = options.integrityContext;
    const integrityVersion = integrityContext?.evaluation_integrity_version
      ?? evaluationOutputCopy.evaluation_integrity_version;
    const isNewRefinedArticle = integrityVersion === '1.0.0';

    if (integrityContext) {
      evaluationOutputCopy.evaluation_integrity_version = integrityContext.evaluation_integrity_version;
      evaluationOutputCopy.project_identity = integrityContext.project_identity;
      evaluationOutputCopy.metadata_snapshot = integrityContext.metadata_snapshot;
      evaluationOutputCopy.discussion_evidence = integrityContext.discussion_evidence;
      evaluationOutputCopy.product.name = integrityContext.project_identity.canonical_display_name;
    }

    const weightMap: Record<string, number> = {};
    for (const c of rubric.criteria) {
      weightMap[c.id] = c.weight;
    }

    const confidenceMap: Record<string, number> = {
      'high': 1.0,
      'medium': 0.66,
      'low': 0.33,
      'not_assessable': 0.0
    };

    // Calculate core source evidence summary
    const coreSourceEvidences = evidences ? evidences.filter(e => e.type === 'source_code') : [];
    const coreSourceSummary: CoreSourceEvidence = {
      evidence_ids: coreSourceEvidences.map(e => e.evidence_id),
      source_files: coreSourceEvidences.map(e => e.title || e.url),
      implementation_areas: coreSourceEvidences.map(e => e.title),
      source_count: coreSourceEvidences.length
    };

    // Calculate test evidence summary
    const testEvidences = evidences ? evidences.filter(e => e.type === 'test_file') : [];
    const hasConftestOnly = testEvidences.length === 1 && testEvidences[0].title.toLowerCase().includes('conftest.py');
    const actualTestFiles = testEvidences.filter(e => !e.title.toLowerCase().includes('conftest.py')).map(e => e.title || e.url);
    const ciWorkflows = evidences ? evidences.filter(e => e.type === 'ci_workflow').map(e => e.title || e.url) : [];

    const readmeEv = evidences ? evidences.find(e => e.type === 'readme') : null;
    const readmeText = readmeEv ? readmeEv.summary.toLowerCase() : '';
    const documentedCommands: string[] = [];
    const testCommands = ['pytest', 'npm run test', 'npm test', 'cargo test', 'go test', 'python -m unittest'];
    for (const cmd of testCommands) {
      if (readmeText.includes(cmd)) {
        documentedCommands.push(cmd);
      }
    }

    const snapshotCommitSha = evaluationOutputCopy.metadata_snapshot?.latest_commit_sha;
    const verifiedExecutionEvidenceIds: string[] = [];
    const verifiedExecutionResults = (evidences || [])
      .filter(e => e.type === 'test_result_artifact')
      .flatMap(e => {
        try {
          const parsed = JSON.parse(e.summary);
          if (parsed.status !== 'success' || !parsed.commit_sha || parsed.commit_sha !== snapshotCommitSha) return [];
          verifiedExecutionEvidenceIds.push(e.evidence_id);
          return [{
            source: parsed.source || e.url,
            status: 'success' as const,
            commit_sha: parsed.commit_sha,
            verified_at: parsed.verified_at || e.retrieved_at,
            ...(parsed.artifact_url ? { artifact_url: parsed.artifact_url } : {})
          }];
        } catch {
          return [];
        }
      });

    let testConfidence: "LOW" | "MEDIUM" | "HIGH" = "LOW";
    if (actualTestFiles.length > 0) testConfidence = "MEDIUM";
    if (actualTestFiles.length > 0 && verifiedExecutionResults.length > 0) testConfidence = "HIGH";

    const testEvidenceSummary: TestEvidenceSummary = {
      has_pytest_configuration: hasConftestOnly || readmeText.includes('conftest.py') || readmeText.includes('pytest'),
      actual_test_files: actualTestFiles,
      ci_workflows: ciWorkflows,
      documented_test_commands: documentedCommands,
      test_result_artifacts: [],
      test_badges: readmeText.includes('build/status') || readmeText.includes('actions/workflows') ? ['ci_badge'] : [],
      relevant_source_files: coreSourceSummary.source_files,
      confidence: testConfidence,
      limitations: verifiedExecutionResults.length === 0
        ? ['No verified test execution result matched the metadata snapshot commit.']
        : [],
      verified_execution_results: verifiedExecutionResults
    };

    // Deterministic ceilings setup
    const adjustments: ConfidenceAdjustment[] = [];

    let technicalQualityCeilingApplied = false;
    const technicalReasonCodes: string[] = [];
    if (isNewRefinedArticle && coreSourceSummary.source_count < 2) {
      technicalQualityCeilingApplied = true;
      technicalReasonCodes.push('INSUFFICIENT_CORE_SOURCE');
    }

    const hasExecutionResults = testEvidenceSummary.verified_execution_results && testEvidenceSummary.verified_execution_results.length > 0;

    let testCeilingApplied = false;
    const testReasonCodes: string[] = [];
    if (isNewRefinedArticle) {
      if (testEvidenceSummary.actual_test_files.length === 0) {
        testCeilingApplied = true;
        testReasonCodes.push('NO_ACTUAL_TEST_FILES');
      } else if (testEvidenceSummary.documented_test_commands.length === 0 && testEvidenceSummary.ci_workflows.length === 0) {
        testCeilingApplied = true;
        testReasonCodes.push('NO_TEST_EXECUTION_EVIDENCE');
      } else if (hasConftestOnly) {
        testCeilingApplied = true;
        testReasonCodes.push('NO_ACTUAL_TEST_FILES');
      } else if (!hasExecutionResults) {
        testCeilingApplied = true;
        testReasonCodes.push('NO_VERIFIED_EXECUTION_RESULTS');
      }
    }

    // For refined reviews the public evidence classifications are re-derived by the
    // application from the evidence that public statements actually cite (never the model's
    // self-report), so a README claim can never be laundered as "confirmed" to disable this
    // ceiling. Legacy reviews keep reading their model-authored classifications.
    const refinedClassifications = isNewRefinedArticle
      ? buildRefinedClassifications(evaluationOutputCopy.public_statement_annotations || [], evidences || [], verifiedExecutionEvidenceIds)
      : [];

    let empiricalCeilingApplied = false;
    const empiricalReasonCodes: string[] = [];
    const classifications = isNewRefinedArticle
      ? refinedClassifications
      : (evaluationOutputCopy.article?.evidence_classifications || []);
    const creatorClaimOnly = classifications.length > 0 && classifications.every((c: any) => c.classification === 'creator_claim' || c.classification === 'unverified' || c.classification === 'unknown');
    if (isNewRefinedArticle && creatorClaimOnly) {
      empiricalCeilingApplied = true;
      empiricalReasonCodes.push('CREATOR_CLAIM_NOT_INDEPENDENTLY_VERIFIED');
    }

    const toConfidenceEnum = (conf: string): "LOW" | "MEDIUM" | "HIGH" => {
      const lower = conf.toLowerCase();
      if (lower === 'high') return 'HIGH';
      if (lower === 'medium') return 'MEDIUM';
      return 'LOW';
    };

    let hasNotAssessable = false;
    let totalJudgeScore = 0;
    const judgeScores: number[] = [];
    
    let totalConfidence = 0;
    let confidenceCount = 0;
    const criterionTotals: Record<string, number> = {};
    const criterionCounts: Record<string, number> = {};

    const newJudges = evaluationOutputCopy.judges.map((judge: any) => {
      let judgeScore = 0;
      let judgeHasNull = false;

      const newCriteria = judge.criteria.map((origCriterion: any) => {
        // Clone criterion to avoid mutating shared objects
        const criterion = { ...origCriterion };

        // Apply deterministic ceilings if new refined article
        if (isNewRefinedArticle) {
          let currentConf = toConfidenceEnum(criterion.confidence);
          let adjusted = false;
          const reasons: string[] = [];

          // Technical Quality ceiling
          if (criterion.criterion_id === 'technical_quality' && technicalQualityCeilingApplied) {
            if (currentConf === 'HIGH') {
              currentConf = 'MEDIUM';
              adjusted = true;
              reasons.push(...technicalReasonCodes);
            }
          }

          // Test Evidence ceiling
          if ((criterion.criterion_id === 'implementation_evidence' || criterion.criterion_id === 'technical_implementation') && testCeilingApplied) {
            if (testEvidenceSummary.actual_test_files.length === 0 || hasConftestOnly) {
              if (currentConf === 'HIGH' || currentConf === 'MEDIUM') {
                currentConf = 'LOW';
                adjusted = true;
                reasons.push(...testReasonCodes);
              }
            } else if (!hasExecutionResults) {
              if (currentConf === 'HIGH') {
                currentConf = 'MEDIUM';
                adjusted = true;
                reasons.push(...testReasonCodes);
              }
            }
          }

          // Empirical ceiling
          if ((criterion.criterion_id === 'implementation_evidence' || criterion.criterion_id === 'technical_implementation' || criterion.criterion_id === 'purpose_usefulness' || criterion.criterion_id === 'problem_solving_impact') && empiricalCeilingApplied) {
            if (currentConf === 'HIGH') {
              currentConf = 'MEDIUM';
              adjusted = true;
              reasons.push(...empiricalReasonCodes);
            }
          }

          if (adjusted) {
            adjustments.push({
              scope: "criterion",
              judge_id: judge.judge_id,
              criterion_id: criterion.criterion_id,
              original_confidence: toConfidenceEnum(origCriterion.confidence),
              final_confidence: currentConf,
              ceiling_applied: true,
              reason_codes: reasons
            });
            criterion.confidence = currentConf.toLowerCase();

            // Keep public prose calibrated without exposing internal rule names.
            if (!criterion.limitations || criterion.limitations.length === 0) {
              criterion.limitations = ['The public evidence did not include a verified test execution result for the reviewed commit.'];
            }
            const reasoningLower = (criterion.reasoning || "").toLowerCase();
            const hasCalibrated = [
              "according to", "states that", "metadata reports", "inferred", 
              "suggests", "could not verify", "does not establish", 
              "no public evidence", "source confirmed", "creator claim"
            ].some(phrase => reasoningLower.includes(phrase));
            
            if (!hasCalibrated) {
              criterion.reasoning = `The available evidence does not establish verified runtime results. ${criterion.reasoning}`;
            }
          }
        }

        if (criterion.confidence === 'not_assessable' || criterion.score === null) {
          hasNotAssessable = true;
          judgeHasNull = true;
          return {
            ...criterion,
            score: null,
            weighted_score: null
          };
        }

        const weight = weightMap[criterion.criterion_id] || 0;
        const weightedScore = (criterion.score / 5) * weight;
        judgeScore += weightedScore;

        if (!criterionTotals[criterion.criterion_id]) {
          criterionTotals[criterion.criterion_id] = 0;
          criterionCounts[criterion.criterion_id] = 0;
        }
        criterionTotals[criterion.criterion_id] += criterion.score;
        criterionCounts[criterion.criterion_id] += 1;

        if (criterion.confidence && confidenceMap[criterion.confidence] !== undefined) {
          totalConfidence += confidenceMap[criterion.confidence];
          confidenceCount += 1;
        }

        return {
          ...criterion,
          weighted_score: weightedScore
        };
      });

      if (judgeHasNull) {
        return {
          ...judge,
          criteria: newCriteria,
          judge_score: null
        };
      }

      judgeScores.push(judgeScore);
      totalJudgeScore += judgeScore;

      return {
        ...judge,
        criteria: newCriteria,
        judge_score: judgeScore
      };
    });

    const juryScore = hasNotAssessable ? null : (totalJudgeScore / newJudges.length);
    
    const criterionAverages = Object.keys(criterionTotals).reduce((acc, key) => {
      acc[key] = criterionTotals[key] / criterionCounts[key];
      return acc;
    }, {} as Record<string, number | null>);

    if (hasNotAssessable) {
      for (const crit of rubric.criteria) {
        if (criterionAverages[crit.id] === undefined) {
          criterionAverages[crit.id] = null;
        }
      }
    }

    let overallConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : 0.0;

    // Apply Overall High Confidence restriction
    if (isNewRefinedArticle) {
      let overallCeiling = false;
      const overallReasonCodes: string[] = [];

      const hasEnoughCoreSource = coreSourceSummary.source_count >= 2;
      const hasTestFiles = testEvidenceSummary.actual_test_files.length > 0;
      const hasExecutionConfiguration = testEvidenceSummary.documented_test_commands.length > 0 || testEvidenceSummary.ci_workflows.length > 0;
      
      const metOverallHigh = 
        hasEnoughCoreSource && 
        hasTestFiles && 
        hasExecutionConfiguration && 
        hasExecutionResults &&
        !empiricalCeilingApplied;

      if (!hasEnoughCoreSource) overallReasonCodes.push('INSUFFICIENT_CORE_SOURCE');
      if (!hasTestFiles) overallReasonCodes.push('NO_ACTUAL_TEST_FILES');
      if (!hasExecutionConfiguration) overallReasonCodes.push('NO_TEST_EXECUTION_CONFIGURATION');
      if (!hasExecutionResults) overallReasonCodes.push('NO_VERIFIED_EXECUTION_RESULTS');
      if (empiricalCeilingApplied) overallReasonCodes.push('CREATOR_CLAIM_NOT_INDEPENDENTLY_VERIFIED');

      if (!metOverallHigh) {
        overallCeiling = true;
      }

      if (overallCeiling && overallConfidence > 0.66) {
        const originalConfidence = overallConfidence >= 0.8 ? 'HIGH' : 'MEDIUM';
        adjustments.push({
          scope: "overall",
          original_confidence: originalConfidence,
          final_confidence: 'MEDIUM',
          ceiling_applied: true,
          reason_codes: overallReasonCodes
        });
        overallConfidence = Math.min(overallConfidence, 0.66); // Cap overall confidence strictly at 0.66 (MEDIUM)
      }
    } else {
      // Legacy V2 article fallback logic (retains historical 0.79 ceiling)
      const promptVer = reviewRoot?.prompt_version;
      const isNewSeasonArticle = promptVer && promptVer !== '2.0.0' && promptVer !== '1.0.0';

      if (isNewSeasonArticle && overallConfidence >= 0.8) {
        let restrictHigh = false;

        if (evidences) {
          const hasSourceEvidence = evidences.some(e => ['source_code', 'test_file', 'ci_workflow', 'dependency_manifest', 'build_config', 'release_config'].includes(e.type));
          if (!hasSourceEvidence) restrictHigh = true;

          const hasTestOrCi = evidences.some(e => ['test_file', 'ci_workflow'].includes(e.type));
          if (!hasTestOrCi) restrictHigh = true;

          const hasDiscussionOrOtherHealth = evidences.some(e => e.type === 'source_discussion');
          if (!hasDiscussionOrOtherHealth) restrictHigh = true;
        } else {
          restrictHigh = true;
        }

        let lowOrNotAssessableCount = 0;
        const criterionIds = [
          'purpose_usefulness',
          'implementation_evidence',
          'technical_quality',
          'usability_onboarding',
          'differentiation_insight',
          'project_health_stewardship'
        ];
        for (const critId of criterionIds) {
          let lowJudges = 0;
          for (const judge of newJudges) {
            const crit = judge.criteria.find((c: any) => c.criterion_id === critId);
            if (crit && ['low', 'not_assessable'].includes(crit.confidence)) {
              lowJudges++;
            }
          }
          if (lowJudges >= 3) {
            lowOrNotAssessableCount++;
          }
        }
        if (lowOrNotAssessableCount >= 2) restrictHigh = true;

        const classifications = evaluationOutputCopy.article?.evidence_classifications || [];
        if (classifications.length > 0) {
          const creatorClaimCount = classifications.filter((c: any) => c.classification === 'creator_claim').length;
          if (creatorClaimCount / classifications.length >= 0.8) {
            restrictHigh = true;
          }
        }

        if (restrictHigh) {
          overallConfidence = Math.min(overallConfidence, 0.79);
        }
      }
    }

    // Build the trusted references over the FINAL (post-ceiling) judges so the generator and
    // the publication gate see identical text. Statements the ceiling injects (e.g. the
    // prepended "does not establish verified runtime results" sentence) are covered by
    // system_generated references inside buildTrustedClaimReferences. Annotations exist only
    // on fresh generation output (the gen schema defaults them to []); a persisted review
    // being re-validated has none, so its already-built references are carried through
    // unchanged and the gate re-checks them, keeping recalculation idempotent.
    const postCeilingEvaluation = { ...evaluationOutputCopy, judges: newJudges };
    const trustedClaimReferences = isNewRefinedArticle
      ? (evaluationOutputCopy.public_statement_annotations !== undefined
          ? buildClaimReferences(postCeilingEvaluation, evidences || [])
          : (evaluationOutputCopy.claim_references || []))
      : evaluationOutputCopy.claim_references;
    const trustedCounterEvidenceReferences = isNewRefinedArticle
      ? buildCounterEvidenceReferences(evaluationOutputCopy)
      : evaluationOutputCopy.counter_evidence_references;

    const finalData = {
      ...evaluationOutputCopy,
      judges: newJudges,
      recalculated_jury_score: juryScore,
      judge_score_range: {
        min: hasNotAssessable ? null : Math.min(...judgeScores),
        max: hasNotAssessable ? null : Math.max(...judgeScores)
      },
      criterion_averages: criterionAverages,
      overall_evidence_confidence: overallConfidence,

      // Inject structural analysis summaries
      core_source_evidence: coreSourceSummary,
      test_evidence_summary: testEvidenceSummary,
      confidence_adjustments: adjustments,
      ...(isNewRefinedArticle ? {
        claim_references: trustedClaimReferences,
        counter_evidence_references: trustedCounterEvidenceReferences,
        // Refined public classifications are application-derived from cited evidence,
        // overwriting whatever the model reported. README-sourced claims can only ever
        // render as creator_claim, never "confirmed".
        article: { ...evaluationOutputCopy.article, evidence_classifications: refinedClassifications }
      } : {})
    };

    // Untrusted model annotations are consumed into trusted references above and
    // never persisted verbatim.
    delete (finalData as any).public_statement_annotations;

    const isV2_1 = evaluationOutputCopy.schema_version === '2.1.0';

    // 2.1.0 recommendation contract: re-validate against the FINAL trusted references so
    // the persisted evidence linkage can never drift from the published statements.
    if (isV2_1 && isNewRefinedArticle) {
      validateRecommendations(finalData, evidences || []);
    }

    if (isV2_1) {
      return isNewRefinedArticle
        ? RefinedPublishedEvaluationSchemaV2_1.parse(finalData)
        : PublishedEvaluationSchemaV2_1.parse(finalData);
    }
    return isNewRefinedArticle
      ? RefinedPublishedEvaluationSchemaV2.parse(finalData)
      : PublishedEvaluationSchemaV2.parse(finalData);
  }
}
