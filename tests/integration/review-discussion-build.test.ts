import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runAstroBuild } from '../helpers/astro-build';

/**
 * Builds the real site in fixture mode and inspects the generated HTML to
 * verify the giscus discussion embed is wired correctly on review pages
 * only — not on the archive, rankings, judge, or methodology pages.
 */

let distDir: string;

describe('Review discussion embed (real build)', () => {
  beforeAll(() => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-discussion-dist-'));
    runAstroBuild(distDir, { JURYPRESS_DATA_MODE: 'fixture' });
  }, 300_000);

  afterAll(() => {
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('renders the discussion section on the fixture review page', () => {
    const html = fs.readFileSync(path.join(distDir, 'reviews', 'fixture-product', 'index.html'), 'utf8');
    expect(html).toContain('Discuss this review');
    expect(html).toContain('Open GitHub Discussions');
    expect(html).toContain('https://github.com/yosuke1024/JuryPress/discussions/categories/review-comments');
  });

  it('includes the giscus script with correct data attributes on the review page', () => {
    const html = fs.readFileSync(path.join(distDir, 'reviews', 'fixture-product', 'index.html'), 'utf8');
    expect(html).toContain('src="https://giscus.app/client.js"');
    expect(html).toContain('data-repo="yosuke1024/JuryPress"');
    expect(html).toContain('data-repo-id="R_kgDOTW0LAA"');
    expect(html).toContain('data-category="Review Comments"');
    expect(html).toContain('data-category-id="DIC_kwDOTW0LAM4DBb8x"');
    expect(html).toContain('data-mapping="specific"');
    expect(html).toContain('data-strict="1"');
    expect(html).toContain('data-term="JuryPress review: fixture-product"');
    expect(html).toContain('data-loading="lazy"');
  });

  it('does not render the giscus script on the review archive index', () => {
    const html = fs.readFileSync(path.join(distDir, 'reviews', 'index.html'), 'utf8');
    expect(html).not.toContain('giscus.app/client.js');
    expect(html).not.toContain('Discuss this review');
  });

  it('does not render the giscus script on the rankings page', () => {
    const html = fs.readFileSync(path.join(distDir, 'rankings', 'index.html'), 'utf8');
    expect(html).not.toContain('giscus.app/client.js');
  });

  it('does not render the giscus script on a judge page', () => {
    const judgeFile = path.join(distDir, 'judges', 'alex', 'index.html');
    if (fs.existsSync(judgeFile)) {
      const html = fs.readFileSync(judgeFile, 'utf8');
      expect(html).not.toContain('giscus.app/client.js');
    }
  });

  it('does not render the giscus script on the homepage', () => {
    const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
    expect(html).not.toContain('giscus.app/client.js');
  });
});
