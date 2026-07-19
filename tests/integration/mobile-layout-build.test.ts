import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRefinedFixture } from '../fixtures/refined-review';
import { runAstroBuild } from '../helpers/astro-build';

/**
 * Renders the real site over a content root that (a) holds enough reviews to produce a
 * podium and (b) carries deliberately hostile text — raw GitHub URLs, long unbroken
 * identifiers, long file names — and asserts the layout contract that the mobile
 * remediation established:
 *
 *   - ranking podiums are emitted in rank order, 1 → 2 → 3, on both the overall and the
 *     per-judge boards, so the reading and screen-reader order match the ranking. The
 *     desktop 2 | 1 | 3 arrangement is a grid-area concern only.
 *   - no stylesheet hides the symptom with a page-level `overflow-x: hidden`.
 *
 * Pixel-level overflow at each viewport width is measured by tests/e2e/mobile-layout.spec.ts,
 * which needs a real layout engine; this file pins the parts that are decidable from the
 * generated HTML and CSS.
 */

let contentRoot: string;
let distDir: string;

/** A raw GitHub URL long enough to exceed a 320px viewport on its own. */
const LONG_URL =
  'https://raw.githubusercontent.com/example-organization/extremely-long-repository-name-for-overflow-testing/refs/heads/main/packages/core/src/internal/configuration/DefaultConfigurationResolverFactory.generated.ts';

/** A single token with no break opportunity — the hardest case for wrapping. */
const LONG_TOKEN =
  'AbstractSingletonProxyConfigurationResolverFactoryBeanDelegateImplementationProviderRegistryToken0123456789';

const LONG_FILENAME =
  'DefaultConfigurationResolverFactoryImplementationProviderRegistry.integration.spec.snapshot.generated.ts';

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function html(...segments: string[]): string {
  return fs.readFileSync(path.join(distDir, ...segments, 'index.html'), 'utf8');
}

/** Every CSS file Astro emitted for the build, concatenated. */
function allCss(): string {
  const cssDir = path.join(distDir, '_astro');
  if (!fs.existsSync(cssDir)) return '';
  return fs
    .readdirSync(cssDir)
    .filter(file => file.endsWith('.css'))
    .map(file => fs.readFileSync(path.join(cssDir, file), 'utf8'))
    .join('\n');
}

/**
 * The order in which the three podium places appear in the HTML source. Astro scopes
 * class names but leaves the semantic class intact, so a substring search is enough.
 */
function podiumSourceOrder(page: string): string[] {
  const places = ['first-place', 'second-place', 'third-place'];
  return places
    .map(place => ({ place, at: page.indexOf(place) }))
    .filter(entry => entry.at !== -1)
    .sort((a, b) => a.at - b.at)
    .map(entry => entry.place);
}

