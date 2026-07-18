import { describe, it, expect } from 'vitest';
import {
  DISCUSSIONS_REPO,
  DISCUSSIONS_REPO_ID,
  DISCUSSIONS_CATEGORY,
  DISCUSSIONS_CATEGORY_ID,
  DISCUSSIONS_CATEGORY_URL,
  reviewDiscussionTerm,
} from '../../src/config/discussions';

describe('Discussion specific-term generation', () => {
  it('generates the documented term for the documented example slug', () => {
    expect(reviewDiscussionTerm('freecodecamp-freecodecamp-fde65e')).toBe(
      'JuryPress review: freecodecamp-freecodecamp-fde65e'
    );
  });

  it('is deterministic for a given slug', () => {
    const a = reviewDiscussionTerm('some-slug-123');
    const b = reviewDiscussionTerm('some-slug-123');
    expect(a).toBe(b);
  });

  it('depends only on slug — differs only when the slug differs', () => {
    expect(reviewDiscussionTerm('slug-a')).not.toBe(reviewDiscussionTerm('slug-b'));
  });

  it('the function signature takes only a slug argument (no title/url/pathname params)', () => {
    expect(reviewDiscussionTerm.length).toBe(1);
  });
});

describe('Discussion repository/category configuration', () => {
  it('repository is the public JuryPress repo', () => {
    expect(DISCUSSIONS_REPO).toBe('yosuke1024/JuryPress');
  });

  it('category is named Review Comments', () => {
    expect(DISCUSSIONS_CATEGORY).toBe('Review Comments');
  });

  it('repository id is present and not an obvious placeholder', () => {
    expect(DISCUSSIONS_REPO_ID).toBeTruthy();
    expect(DISCUSSIONS_REPO_ID).not.toBe('');
    expect(DISCUSSIONS_REPO_ID).not.toMatch(/placeholder|dummy|todo|xxx|changeme/i);
    // Real GitHub repository node IDs are base64-ish and start with R_
    expect(DISCUSSIONS_REPO_ID).toMatch(/^R_/);
  });

  it('category id is present and not an obvious placeholder', () => {
    expect(DISCUSSIONS_CATEGORY_ID).toBeTruthy();
    expect(DISCUSSIONS_CATEGORY_ID).not.toBe('');
    expect(DISCUSSIONS_CATEGORY_ID).not.toMatch(/placeholder|dummy|todo|xxx|changeme/i);
    // Real GitHub discussion category node IDs start with DIC_
    expect(DISCUSSIONS_CATEGORY_ID).toMatch(/^DIC_/);
  });

  it('category URL points at the real GitHub Discussions category', () => {
    expect(DISCUSSIONS_CATEGORY_URL).toBe(
      'https://github.com/yosuke1024/JuryPress/discussions/categories/review-comments'
    );
  });
});
