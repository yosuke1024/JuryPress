import { GoogleGenAI } from '@google/genai';
import { EvaluationOutputSchema, PublishedEvaluationSchema, type PublishedEvaluation } from '../../schemas/evaluation';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { Candidate } from '../../schemas/selection';
import type { Evidence } from '../../schemas/evidence';
import * as fs from 'fs';
import * as path from 'path';

export class Evaluator {
  private ai: GoogleGenAI;
  private model: string;
  private rubric: any;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'dummy' });
    this.model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    this.rubric = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'templates', 'hackathon.json'), 'utf8'));
  }

  public async evaluate(candidate: Candidate, evidences: Evidence[]): Promise<any> {
    const jsonSchema = zodToJsonSchema(EvaluationOutputSchema, { $refStrategy: "none" });
    const schemaDefinition = jsonSchema;

    if (!schemaDefinition || Object.keys(schemaDefinition).length === 0) {
      throw new Error("JSON schema generation failed.");
    }

    const prompt = `
You are the orchestrator for JuryPress, an automated AI review media.
Evaluate the following product using the provided evidence and the Judgie-AI hackathon rubric.
You must simulate 5 specific personas evaluating the product simultaneously.

Product: ${candidate.name}
URL: ${candidate.canonicalUrl}
Description/Metadata: ${JSON.stringify(candidate.metadata)}

=== EVIDENCE ===
${evidences.map(e => `Evidence ID: ${e.evidence_id}\nURL: ${e.url}\nType: ${e.type}\nTitle: ${e.title}\nContent:\n${e.summary}\nClaims: ${JSON.stringify(e.claims || [])}\n`).join('\n\n')}
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
3. Absence of public evidence is not proof that a feature, capability, security control, or business result does not exist.
4. Clearly distinguish: directly verified facts, claims made by the product creator, reasonable inferences, and unknown information.
5. All 5 personas must evaluate all 6 criteria.
6. Provide scores between 0.0 and 5.0.
7. Preserve the distinct perspective, priorities, and voice of each judge.
8. Correct grammatical errors and awkward phrasing before returning the result, but do not homogenize the judges' opinions or writing styles.
9. Avoid generic marketing language, repeated conclusions, and unsupported praise.
10. Return only polished final copy. Do not output drafts or editing notes.
11. Output strictly as JSON conforming to the requested schema. Do not include markdown blocks or any text outside the JSON.
`;

    let attempts = 0;
    while (attempts < 3) {
      attempts++;
      try {
        const response = await this.ai.models.generateContent({
          model: this.model,
          contents: prompt,
          config: {
            responseMimeType: "application/json",
            responseSchema: schemaDefinition as any,
          }
        });

        const text = response.text || '';
        const parsed = JSON.parse(text);
        
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
          modelUsed: this.model, // record actual model used
          attemptCount: attempts
        };
      } catch (e: any) {
        console.warn(`Evaluation attempt ${attempts} failed:`, e.message);
        if (attempts >= 3) {
          throw e;
        }
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
    
    // HTML tag check
    const jsonStr = JSON.stringify(valid);
    if (/<[a-z][\s\S]*>/i.test(jsonStr)) {
      throw new Error("HTML tags found in output.");
    }
    
    // Empty strings check
    if (jsonStr.includes('""')) {
       // Just a simple check, a robust check would recurse object
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

    for (const judge of evaluationOutput.judges) {
      let judgeScore = 0;
      for (const criterion of judge.criteria) {
        const weight = weightMap[criterion.criterion_id] || 0;
        const weightedScore = (criterion.score / 5) * weight;
        criterion.weighted_score = weightedScore; // Attach for rendering
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
      }
      judge.judge_score = judgeScore;
      judgeScores.push(judgeScore);
      totalJudgeScore += judgeScore;
    }

    const juryScore = totalJudgeScore / evaluationOutput.judges.length;
    
    const criterionAverages = Object.keys(criterionTotals).reduce((acc, key) => {
      acc[key] = criterionTotals[key] / criterionCounts[key];
      return acc;
    }, {} as Record<string, number>);

    const overallConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : 0.0;

    const finalData = {
      ...evaluationOutput,
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