/** The rank digits (1/2/3) in the order their podium-rank spans appear in the source. */
function podiumRankLabels(page: string): string[] {
  const section = page.slice(page.indexOf('podium-grid'));
  return [...section.matchAll(/class="podium-rank[^"]*"[^>]*>(\d)</g)].map(m => m[1]);
}

/**
 * Four reviews so the board renders a podium plus a Rankings Ledger row. The Jury Score is
 * recomputed deterministically from the raw criterion scores at load time, so it cannot be
 * nudged from a fixture — these share a score and are separated by the publication-date
 * tie-break. That is fine here: the assertions are about which rank sits where in the
 * source, not about which product wins.
 */
const SPECS = [
  { slug: 'alpha-product' },
  { slug: 'beta-product' },
  { slug: 'gamma-product' },
  { slug: 'delta-product' }
];

describe('mobile layout contract (real build)', () => {
  beforeAll(() => {
    const originalMode = process.env.JURYPRESS_DATA_MODE;
    process.env.JURYPRESS_DATA_MODE = 'fixture';
    let base: ReturnType<typeof createRefinedFixture>;
    try {
      base = createRefinedFixture();
    } finally {
      process.env.JURYPRESS_DATA_MODE = originalMode;
    }

    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-mobile-layout-'));

    SPECS.forEach((spec, index) => {
      const review = JSON.parse(JSON.stringify(base.review));
      const bundle = JSON.parse(JSON.stringify(base.bundle));
      const selection = JSON.parse(JSON.stringify(base.selection));

      review.slug = spec.slug;
      review.published_at = `2026-07-${String(10 + index).padStart(2, '0')}T10:00:00+09:00`;
      review.evaluation.product.name = spec.slug;

      selection.canonical_url = `https://github.com/example/${spec.slug}`;
      selection.source_id = `${spec.slug}-id`;
      selection.candidate_name = spec.slug;
      bundle.metadata_snapshot = {
        ...bundle.metadata_snapshot,
        repository_full_name: `example/${spec.slug}`,
        repository_url: selection.canonical_url
      };

      // The top-ranked review carries the hostile strings, so they land on the podium,
      // on the review page, and in the evidence list all at once.
      if (index === 0) {
        selection.canonical_url = LONG_URL;
        review.evaluation.product.name = LONG_TOKEN;
        review.evaluation.article.evidence_limitations = [
          ...review.evaluation.article.evidence_limitations,
          `Snapshot restricted to ${LONG_FILENAME}.`
        ];
      }

      const reviewDir = path.join(contentRoot, 'reviews', '2026', '07', spec.slug);
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
    });
    writeJson(path.join(contentRoot, 'manifest.json'), { reviews: SPECS.length });

    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-mobile-dist-'));
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

  describe('ranking order is semantic, not CSS-reversed', () => {
    it('emits the overall podium in rank order 1 → 2 → 3', () => {
      const page = html('rankings');
      expect(page).toContain('podium-grid');
      expect(podiumSourceOrder(page)).toEqual(['first-place', 'second-place', 'third-place']);
      expect(podiumRankLabels(page)).toEqual(['1', '2', '3']);
    });

    it('emits every per-judge podium in rank order 1 → 2 → 3', () => {
      for (const judge of ['alex', 'david', 'lisa', 'sarah', 'marcus']) {
        const page = html('rankings', 'judges', judge);
        expect(page, `${judge} podium`).toContain('podium-grid');
        expect(podiumSourceOrder(page), `${judge} podium source order`).toEqual([
          'first-place',
          'second-place',
          'third-place'
        ]);
        expect(podiumRankLabels(page), `${judge} rank labels`).toEqual(['1', '2', '3']);
      }
    });

    it('never reorders the podium with the CSS order property', () => {
      // `order` would decouple the painted order from the DOM order, which is exactly
      // the defect this suite exists to prevent regressing.
      const css = allCss();
      expect(css).not.toMatch(/\.first-place[^{]*\{[^}]*order:\s*\d/);
      expect(css).not.toMatch(/\.second-place[^{]*\{[^}]*order:\s*\d/);
      expect(css).not.toMatch(/\.third-place[^{]*\{[^}]*order:\s*\d/);
    });

    it('places the podium with grid areas, collapsing to source order on mobile', () => {
      const css = allCss().replace(/\s+/g, ' ');
      // Desktop: 2 | 1 | 3 as a visual arrangement.
      expect(css).toMatch(/grid-template-areas: ?"second first third"/);
      // Mobile: one column in source order, so 1 sits above 2 sits above 3.
      expect(css).toMatch(/grid-template-areas: ?"first" ?"second" ?"third"/);
    });
  });

  describe('overflow is fixed, not hidden', () => {
    it('never clips the page with a body- or html-level overflow-x: hidden', () => {
      const css = allCss().replace(/\s+/g, ' ');
      expect(css).not.toMatch(/(^|[,{}])\s*(html|body)\s*\{[^}]*overflow-x: ?hidden/);
      expect(css).not.toMatch(/(^|[,{}])\s*(html|body)\s*\{[^}]*overflow: ?hidden/);
    });

    it('renders the hostile tokens rather than truncating them', () => {
      const page = html('reviews', 'alpha-product');
      expect(page).toContain(LONG_URL);
      expect(page).toContain(LONG_TOKEN);
      expect(page).toContain(LONG_FILENAME);
    });

    it('allows unbreakable tokens to wrap', () => {
      const css = allCss();
      expect(css).toMatch(/overflow-wrap: ?anywhere/);
    });

    it('keeps the judge verdicts table an intentional horizontal scroller', () => {
      const page = html('judges', 'alex');
      expect(page).toContain('verdicts-table-container');
      // The scroll region stays reachable by keyboard and is announced as a region.
      expect(page).toMatch(/verdicts-table-container[^>]*tabindex="0"/);
      expect(allCss()).toMatch(/\.verdicts-table-container[^{]*\{[^}]*overflow-x: ?auto/);
    });
  });

  describe('header offset', () => {
    it('reserves the fixed chrome once, on the body, not again on main', () => {
      const css = allCss().replace(/\s+/g, ' ');
      // `main` contributes only the content gap; it must not re-add a header height.
      expect(css).not.toMatch(/main\s*\{[^}]*margin-top: ?(80|112|130)px/);
      // The body carries the has-context-nav hook that global-header.css offsets against.
      expect(html('rankings')).toMatch(/<body[^>]*class="[^"]*has-context-nav/);
    });
  });

  describe('mobile drawer', () => {
    it('ships an explicit close control inside the drawer', () => {
      const page = html('rankings');
      expect(page).toContain('id="jp-drawer-close"');
      expect(page).toMatch(/jp-drawer-close[^>]*aria-label="Close menu"/);
    });

    it('gives the burger and the close control a 44px minimum target', () => {
      const css = allCss().replace(/\s+/g, ' ');
      expect(css).toMatch(/\.global-header-burger[^{]*\{[^}]*min-height: ?44px/);
      expect(css).toMatch(/\.jp-drawer-close[^{]*\{[^}]*min-height: ?44px/);
    });
  });
});
