import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRefinedFixture } from '../fixtures/refined-review';
import { runAstroBuild } from '../helpers/astro-build';

/**
 * Renders the real site over a content root whose reviews straddle the JST year, month and
 * ISO week boundaries, then asserts the generated period ranking pages: which periods exist,
 * who is in them, how few-entry periods render, and how the period navigation is wired.
 */

let contentRoot: string;
let distDir: string;

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function html(...segments: string[]): string {
  return fs.readFileSync(path.join(distDir, ...segments, 'index.html'), 'utf8');
}

function exists(...segments: string[]): boolean {
  return fs.existsSync(path.join(distDir, ...segments, 'index.html'));
}

/**
 * Ranked slugs, in the order the podium / Rankings Ledger link to them. Scraped from the
 * ranking board only — the page header also links to excluded reviews by design.
 */
function rankedSlugs(page: string): string[] {
  const board = page.slice(page.lastIndexOf('</header>'));
  const found: string[] = [];
  for (const match of board.matchAll(/\/reviews\/([a-z0-9-]+)\/?["#]/g)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

interface ReviewSpec {
  slug: string;
  publishedAt: string;
  juryScoreNudge?: number;
  relatedParty?: boolean;
}

/**
 * Season 2 v2.0.0 reviews, published at instants chosen for their JST period membership:
 *
 *   dec-2025      2025-12-31T14:00Z → JST 2025-12-31 → 2025    / 2025-12 / 2026-W01
 *   jan-2026      2025-12-31T15:30Z → JST 2026-01-01 → 2026    / 2026-01 / 2026-W01
 *   jun-2026      2026-06-30T10:00Z → JST 2026-06-30 → 2026    / 2026-06 / 2026-W27
 *   jul-mon/tue/sun                 → JST 2026-07-13..19       / 2026-07 / 2026-W29
 *   related-party 2026-07-15        → excluded from every ranking
 */
const SPECS: ReviewSpec[] = [
  { slug: 'dec-2025', publishedAt: '2025-12-31T14:00:00Z' },
  { slug: 'jan-2026', publishedAt: '2025-12-31T15:30:00Z' },
  { slug: 'jun-2026', publishedAt: '2026-06-30T10:00:00Z' },
  { slug: 'jul-mon', publishedAt: '2026-07-13T00:30:00+09:00', juryScoreNudge: 0 },
  { slug: 'jul-tue', publishedAt: '2026-07-14T10:00:00+09:00', juryScoreNudge: 0 },
  { slug: 'jul-sun', publishedAt: '2026-07-19T23:30:00+09:00', juryScoreNudge: 0 },
  { slug: 'related-party-review', publishedAt: '2026-07-15T10:00:00+09:00', relatedParty: true }
];

describe('period rankings (real build)', () => {
  beforeAll(() => {
    const originalMode = process.env.JURYPRESS_DATA_MODE;
    process.env.JURYPRESS_DATA_MODE = 'fixture';
    let base: ReturnType<typeof createRefinedFixture>;
    try {
      base = createRefinedFixture();
    } finally {
      process.env.JURYPRESS_DATA_MODE = originalMode;
    }

    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-period-rankings-'));

    for (const spec of SPECS) {
      const review = JSON.parse(JSON.stringify(base.review));
      const bundle = JSON.parse(JSON.stringify(base.bundle));
      const selection = JSON.parse(JSON.stringify(base.selection));

      review.slug = spec.slug;
      review.published_at = spec.publishedAt;
      review.evaluation.product.name = spec.slug;
      if (spec.relatedParty) {
        review.relationship = 'related-party';
        review.ranking_eligible = false;
        review.ranking_exclusion_reason = 'Published by the operator of JuryPress.';
      }

      selection.canonical_url = `https://github.com/example/${spec.slug}`;
      selection.source_id = `${spec.slug}-id`;
      selection.candidate_name = spec.slug;
      bundle.metadata_snapshot = {
        ...bundle.metadata_snapshot,
        repository_full_name: `example/${spec.slug}`,
        repository_url: selection.canonical_url
      };

      const year = spec.publishedAt.slice(0, 4);
      const reviewDir = path.join(contentRoot, 'reviews', year, '07', spec.slug);
      writeJson(path.join(reviewDir, 'review.json'), review);
      writeJson(path.join(reviewDir, 'evidence.json'), bundle);
      writeJson(path.join(reviewDir, 'selection.json'), selection);
      writeJson(path.join(contentRoot, 'publication-state', `${spec.slug}.json`), {
        schema_version: '1.0.0',
        data_class: 'production',
        content_id: selection.source_id,
        slug: spec.slug,
        source_canonical_url: selection.canonical_url,
        selected_at: selection.selected_at,
        generated_at: review.published_at,
        generation_run_id: 'season-2-2026-07-16-daily',
        publication_status: 'validated'
      });
    }
    writeJson(path.join(contentRoot, 'manifest.json'), { reviews: SPECS.length });

    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-period-dist-'));
    runAstroBuild(distDir, {
      JURYPRESS_DATA_MODE: 'production',
      JURYPRESS_CONTENT_ROOT: contentRoot,
      JURYPRESS_SITE_URL: 'http://localhost:4321'
    });
  }, 300_000);

  afterAll(() => {
    fs.rmSync(contentRoot, { recursive: true, force: true });
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('generates a page for every period that holds Current Cohort reviews', () => {
    expect(exists('rankings')).toBe(true);
    expect(exists('rankings', 'annual', '2025')).toBe(true);
    expect(exists('rankings', 'annual', '2026')).toBe(true);
    expect(exists('rankings', 'monthly', '2025-12')).toBe(true);
    expect(exists('rankings', 'monthly', '2026-01')).toBe(true);
    expect(exists('rankings', 'monthly', '2026-06')).toBe(true);
    expect(exists('rankings', 'monthly', '2026-07')).toBe(true);
    expect(exists('rankings', 'weekly', '2026-W01')).toBe(true);
    expect(exists('rankings', 'weekly', '2026-W27')).toBe(true);
    expect(exists('rankings', 'weekly', '2026-W29')).toBe(true);
  });

  it('generates no page for periods without Current Cohort reviews', () => {
    // Gaps between populated periods.
    expect(exists('rankings', 'monthly', '2026-02')).toBe(false);
    expect(exists('rankings', 'monthly', '2026-05')).toBe(false);
    expect(exists('rankings', 'weekly', '2026-W02')).toBe(false);
    expect(exists('rankings', 'weekly', '2026-W28')).toBe(false);
    // Future periods.
    expect(exists('rankings', 'annual', '2027')).toBe(false);
    expect(exists('rankings', 'monthly', '2026-08')).toBe(false);
    expect(exists('rankings', 'weekly', '2026-W30')).toBe(false);
  });

  it('applies the JST calendar-year boundary to annual rankings', () => {
    // 2025-12-31T14:00Z is still 2025 in JST; 2025-12-31T15:30Z is already 2026.
    expect(rankedSlugs(html('rankings', 'annual', '2025'))).toEqual(['dec-2025']);
    const y2026 = rankedSlugs(html('rankings', 'annual', '2026'));
    expect(y2026).toContain('jan-2026');
    expect(y2026).not.toContain('dec-2025');
  });

  it('applies the JST calendar-month boundary to monthly rankings', () => {
    expect(rankedSlugs(html('rankings', 'monthly', '2025-12'))).toEqual(['dec-2025']);
    expect(rankedSlugs(html('rankings', 'monthly', '2026-01'))).toEqual(['jan-2026']);
    expect(rankedSlugs(html('rankings', 'monthly', '2026-06'))).toEqual(['jun-2026']);
  });

  it('groups Monday through Sunday into one ISO week, using the ISO week-year', () => {
    // Monday 2026-07-13 00:30 JST and Sunday 2026-07-19 23:30 JST share week 29.
    const w29 = rankedSlugs(html('rankings', 'weekly', '2026-W29'));
    expect(w29.sort()).toEqual(['jul-mon', 'jul-sun', 'jul-tue']);

    // 2025-12-31 and 2026-01-01 (JST) fall in different years and months but in the same
    // ISO week, which belongs to week-year 2026 — not 2025.
    expect(rankedSlugs(html('rankings', 'weekly', '2026-W01')).sort()).toEqual(['dec-2025', 'jan-2026']);
    expect(exists('rankings', 'weekly', '2025-W01')).toBe(false);
  });

  it('shows the podium for three or more entries and plain cards below that', () => {
    const three = html('rankings', 'weekly', '2026-W29');
    expect(three).toContain('Top Three Products');
    expect(three).toContain('podium-grid');

    const two = html('rankings', 'weekly', '2026-W01');
    expect(two).not.toContain('podium-grid');
    expect(two).toContain('simple-cards-grid');
    expect(two).not.toContain('Rankings Ledger');

    const one = html('rankings', 'weekly', '2026-W27');
    expect(one).not.toContain('podium-grid');
    expect(one).toContain('simple-cards-grid');
  });

  it('excludes non-Current-Cohort reviews from every ranking surface', () => {
    const surfaces = [
      html('rankings'),
      html('rankings', 'annual', '2026'),
      html('rankings', 'monthly', '2026-07'),
      html('rankings', 'weekly', '2026-W29')
    ];
    for (const surface of surfaces) {
      expect(rankedSlugs(surface)).not.toContain('related-party-review');
    }
    // The related-party review itself stays published and reachable.
    expect(exists('reviews', 'related-party-review')).toBe(true);
  });

  it('ranks all-time and each period with the same population and order', () => {
    const allTime = rankedSlugs(html('rankings'));
    expect(allTime.sort()).toEqual(['dec-2025', 'jan-2026', 'jul-mon', 'jul-sun', 'jul-tue', 'jun-2026']);

    // Every July entry appears on the July page in the same relative order as all-time.
    const july = rankedSlugs(html('rankings', 'monthly', '2026-07'));
    const allTimeOrder = rankedSlugs(html('rankings')).filter(slug => july.includes(slug));
    expect(july).toEqual(allTimeOrder);
  });

  it('offers the period switcher on the all-time page, pointing at the latest period', () => {
    const page = html('rankings');
    expect(page).toContain('/rankings/annual/2026/');
    expect(page).toContain('/rankings/monthly/2026-07/');
    expect(page).toContain('/rankings/weekly/2026-W29/');
  });

  it('links each period page to its previous and next existing period', () => {
    const june = html('rankings', 'monthly', '2026-06');
    expect(june).toContain('/rankings/monthly/2026-01/'); // previous existing, skipping empty months
    expect(june).toContain('/rankings/monthly/2026-07/'); // next existing

    const latest = html('rankings', 'monthly', '2026-07');
    expect(latest).toContain('No later period');

    const earliest = html('rankings', 'monthly', '2025-12');
    expect(earliest).toContain('No earlier period');
  });

  it('offers a history selector listing every existing period', () => {
    const page = html('rankings', 'monthly', '2026-07');
    expect(page).toContain('period-history-select');
    for (const key of ['2025-12', '2026-01', '2026-06', '2026-07']) {
      expect(page).toContain(`/rankings/monthly/${key}/`);
    }
  });

  it('describes the response-first failure handling on the methodology page', () => {
    const page = html('methodology');
    expect(page).not.toMatch(/retries up to 3 times/i);
    expect(page).not.toMatch(/up to 3 (times|attempts|retries)/i);
    expect(page).toContain('excluded');
    expect(page).toMatch(/persisted to the Generation Record/i);
    expect(page).toMatch(/judged exactly once|single time/i);
    expect(page).toMatch(/429/);
    expect(page).toMatch(/503/);
    expect(page).toMatch(/timeout/i);
    expect(page).toMatch(/resuming reuses it instead of calling the model again/i);
    // The score-immutability statement is preserved.
    expect(page).toMatch(/scores are\s*\n?\s*not changed|cannot be changed by a human/i);
  });

  it('keeps the day-of-week rotation and eligibility gate untouched', () => {
    const page = html('methodology');
    expect(page).toContain('Hacker News Top');
    expect(page).toContain('GitHub Breakout');
    expect(page).toContain('Cross-source compilation');
    expect(page).toContain('Open Source Eligibility Gate');
    // Reader requests are now an implemented, documented path — the methodology must
    // describe them as operator-approved, same-gate, no-score-influence, and must not
    // promise anything unimplemented (no automatic issue execution, no review-free
    // publication).
    expect(page).toMatch(/Operator-approved Reader Request/);
    expect(page).toMatch(/same Eligibility Gate/i);
    expect(page).toMatch(/never used as evaluation\s*\n?\s*evidence/i);
    expect(page).toMatch(/no effect on the Jury Score/i);
    expect(page).not.toMatch(/automatic(ally)? (issue )?execut/i);
  });

  it('no longer claims NO HUMAN EDITOR on any public surface', () => {
    const pages = ['index.html', path.join('rankings', 'index.html'), path.join('methodology', 'index.html')];
    for (const page of pages) {
      expect(fs.readFileSync(path.join(distDir, page), 'utf8')).not.toContain('NO HUMAN EDITOR');
    }
    expect(html('methodology')).toContain('HUMAN EDITING DISCLOSED');
  });
});
