import { describe, it, expect } from 'vitest';
import { EvaluationOutputSchema } from '../../src/schemas/evaluation';
import { zodToJsonSchema } from 'zod-to-json-schema';

describe('Schema Validations', () => {
  it('should generate a valid JSON schema for Gemini', () => {
    const jsonSchema = zodToJsonSchema(EvaluationOutputSchema, { $refStrategy: "none" }) as any;
    
    // Schema must not be empty
    expect(jsonSchema).toBeDefined();
    expect(Object.keys(jsonSchema).length).toBeGreaterThan(0);
    
    // No $refs should remain
    const schemaStr = JSON.stringify(jsonSchema);
    expect(schemaStr).not.toContain('"$ref"');
    
    // Check judges length constraint
    const judgesProp = jsonSchema.properties?.judges;
    expect(judgesProp).toBeDefined();
    expect(judgesProp.type).toBe('array');
    expect(judgesProp.minItems).toBe(5);
    expect(judgesProp.maxItems).toBe(5);
    
    // Check criteria length constraint inside judges
    const criteriaProp = judgesProp.items?.properties?.criteria;
    expect(criteriaProp).toBeDefined();
    expect(criteriaProp.type).toBe('array');
    expect(criteriaProp.minItems).toBe(6);
    expect(criteriaProp.maxItems).toBe(6);
    
    // Check score bounds
    const scoreProp = criteriaProp.items?.properties?.score;
    expect(scoreProp).toBeDefined();
    expect(scoreProp.type).toBe('number');
    expect(scoreProp.minimum).toBe(0);
    expect(scoreProp.maximum).toBe(5);
    
    // Check evidence classifications enum
    const classificationsProp = jsonSchema.properties?.article?.properties?.evidence_classifications?.items?.properties?.classification;
    expect(classificationsProp).toBeDefined();
    expect(classificationsProp.enum).toEqual(['verified_fact', 'creator_claim', 'inference', 'unknown']);
  });
});
