import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ReviewSchemaV2_1, GenerationMetadataSchema } from '../../src/schemas/review';
import { createRecommendationFixture } from '../fixtures/refined-review';

let originalMode: string | undefined;
let baseReview: any;

beforeAll(() => {
  originalMode = process.env.JURYPRESS_DATA_MODE;
  process.env.JURYPRESS_DATA_MODE = 'fixture';
  baseReview = createRecommendationFixture().review;
});

afterAll(() => {
  process.env.JURYPRESS_DATA_MODE = originalMode;
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe('Generation metadata (Phase 3)', () => {
  it('accepts consistent generation metadata and requires thinking level HIGH', () => {
    const parsed: any = ReviewSchemaV2_1.parse(clone(baseReview));
    expect(parsed.generation_metadata.thinking_level).toBe('HIGH');
    expect(parsed.generation_metadata.used_model).toBe(parsed.model);
  });

  it('is required on 2.1.0 reviews', () => {
    const broken = clone(baseReview);
    delete broken.generation_metadata;
    expect(() => ReviewSchemaV2_1.parse(broken)).toThrow();
  });

  it('rejects a thinking level other than HIGH', () => {
    const broken = clone(baseReview);
    broken.generation_metadata.thinking_level = 'MEDIUM';
    expect(() => ReviewSchemaV2_1.parse(broken)).toThrow();
  });

  it('rejects used_model disagreeing with the top-level model', () => {
    const broken = clone(baseReview);
    broken.generation_metadata.used_model = 'another-model';
    broken.generation_metadata.requested_model = 'another-model';
    expect(() => ReviewSchemaV2_1.parse(broken)).toThrow(/must equal the top-level model/);
  });

  it('rejects route values disagreeing with generation_route', () => {
    const broken = clone(baseReview);
    broken.generation_metadata.successful_route = 'fallback';
    broken.generation_metadata.failover_used = true;
    expect(() => ReviewSchemaV2_1.parse(broken)).toThrow(/generation_route/);
  });

  it('rejects attempt counts disagreeing with generation_route / attempt_count', () => {
    const broken = clone(baseReview);
    broken.generation_metadata.total_attempts = 4;
    expect(() => ReviewSchemaV2_1.parse(broken)).toThrow();
  });

  it('rejects token_usage disagreeing with the top-level usage', () => {
    const broken = clone(baseReview);
    broken.generation_metadata.token_usage.input_tokens = 999;
    expect(() => ReviewSchemaV2_1.parse(broken)).toThrow(/input_tokens/);
  });

  it('rejects an incoherent total token count', () => {
    const broken = clone(baseReview);
    broken.usage = { input_tokens: 100, output_tokens: 50, estimated_cost: 0 };
    broken.generation_metadata.token_usage = {
      input_tokens: 100,
      output_tokens: 50,
      thinking_tokens: 200,
      total_tokens: 120,
      cached_input_tokens: null
    };
    expect(() => ReviewSchemaV2_1.parse(broken)).toThrow(/total_tokens/);
  });

  it('accepts nulls for unreported token counts but rejects missing keys', () => {
    expect(() => GenerationMetadataSchema.parse({
      requested_model: 'm',
      used_model: 'm',
      thinking_level: 'HIGH',
      successful_route: 'primary',
      failover_used: false,
      primary_attempts: 1,
      fallback_attempts: 0,
      total_attempts: 1,
      token_usage: { input_tokens: 1, output_tokens: 2, thinking_tokens: null, total_tokens: null, cached_input_tokens: null }
    })).not.toThrow();

    expect(() => GenerationMetadataSchema.parse({
      requested_model: 'm',
      used_model: 'm',
      thinking_level: 'HIGH',
      successful_route: 'primary',
      failover_used: false,
      primary_attempts: 1,
      fallback_attempts: 0,
      total_attempts: 1,
      token_usage: { input_tokens: 1, output_tokens: 2 }
    })).toThrow();
  });
});
