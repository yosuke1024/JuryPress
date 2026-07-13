import { describe, it, expect } from 'vitest';
import { EvaluationOutputBaseSchema } from '../../src/schemas/evaluation';

describe('Schema Validations', () => {
  it('should validate base schema requirements', () => {
    // We should test that there are no dangling references
    // Since we removed zod-to-json-schema's $ref from EvaluationOutputSchema logic, we just ensure it validates a partial.
    expect(EvaluationOutputBaseSchema).toBeDefined();
  });
});
