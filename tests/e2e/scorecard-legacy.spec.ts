import { test, expect } from '@playwright/test';

// Legacy (1.0.0 / 2.0.0) reviews keep their decisive question, rendered with the exact
// label DECISIVE QUESTION — never relabeled as a recommendation. The fixture review is a
// 1.0.0 article, so this exercises the legacy renderer path end to end.
test.describe('Legacy scorecard rendering', () => {
  test('renders DECISIVE QUESTION for legacy reviews, never a recommendation label', async ({ page }) => {
    await page.goto('reviews/fixture-product/');

    const questionTags = page.locator('.decisive-question-block .section-tag');
    await expect(questionTags.first()).toHaveText('DECISIVE QUESTION');
    expect(await questionTags.count()).toBe(5);

    await expect(page.locator('.next-step-block')).toHaveCount(0);
    await expect(page.getByText('RECOMMENDED NEXT STEP')).toHaveCount(0);
  });
});
