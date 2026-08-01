/**
 * The provider boundary for every LLM generation request in the pipeline.
 *
 * This module owns exactly one responsibility: turning a provider-neutral generation request
 * into a persisted-ready raw result. It sits where the Gemini transport already sat — AFTER the
 * prompt builder and BEFORE response-first persistence — so swapping providers cannot reach
 * either side of it. Prompts, personas, rubric, output schema, quality gate and publication
 * state are all upstream or downstream of this file and are untouched by provider choice.
 *
 * The invariant every implementation inherits from the Gemini transport: once a response body
 * is in hand, the call is DONE. Nothing about its CONTENT may trigger another attempt. Content
 * defects are results — persisted by the caller and judged downstream — never a reason to
 * generate again. Only transport failures (auth, quota, timeout, a process that produced no
 * usable envelope at all) may retry, and only within one provider. There is no cross-provider
 * fallback in either direction, by design: a run's provider is fixed when it starts, and a
 * response produced by one provider must never be silently replaced by another's.
 */

/**
 * Providers the pipeline knows how to route to. Anything outside this set is a configuration
 * error, never a reason to quietly pick a default — see resolveProvider().
 */
export const LLM_PROVIDERS = ['gemini', 'anthropic-claude-code'] as const;

export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/**
 * The production default. Provider migration is opt-in: an unset variable, an empty variable,
 * or a workflow that predates provider selection all resolve to Gemini and behave exactly as
 * they did before this module existed.
 */
export const DEFAULT_LLM_PROVIDER: LlmProvider = 'gemini';

/**
 * Provider-neutral thinking budget. Each transport maps this onto its own vocabulary
 * (Gemini's ThinkingLevel enum, Claude Code's effort levels); callers never name a
 * provider-specific value.
 */
export type ThinkingBudget = 'low' | 'high';

export interface LlmGenerationRequest {
  /** The exact model identifier to request. Never an empty string — see resolve*Model(). */
  requestedModel: string;
  /** The fully built prompt. Providers may wrap it, but never edit it. */
  prompt: string;
  /** The JSON Schema the output must satisfy, as produced by zodToJsonSchema. */
  jsonSchema: object;
  thinkingBudget: ThinkingBudget;
  /** Optional generation bounds; a provider that has no equivalent ignores them. */
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Transport attempt budget. `primary`/`fallback` are named for Gemini's two credential
   * routes; a single-route provider uses `primary` and ignores `fallback`.
   */
  maxAttempts?: { primary: number; fallback: number };
}

export interface LlmTokenUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  totalTokens: number | null;
  cachedInputTokens: number | null;
}

/** Token counts the provider did not report. Never zero-filled — absence is recorded as absence. */
export const EMPTY_TOKEN_USAGE: LlmTokenUsage = Object.freeze({
  inputTokens: null,
  outputTokens: null,
  thinkingTokens: null,
  totalTokens: null,
  cachedInputTokens: null
});

/**
 * What `rawResponse` actually is for this provider, recorded on the generation record so an
 * auditor never has to guess how close to the model's own bytes the stored text is.
 *
 *   `api_response_text`        — the provider API's response body, verbatim (Gemini).
 *   `cli_final_result_text`    — the final assistant text from a CLI envelope, verbatim; the
 *                                surrounding execution log is NOT stored (Claude Code).
 */
export interface ResponseCapture {
  type: 'api_response_text' | 'cli_final_result_text';
  /** True when the stored text is byte-identical to what the provider returned. */
  verbatim: boolean;
  /** True when the provider's own execution log is also persisted. */
  providerExecutionLogStored: boolean;
}

/** What one generation call produced at the transport level, before anything interprets it. */
export interface RawTransportResult {
  /** The response text exactly as the provider returned it. Never normalized or repaired. */
  rawResponse: string;
  /** Best-effort, non-throwing strict JSON parse; null when the response is not JSON. */
  parsed: unknown | null;
  provider: LlmProvider;
  requestedModel: string;
  /** The model the provider reported serving; null when unreported — never fabricated. */
  modelUsed: string | null;
  tokenUsage: LlmTokenUsage;
  /** Transport attempts only. A response is never re-requested for being low quality. */
  attemptCount: number;
  responseCapture: ResponseCapture;
  /**
   * Provider-specific provenance that has no cross-provider meaning (Gemini's credential
   * route and failover reason, Claude Code's session id and turn count). Deliberately opaque:
   * forcing these into shared fields would invent equivalences that do not exist.
   */
  transportMetadata: Record<string, unknown>;
}

