import { describe, it, expect } from 'vitest';
import { validateEditorialReviewIntegrity } from '../../src/lib/publication-integrity';
import { createEditorialFixture } from '../fixtures/refined-review';

/**
 * The editorial publication gate's product-identity rules, written against the two 2026-07
 * production incidents: a review published as "or install uv:" (a bash comment adopted as
 * the canonical name) and one published as "React &middot;" (entity residue from a README
 * H1). Every rule here is fail-closed data integrity — a sentence cannot trip it; only a
 * broken identity can.
 */
describe('Editorial publication gate — product identity', () => {
  function fixture() {
    const { review, bundle } = createEditorialFixture();
    return { review: JSON.parse(JSON.stringify(review)), bundle };
  }

  it('passes the well-formed editorial fixture', () => {
    const { review, bundle } = fixture();
    expect(() => validateEditorialReviewIntegrity(review, bundle, 'editorial-product')).not.toThrow();
  });

  it('fails closed when project_identity is missing instead of silently skipping', () => {
    const { review, bundle } = fixture();
    delete review.evaluation.project_identity;
    expect(() => validateEditorialReviewIntegrity(review, bundle, 'editorial-product'))
      .toThrow(/Missing project_identity/);
  });

  it('rejects a canonical name carrying entity residue', () => {
    const { review, bundle } = fixture();
    review.evaluation.project_identity.canonical_display_name = 'React &middot;';
    review.evaluation.product.name = 'React &middot;';
    expect(() => validateEditorialReviewIntegrity(review, bundle, 'editorial-product'))
      .toThrow(/Invalid canonical_display_name/);
  });

  it('rejects a canonical name that is an instruction fragment', () => {
    const { review, bundle } = fixture();
    review.evaluation.project_identity.canonical_display_name = 'or install uv:';
    review.evaluation.product.name = 'or install uv:';
    expect(() => validateEditorialReviewIntegrity(review, bundle, 'editorial-product'))
      .toThrow(/Invalid canonical_display_name/);
  });

  it('rejects a well-formed canonical name that is unrelated to the repository', () => {
    const { review, bundle } = fixture();
    review.evaluation.project_identity.canonical_display_name = 'Sponsored Hero Banner';
    expect(() => validateEditorialReviewIntegrity(review, bundle, 'editorial-product'))
      .toThrow(/unrelated to repository/);
  });

  it('rejects an article that names the product in neither headline nor standfirst', () => {
    const { review, bundle } = fixture();
    review.evaluation.article.headline = 'Local AST knowledge graphs beat blind vector searches';
    review.evaluation.article.standfirst = 'The jury weighs a deterministic structure graph against embedding search, and picks a side.';
    expect(() => validateEditorialReviewIntegrity(review, bundle, 'editorial-product'))
      .toThrow(/neither the headline nor the standfirst/);
  });

  it('accepts the name appearing only in the standfirst', () => {
    const { review, bundle } = fixture();
    review.evaluation.article.headline = 'Betting everything on the terminal, and mostly winning';
    review.evaluation.article.standfirst = 'Refined Product is a small, opinionated tool with an unusually clear point of view.';
    expect(() => validateEditorialReviewIntegrity(review, bundle, 'editorial-product')).not.toThrow();
  });
});
