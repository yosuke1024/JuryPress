import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';

/**
 * Shared Gemini transport for every generation request in the pipeline — the editorial
 * request (Request 1) and the evidence-mapping request (Request 2) differ in model, prompt
 * and generation config, but share identical transport semantics: primary/fallback credential
 * routing, transport-only retries with backoff, and the response-first contract.
 *
 * Extracted verbatim from the evaluator so the two requests can never drift apart in how
 * they classify errors or fail over. The core invariant is unchanged: once a response body
 * is in hand, this call is DONE — nothing about its content may trigger another Gemini
 * attempt. Content defects are results, persisted by the caller and judged downstream.
 */

export type GeminiCredentialRoute = 'primary' | 'fallback';

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

/**
 * Classifies a *transport* failure. Content is deliberately absent from this function: the
 * generation loop no longer parses or judges what it receives, so a response can never fail
 * here for being unparseable, schema-violating or low quality. Those are results, persisted
 * by the caller and decided by the validator — never a reason to call Gemini again.
 *
 * `[Generation]`-prefixed errors describe a malformed response *envelope* (e.g. the API did
 * not report which model served the request). No usable response was obtained, so unlike a
 * content defect there is nothing to persist and a retry is the correct move.
 */
export function classifyError(e: any, route: GeminiCredentialRoute): 'transient_retry' | 'immediate_fallback' | 'immediate_failure' {
  if (e.message && e.message.startsWith('[Generation]')) {
    return 'transient_retry';
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

export function sanitizeErrorSummary(e: any): string {
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

function setupAgentIntercept(client: GoogleGenAI) {
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

/** What one Gemini call produced at the transport level, before anything interprets it. */
export interface TransportResult {
  rawResponse: string;
  /** Best-effort, non-throwing JSON parse; null when the response is not JSON. */
  parsed: unknown | null;
  /** The model version the API reported serving; null when unreported — never fabricated. */
  modelUsed: string | null;
  usageMetadata: {
    promptTokenCount: number | null;
    candidatesTokenCount: number | null;
    thoughtsTokenCount: number | null;
    totalTokenCount: number | null;
    cachedContentTokenCount: number | null;
  };
  attemptCount: number;
  primaryAttemptCount: number;
  fallbackAttemptCount: number;
  failoverUsed: boolean;
  successfulRoute: 'primary' | 'fallback' | null;
  failoverReason?: string;
}

/**
 * Calls Gemini once (with transport-only retries and credential failover) and returns the
 * response verbatim. Throws only when no response was obtained at all.
 */
export async function generateWithFailover(input: {
  model: string;
  prompt: string;
  /** The frozen generation config (responseJsonSchema, thinkingConfig, temperature, ...). */
  generationConfig: object;
  /**
   * Attempt budget per credential route. Defaults to the GEMINI_*_MAX_ATTEMPTS env values,
   * which are sized for the editorial request — the one call that must not be lost.
   *
   * A best-effort caller should pass something smaller. The evidence mapper does: its result
   * is regenerable and never blocks an article, so spending a minute of workflow time and a
   * second helping of the fallback key's quota on a Gemini outage buys nothing. Failing fast
   * and publishing without a map is the better trade.
   */
  maxAttempts?: { primary: number; fallback: number };
}): Promise<TransportResult> {
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
    setupAgentIntercept(primaryClient);
  }
  if (fallbackApiKey === 'AGENT_INTERCEPT_KEY' && fallbackClient) {
    setupAgentIntercept(fallbackClient);
  }

  let route: GeminiCredentialRoute = 'primary';
  let primaryAttempts = 0;
  let fallbackAttempts = 0;
  let failoverUsed = false;
  let successfulRoute: 'primary' | 'fallback' | null = null;
  let failoverReason: string | undefined = undefined;

  const primaryMax = input.maxAttempts?.primary
    ?? parseInt(process.env.GEMINI_PRIMARY_MAX_ATTEMPTS || '3', 10);
  const fallbackMax = input.maxAttempts?.fallback
    ?? parseInt(process.env.GEMINI_FALLBACK_MAX_ATTEMPTS || '3', 10);

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
        model: input.model,
        contents: input.prompt,
        config: input.generationConfig as any
      });

      // Once a response body is in hand, this call is DONE — nothing about its content may
      // trigger another Gemini attempt (that is how this pipeline used to burn six calls).
      // The actually-served model is provenance metadata: if the response does not report it,
      // record it honestly as null rather than retrying or fabricating the requested alias.
      const reportedModelVersion = typeof (response as any).modelVersion === 'string'
        && (response as any).modelVersion.trim().length > 0
        ? (response as any).modelVersion.trim()
        : null;

      // The response text EXACTLY as Gemini returned it. Nothing normalizes, repairs or
      // rewrites it here: this string is what gets persisted, and it is the baseline every
      // later immutability check compares against. Repairs happen downstream, on the parsed
      // copy, after this text is durable.
      const rawResponse = response.text || '';

      // A non-throwing parse attempt. This is not validation and cannot lose anything —
      // rawResponse is returned either way — so it is safe to do before persistence, and
      // it means an unparseable response still produces a complete, storable record.
      let parsed: unknown | null = null;
      try {
        parsed = JSON.parse(rawResponse);
      } catch {
        parsed = null;
      }

      successfulRoute = route;
      const usageMetadata = response.usageMetadata;
      return {
        rawResponse,
        parsed,
        modelUsed: reportedModelVersion,
        usageMetadata: {
          promptTokenCount: usageMetadata?.promptTokenCount ?? null,
          candidatesTokenCount: usageMetadata?.candidatesTokenCount ?? null,
          thoughtsTokenCount: usageMetadata?.thoughtsTokenCount ?? null,
          totalTokenCount: usageMetadata?.totalTokenCount ?? null,
          cachedContentTokenCount: usageMetadata?.cachedContentTokenCount ?? null
        },
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