export interface LlmTransport {
  readonly provider: LlmProvider;
  generate(request: LlmGenerationRequest): Promise<RawTransportResult>;
}

/** A provider selection or credential problem, raised before any generation is attempted. */
export class LlmProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmProviderConfigurationError';
  }
}

export function isLlmProvider(value: unknown): value is LlmProvider {
  return typeof value === 'string' && (LLM_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Resolves the provider for this run. Fail-closed on an unrecognized value: a typo in a
 * repository variable must stop the run, never fall through to a provider the operator did not
 * choose. Unset or empty means Gemini, which is what every workflow written before provider
 * selection existed implicitly asked for.
 */
export function resolveProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const configured = env.JURYPRESS_LLM_PROVIDER?.trim();
  if (!configured) return DEFAULT_LLM_PROVIDER;
  if (!isLlmProvider(configured)) {
    throw new LlmProviderConfigurationError(
      `Unknown LLM provider "${configured}". Supported providers: ${LLM_PROVIDERS.join(', ')}.`
    );
  }
  return configured;
}

/**
 * Verifies the selected provider's credentials BEFORE any candidate is reserved or any prompt
 * is built, so a misconfigured run fails on a preflight instead of after spending selection and
 * evidence collection. Only the selected provider's credentials are required: a Gemini run must
 * keep working with no Claude secret present, and vice versa.
 *
 * Values are never read into the message — only their presence is reported.
 */
export function assertProviderCredentials(
  provider: LlmProvider,
  env: NodeJS.ProcessEnv = process.env
): void {
  if (provider === 'gemini') {
    if (!env.GEMINI_API_KEY?.trim()) {
      throw new LlmProviderConfigurationError(
        'Provider "gemini" requires GEMINI_API_KEY, which is not set.'
      );
    }
    return;
  }
  if (!env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    throw new LlmProviderConfigurationError(
      'Provider "anthropic-claude-code" requires CLAUDE_CODE_OAUTH_TOKEN, which is not set.'
    );
  }
  if (env.ANTHROPIC_API_KEY?.trim()) {
    // ANTHROPIC_API_KEY silently overrides subscription auth inside the CLI, which would move
    // the run onto metered billing without changing anything visible in the record. Refuse
    // rather than bill by accident.
    throw new LlmProviderConfigurationError(
      'ANTHROPIC_API_KEY is set alongside CLAUDE_CODE_OAUTH_TOKEN. It would override subscription ' +
      'authentication and bill the run to the API. Unset it, or select provider "gemini".'
    );
  }
}

/**
 * How the run authenticated, recorded on the record as provenance. Not a credential, and never
 * derived from the credential's value.
 */
export function authenticationModeFor(provider: LlmProvider): string {
  return provider === 'gemini' ? 'api_key' : 'subscription_oauth';
}

/** The Gemini editorial model the pipeline has always used when GEMINI_MODEL is unset. */
export const GEMINI_DEFAULT_MODEL = 'gemini-3.5-flash';

/**
 * The editorial (Request 1) model for the selected provider.
 *
 * Gemini keeps its historical resolution exactly — `GEMINI_MODEL` with the same default — so a
 * Gemini run is byte-identical to one made before this function existed. Claude has no default:
 * a pinned model identifier is the whole point of the comparison, and silently substituting one
 * would make two runs incomparable without saying so.
 */
export function resolveGenerationModel(
  provider: LlmProvider,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (provider === 'gemini') {
    return env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
  }
  const configured = env.JURYPRESS_GENERATION_MODEL?.trim();
  if (!configured) {
    throw new LlmProviderConfigurationError(
      'Provider "anthropic-claude-code" requires JURYPRESS_GENERATION_MODEL to name a model identifier.'
    );
  }
  return configured;
}

/**
 * The evidence-mapping (Request 2) model. Gemini's historical resolution is preserved verbatim.
 * Claude falls back to the generation model on purpose: the initial migration deliberately does
 * not introduce a second model difference, so mapping runs on the same model until the move is
 * stable (brief §10.2).
 */
export function resolveMappingModel(
  provider: LlmProvider,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (provider === 'gemini') {
    return env.GEMINI_MAPPING_MODEL || env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
  }
  const configured = env.JURYPRESS_MAPPING_MODEL?.trim();
  if (configured) return configured;
  return resolveGenerationModel(provider, env);
}

/**
 * A non-throwing strict JSON parse. Identical for every provider on purpose: allowing one
 * transport to be more forgiving than another (unwrapping a code fence, say) would turn a
 * measurable difference in output discipline into an invisible one, and the whole point of this
 * migration is to measure exactly that. Deterministic recovery from a fenced response already
 * exists downstream, in the human-edit path (see generation/baseline.ts).
 */
export function strictParse(rawResponse: string): unknown | null {
  try {
    return JSON.parse(rawResponse);
  } catch {
    return null;
  }
}

/** What a structural recovery did, recorded on the record so it is never a silent rewrite. */
export interface StructuralRecovery {
  /** The characters appended, in the order appended. Always closers, never content. */
  appended: string;
}

export interface RecoveredParse {
  value: unknown | null;
  recovery: StructuralRecovery | null;
}

/**
 * Parses a response that is strict JSON, or that is strict JSON with its closing brackets
 * missing — and nothing else.
 *
 * Claude Opus ended a production generation one `}` short of a complete document: 40,559
 * characters carrying every field the schema asks for, `stop_reason: end_turn`, no code fence,
 * no token ceiling. The model simply stopped believing it was finished. Under a plain parse that
 * article was unrecoverable, and the run published nothing.
 *
 * The recovery is deliberately the dumbest thing that works. It scans the text with a
 * string-and-escape-aware reader, and appends closers ONLY when the reader ends at a position
 * where a document could legitimately continue with a closing bracket:
 *
 *   - not inside a string literal — a truncated string is lost text, and no bracket restores it
 *   - not after a `,` or `:` — a value was promised and never arrived
 *   - not inside a number or a bare word — `1.` and `tru` have no unambiguous completion
 *
 * Nothing is inferred, invented or rewritten: the only characters that can ever be added are
 * `}` and `]`, in the order the open containers demand. `rawResponse` is left untouched, so the
 * repair is re-derivable from the stored record by anyone who doubts it.
 *
 * Structural completeness is NOT content completeness. A response that stops after three judges
 * closes just as cleanly as one that stops after five, and this function will happily close both
 * — which is correct, because deciding whether an article is finished is the validator's job and
 * it already does it. This only decides whether there is a document to judge at all.
 */
export function parseWithStructuralRecovery(rawResponse: string): RecoveredParse {
  const direct = strictParse(rawResponse);
  if (direct !== null) return { value: direct, recovery: null };

  const closers = missingClosers(rawResponse);
  if (closers === null || closers === '') return { value: null, recovery: null };

  const value = strictParse(rawResponse + closers);
  if (value === null) return { value: null, recovery: null };
  return { value, recovery: { appended: closers } };
}

/**
 * The closing brackets a truncated document is missing, or null when appending them would be
 * guessing rather than closing.
 */
function missingClosers(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  // The last thing the reader saw, which is what decides whether a closer may follow.
  let pending: 'none' | 'value' | 'separator' | 'unterminated-token' = 'none';

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') { inString = false; pending = 'value'; }
      continue;
    }

    if (ch === '"') { inString = true; pending = 'unterminated-token'; continue; }

    if (ch === '{' || ch === '[') { stack.push(ch === '{' ? '}' : ']'); pending = 'none'; continue; }
    if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return null; // mismatched: not a truncation, a malformed document
      pending = 'value';
      continue;
    }
    if (ch === ',' || ch === ':') { pending = 'separator'; continue; }
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;

    // Anything else is part of a number, `true`, `false` or `null`. Whether it is complete
    // cannot be known until a delimiter follows, so a document ending here is not closable.
    pending = 'unterminated-token';
  }

  if (inString) return null;
  if (stack.length === 0) return null;
  if (pending === 'separator' || pending === 'unterminated-token' || pending === 'none') return null;

  return stack.reverse().join('');
}
