/**
 * Deterministic recovery of the immutable judgment baseline from a raw Gemini response whose
 * strict parse failed (so generation.originalContent is null).
 *
 * The distinction this module exists to protect: a human editor may rewrite prose, but may
 * never author the jury's judgment. When the original never parsed, the scores, the judge
 * composition and the criterion breakdown are not the editor's to invent. So before a null
 * original can be edited into publication, its judgment must be *recovered* from what the
 * model actually said — never reconstructed from an empty template.
 *
 * Recovery is strictly deterministic and non-lossy: it only ever re-parses the same bytes the
 * model returned (unwrapping a markdown code fence or isolating the outermost JSON object),
 * and it accepts the result only if that result already carries a full judgment structure.
 * If it cannot, recovery fails and the caller must refuse to create a publishable revision.
 */

export interface RecoveredBaseline {
  baseline: unknown;
  /** How the bytes were re-parsed, recorded in baselineRecovery.method for audit. */
  method: string;
}

/** Strip a leading/trailing markdown code fence, if present, and return the inner text. */
function stripCodeFence(text: string): string | null {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  return fence ? fence[1].trim() : null;
}

/** Isolate the outermost balanced {...} object, ignoring braces inside strings. */
function extractOutermostObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * True only when `value` already carries a complete jury judgment — five judges, each a
 * persona with six scored criteria. This is the gate that stops an empty or half-formed object
 * from passing as a recovered baseline: if the judgment is not demonstrably the model's,
 * recovery must fail so no human can supply it.
 *
 * Note it checks the criterion scores, not `recalculated_jury_score`: the jury score is
 * derived by code from those scores and is not part of the model's raw output, so requiring it
 * would reject every genuine response. The immutable judgment the human must not author is the
 * per-criterion scores and the judge composition, which are exactly what is checked here.
 */
export function hasJudgmentStructure(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  const judges = obj.judges;
  if (!Array.isArray(judges) || judges.length !== 5) return false;
  return judges.every(judge => {
    if (!judge || typeof judge !== 'object') return false;
    const j = judge as Record<string, unknown>;
    if (typeof j.judge_id !== 'string') return false;
    const criteria = j.criteria;
    if (!Array.isArray(criteria) || criteria.length !== 6) return false;
    return criteria.every(c => {
      if (!c || typeof c !== 'object') return false;
      const crit = c as Record<string, unknown>;
      // A score must be present as a number or an explicit null (evidence-limited). What must
      // never be tolerated is a missing score a human could then fill in.
      return 'score' in crit && (typeof crit.score === 'number' || crit.score === null);
    });
  });
}

/**
 * Attempts to recover the judgment baseline from a raw response. Returns null when no
 * deterministic re-parse yields a complete judgment — the caller must then refuse to create a
 * publishable revision (IMMUTABLE_JUDGMENT_BASELINE_UNAVAILABLE) rather than let a human
 * author the judgment.
 */
export function recoverImmutableBaseline(rawResponse: string | null): RecoveredBaseline | null {
  if (typeof rawResponse !== 'string' || rawResponse.trim().length === 0) return null;

  const attempts: Array<[string, () => unknown]> = [
    ['strict-json', () => JSON.parse(rawResponse)],
    ['code-fence', () => {
      const inner = stripCodeFence(rawResponse);
      if (inner === null) throw new Error('no code fence');
      return JSON.parse(inner);
    }],
    ['outermost-object', () => {
      const block = extractOutermostObject(rawResponse);
      if (block === null) throw new Error('no object');
      return JSON.parse(block);
    }]
  ];

  for (const [method, parse] of attempts) {
    let parsed: unknown;
    try {
      parsed = parse();
    } catch {
      continue;
    }
    if (hasJudgmentStructure(parsed)) {
      return { baseline: parsed, method };
    }
  }
  return null;
}
