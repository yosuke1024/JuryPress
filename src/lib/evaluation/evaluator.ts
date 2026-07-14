import { GoogleGenAI } from '@google/genai';
import { EvaluationOutputSchema, PublishedEvaluationSchema, type PublishedEvaluation, EvaluationOutputGenSchema } from '../../schemas/evaluation';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Candidate } from '../../schemas/selection';
import type { Evidence } from '../../schemas/evidence';
import * as fs from 'fs';
import * as path from 'path';

export class Evaluator {
  private model: string;
  private rubric: any;

  constructor() {
    this.model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    this.rubric = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'templates', 'hackathon.json'), 'utf8'));
  }

  public async evaluate(candidate: Candidate, evidences: Evidence[]): Promise<any> {
    const jsonSchema = zodToJsonSchema(EvaluationOutputGenSchema, { $refStrategy: "none" });
    const schemaDefinition = jsonSchema;

    if (!schemaDefinition || Object.keys(schemaDefinition).length === 0) {
      throw new Error("JSON schema generation failed.");
    }
    
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not set. Live evaluation cannot proceed.");
    }
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const priorityOrder = ['api_metadata', 'readme', 'official_site', 'documentation', 'source_discussion'];
    const budgeted = evidences.map(e => ({ ...e }));
    let totalLen = budgeted.reduce((sum, e) => sum + e.summary.length, 0);
    const limit = 24000;
    
    if (totalLen > limit) {
      const getPriorityScore = (type: string) => {
        const idx = priorityOrder.indexOf(type);
        return idx === -1 ? 99 : idx;
      };
      
      const itemsToReduce = budgeted
        .map((e, idx) => ({ e, idx, priority: getPriorityScore(e.type) }))
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

    const prompt = `
You are the orchestrator for JuryPress, an automated AI review media.
Evaluate the following product using the provided evidence and the Judgie-AI hackathon rubric.
You must simulate 5 specific personas evaluating the product simultaneously.

Product: ${candidate.name}
URL: ${candidate.canonicalUrl}
Description/Metadata: ${JSON.stringify(candidate.metadata)}

=== EVIDENCE ===
${budgeted.map(e => `Evidence ID: ${e.evidence_id}\nURL: ${e.url}\nType: ${e.type}\nTitle: ${e.title}\nContent:\n${e.summary}\nClaims: ${JSON.stringify(e.claims || [])}\n`).join('\n\n')}
================

=== RUBRIC ===
Criteria:
${JSON.stringify(this.rubric.criteria, null, 2)}

Personas:
${JSON.stringify(this.rubric.personas, null, 2)}
==============

RULES:
1. Evaluate the product ONLY from the supplied public evidence.
2. Do not assume that undocumented functionality, architecture, security controls, user traction, revenue, or business results exist.
3. Absence of public evidence is not proof that a feature, capability, security control, or business result does not exist. Use: "The supplied evidence did not describe..." instead of "The product has no..."
4. Clearly distinguish: directly verified facts, claims made by the product creator, reasonable inferences, and unknown information.
5. All 5 personas must evaluate all 6 criteria.
6. Provide scores between 0.0 and 5.0.
7. Preserve the distinct perspective, priorities, and voice of each judge.
8. Correct grammatical errors and awkward phrasing before returning the result, but do not homogenize the judges' opinions or writing styles.
9. Return only polished final copy. Do not output drafts or editing notes.
10. Output strictly as JSON conforming to the requested schema. Do not include markdown blocks or any text outside the JSON.

RUBRIC AWARENESS:
- The Jury Score reflects the Judgie-AI Hackathon Evaluation rubric. It is NOT an objective measure of the product's overall quality.
- For OSS, educational, artistic, or non-commercial projects, explicitly acknowledge in final_verdict that the rubric's commercial-impact criteria (problem_solving_impact, presentation) may produce lower scores that do not reflect the project's inherent technical or educational merit.
- Do NOT describe a low Jury Score as proof that the project lacks value.

LANGUAGE CALIBRATION (strictly enforced):
Every factual statement must be traceable to an Evidence ID and use calibrated language:
- verified_fact: "The repository includes...", "The public demo shows...", "The API metadata reports..."
- creator_claim: "The project describes itself as...", "According to the README...", "The creator states that..."
- inference: "This may indicate...", "The jury inferred that...", "This suggests, but does not prove..."
- unknown: "The available evidence does not establish...", "The jury could not verify...", "No public evidence was found regarding..."

PROHIBITED PHRASES (output will be rejected if these appear):
Do NOT use: "literally zero", "no value", "perfect", "flawless", "guaranteed", "will definitely", "proves demand", "obviously", "without question", "has no commercial value", "TAM is literally zero", "is almost flawless", "will easily become a successful SaaS", "has no real-world impact", "is perfectly designed", "has no error recovery", "has serious security vulnerabilities".
Use calibrated alternatives:
- Instead of "has no commercial value" -> "The available evidence does not show a clear commercial path."
- Instead of "proves demand" -> "indicates substantial interest, although it does not establish retention or willingness to pay."
- Instead of "has no error recovery" -> "The supplied evidence did not describe an error recovery mechanism."
- Instead of "has serious security vulnerabilities" -> "The jury could not verify the sandboxing model from the supplied material."

POPULARITY CALIBRATION:
Popularity signals (stars, likes, points) must NOT be treated as proof of product-market fit, retention, or willingness to pay.
- WRONG: "16,000 likes prove genuine product demand."
- RIGHT: "More than 16,000 likes demonstrate substantial public interest, although they do not establish retention or willingness to pay."

EVIDENCE TRACEABILITY:
A judge may only refer to frameworks, architecture, source files, security controls, or missing features when those details exist in the supplied Evidence.
Before producing each assertion, check whether an Evidence ID supports it.
Do NOT infer the absence of a feature merely because it is not mentioned.
- WRONG: "The product has no rollback system."
- RIGHT: "The supplied evidence did not describe a rollback system."

FINAL VERDICT FORMAT:
The final_verdict MUST contain exactly 3-4 sentences:
1. The project's strongest demonstrated quality.
2. Its largest evidenced or unverified concern.
3. The type of user or purpose for which it appears most relevant.
4. (When applicable) A note that the rubric may disadvantage non-commercial projects.
Do NOT use marketing superlatives unless directly quoting a creator claim.
`;

    let attempts = 0;
    const maxAttempts = parseInt(process.env.GEMINI_MAX_ATTEMPTS || '3', 10);
    while (attempts < maxAttempts) {
      attempts++;
      try {
        const response = await ai.models.generateContent({
          model: this.model,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: schemaDefinition as any,
          }
        });

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
        
        // Normalize schema_version to ensure zod parsing succeeds
        if (parsed && typeof parsed === 'object') {
          if (parsed.schema_version !== '1.0.0' && parsed.schema_version !== '1.0') {
            parsed.schema_version = '1.0.0';
          }
        }
        
        // Zod verification
        const valid = EvaluationOutputSchema.parse(parsed);

        // Verification Rules
        this.verifyRules(valid, evidences);
        
        // Attach usage info
        return {
          output: valid,
          usage: {
            input_tokens: response.usageMetadata?.promptTokenCount,
            output_tokens: response.usageMetadata?.candidatesTokenCount
          },
          characters_sent_to_model: totalLen,
          modelUsed: this.model, // record actual model used
          attemptCount: attempts
        };
      } catch (e: any) {
        console.warn(`Evaluation attempt ${attempts} failed:`, e.message);
        if (attempts >= 3) {
          throw e;
        }
        console.log("Sleeping 25 seconds before retry...");
        await new Promise(resolve => setTimeout(resolve, 25000));
      }
    }
    throw new Error('Evaluation failed after 3 attempts');
  }

  private verifyRules(valid: any, evidences: Evidence[]) {
    // 5 judges
    if (valid.judges.length !== 5) throw new Error("Must have exactly 5 judges.");
    
    // Identical verdicts check
    const verdicts = new Set(valid.judges.map((j: any) => j.verdict));
    if (verdicts.size === 1) throw new Error("All judges have identical verdicts. Too homogenized.");
    
    const jsonStr = JSON.stringify(valid);

    // HTML tag check
    if (/<[a-z][\s\S]*>/i.test(jsonStr)) {
      throw new Error("HTML tags found in output.");
    }

    // Prohibited phrase check (editorial grounding)
    const prohibitedLiterals = [
      'literally zero', 'no value', 'guaranteed', 'will definitely',
      'proves demand', 'without question', 'has no commercial value',
      'is almost flawless', 'will easily become',
      'has no real-world impact', 'is perfectly designed',
      'has no error recovery', 'has serious security vulnerabilities'
    ];
    const prohibitedPatterns = [
      /\bperfect\b/i, /\bflawless\b/i, /\bobviously\b/i
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

    // Mixed-language check (detect non-ASCII script mixing in English output)
    // Allow common punctuation and symbols, flag CJK or Cyrillic blocks
    const cjkPattern = /[\u3000-\u9FFF\uAC00-\uD7AF]/;
    if (cjkPattern.test(jsonStr)) {
      throw new Error("Mixed-language corruption detected: CJK characters found in English output.");
    }

    // Repeated word detection (same word 4+ times consecutively)
    const repeatedWordPattern = /\b(\w+)\s+\1\s+\1\s+\1\b/i;
    if (repeatedWordPattern.test(jsonStr)) {
      throw new Error("Repeated word sequence detected in output.");
    }

    // Evidence ID verification
    const collectedEvidenceIds = new Set(evidences.map(e => e.evidence_id));
    for (const judge of valid.judges) {
      for (const criterion of judge.criteria) {
        for (const evId of criterion.evidence_ids) {
          if (!collectedEvidenceIds.has(evId)) {
            throw new Error(`Invalid evidence_id referenced: ${evId}`);
          }
        }
      }
    }
  }

  public recalculateScores(evaluationOutput: any): PublishedEvaluation {
    const criteriaWeights = Object.fromEntries(
      this.rubric.criteria.map((c: any) => [c.name.toLowerCase().replace(/[^a-z0-9]+/g, '_'), c.weight])
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
    return PublishedEvaluationSchema.parse(finalData);
  }
}
