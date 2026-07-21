import * as fs from 'fs';
import * as path from 'path';
import { getConsensus } from './verdict';

// Resolved from the project root rather than `import.meta.url`: this module is bundled into
// dist/.prerender/chunks at build time, so a path relative to the module points nowhere.
const FONT_DIR = path.resolve(process.cwd(), 'assets/fonts');

// The bundled faces resvg rasterizes with. Georgia and `ui-sans-serif` exist on a designer's
// Mac and on nobody's CI runner, so the raster path names Noto explicitly and ships the files:
// a missing family makes resvg drop the glyphs silently instead of failing the build.
const FONT_FILES = [
  'NotoSans-Regular.ttf',
  'NotoSans-Bold.ttf',
  'NotoSerif-Bold.ttf',
].map((name) => path.join(FONT_DIR, name));

/**
 * Font stacks the card is drawn with.
 *
 * `web` keeps the browser-facing stack for the SVG route, where the reader's own system fonts
 * are the best available rendering. `raster` names only bundled families, so the PNG is
 * byte-identical between a local build and CI.
 */
const FONT_STACKS = {
  web: {
    sans: "ui-sans-serif, system-ui, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
  },
  raster: {
    sans: "Noto Sans",
    serif: "Noto Serif",
  },
} as const;

export type OgFontStack = keyof typeof FONT_STACKS;

// The card is drawn at absolute coordinates, so text that is too wide runs under the score
// plate instead of wrapping. Nothing in the SVG pipeline can measure a string, so widths are
// estimated from per-character advances. The table is approximate; callers leave a margin.
const NARROW_CHARS = new Set(" iljI.,!|'`;:()[]{}-/\\".split(''));
const WIDE_CHARS = new Set('mwMW@%'.split(''));

function estimateTextWidth(text: string, fontSizePx: number, widthFactor = 1): number {
  let ems = 0;
  for (const char of text) {
    if (char === ' ') ems += 0.26;
    else if (NARROW_CHARS.has(char)) ems += 0.32;
    else if (WIDE_CHARS.has(char)) ems += 0.88;
    else if (char >= 'A' && char <= 'Z') ems += 0.68;
    else ems += 0.56;
  }
  return ems * fontSizePx * widthFactor;
}

/** Drop what the bundled faces cannot draw. An uncovered glyph renders as a tofu box. */
function stripUnsupportedGlyphs(text: string): string {
  return text
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncate to the widest prefix that fits, appending an ellipsis when anything is dropped. */
function fitToWidth(text: string, fontSizePx: number, maxWidthPx: number, widthFactor = 1): string {
  if (estimateTextWidth(text, fontSizePx, widthFactor) <= maxWidthPx) return text;

  let truncated = text;
  while (truncated.length > 1 && estimateTextWidth(truncated + '...', fontSizePx, widthFactor) > maxWidthPx) {
    truncated = truncated.slice(0, -1);
  }
  return truncated.trimEnd() + '...';
}

/** Shrink the type until the string fits, so a long product name stays readable in full. */
function fitFontSize(text: string, maxFontSizePx: number, minFontSizePx: number, maxWidthPx: number, widthFactor = 1): number {
  let size = maxFontSizePx;
  while (size > minFontSizePx && estimateTextWidth(text, size, widthFactor) > maxWidthPx) {
    size -= 1;
  }
  return size;
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
    return c;
  });
}

export function buildOgSvg(entry: any, stack: OgFontStack = 'web'): string {
  const { review, selection } = entry;
  const sans = FONT_STACKS[stack].sans;
  const serif = FONT_STACKS[stack].serif;

  // The score plate starts at x=800 and the text column at x=80, so anything wider than this
  // collides with it.
  const TEXT_COLUMN_WIDTH = 690;

  const rawName = stripUnsupportedGlyphs(review.evaluation.product.name);
  const nameFontSize = fitFontSize(rawName, 64, 34, TEXT_COLUMN_WIDTH, 1.02);
  const productName = escapeXml(fitToWidth(rawName, nameFontSize, TEXT_COLUMN_WIDTH, 1.02));

  const headline = escapeXml(
    fitToWidth(stripUnsupportedGlyphs(review.evaluation.article.headline), 28, TEXT_COLUMN_WIDTH)
  );

  const score = review.jury_score.toFixed(1);
  const minScore = review.judge_score_range.min.toFixed(1);
  const maxScore = review.judge_score_range.max.toFixed(1);
  const source = escapeXml(selection.source);
  const date = new Date(review.published_at).toISOString().split('T')[0];

  // Calculate Consensus Label
  const { label: consensusLabel } = getConsensus(review.judge_score_range);

  return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
    <!-- Warm paper canvas background -->
    <rect width="100%" height="100%" fill="#f4efe6"/>

    <!-- Outer thin border -->
    <rect x="30" y="30" width="1140" height="570" fill="none" stroke="#d5ccbd" stroke-width="1"/>
    <rect x="40" y="40" width="1120" height="550" fill="none" stroke="#aaa091" stroke-width="1"/>

    <!-- Header Border -->
    <line x1="80" y1="110" x2="1120" y2="110" stroke="#d5ccbd" stroke-width="1"/>

    <!-- Header Content -->
    <text x="80" y="90" font-family="${sans}" font-size="18" font-weight="700" fill="#5f6762" letter-spacing="1">PixApps  /  JuryPress</text>
    <text x="1120" y="90" font-family="${sans}" font-size="14" font-weight="700" fill="#b85c2d" letter-spacing="2" text-anchor="end">HUMAN EDITING DISCLOSED · EXPERIMENT</text>

    <!-- Product name (large, bold editorial serif) -->
    <text x="80" y="220" font-family="${serif}" font-size="${nameFontSize}" font-weight="800" fill="#17201d" letter-spacing="-1">${productName}</text>

    <!-- Shortened editorial headline -->
    <text x="80" y="290" font-family="${sans}" font-size="28" font-weight="500" fill="#5f6762" line-height="1.4">${headline}</text>

    <!-- Table style ruler dividing metadata -->
    <line x1="80" y1="460" x2="720" y2="460" stroke="#d5ccbd" stroke-width="1"/>

    <!-- 5-Judge initials circles representation -->
    <g transform="translate(80, 500)">
      <!-- Alex -->
      <circle cx="20" cy="0" r="20" fill="#fffdf8" stroke="#17201d" stroke-width="1.5" />
      <text x="20" y="5" font-family="${serif}" font-size="14" font-weight="bold" fill="#17201d" text-anchor="middle">A</text>
      <!-- David -->
      <circle cx="65" cy="0" r="20" fill="#fffdf8" stroke="#17201d" stroke-width="1.5" />
      <text x="65" y="5" font-family="${serif}" font-size="14" font-weight="bold" fill="#17201d" text-anchor="middle">D</text>
      <!-- Lisa -->
      <circle cx="110" cy="0" r="20" fill="#fffdf8" stroke="#17201d" stroke-width="1.5" />
      <text x="110" y="5" font-family="${serif}" font-size="14" font-weight="bold" fill="#17201d" text-anchor="middle">L</text>
      <!-- Sarah -->
      <circle cx="155" cy="0" r="20" fill="#fffdf8" stroke="#17201d" stroke-width="1.5" />
      <text x="155" y="5" font-family="${serif}" font-size="14" font-weight="bold" fill="#17201d" text-anchor="middle">S</text>
      <!-- Marcus -->
      <circle cx="200" cy="0" r="20" fill="#fffdf8" stroke="#17201d" stroke-width="1.5" />
      <text x="200" y="5" font-family="${serif}" font-size="14" font-weight="bold" fill="#17201d" text-anchor="middle">M</text>

      <text x="240" y="5" font-family="${sans}" font-size="14" font-weight="600" fill="#7a817c">5 AI JUDGES</text>
    </g>

    <!-- Source and Date info -->
    <text x="80" y="550" font-family="${sans}" font-size="14" font-weight="700" fill="#7a817c">SOURCE: ${source.toUpperCase()}  ·  PUBLISHED: ${date}</text>

    <!-- Right Side Score Box (Verdict Plate style) -->
    <g transform="translate(800, 160)">
      <rect x="0" y="0" width="320" height="340" fill="#fffdf8" stroke="#17201d" stroke-width="2" rx="4"/>

      <text x="160" y="40" font-family="${sans}" font-size="14" font-weight="700" fill="#5f6762" letter-spacing="1" text-anchor="middle">JURY SCORE</text>

      <text x="160" y="140" font-family="${sans}" font-size="96" font-weight="800" fill="#17201d" text-anchor="middle">${score}</text>
      <text x="160" y="175" font-family="${sans}" font-size="20" font-weight="700" fill="#7a817c" text-anchor="middle">/ 100</text>

      <line x1="40" y1="210" x2="280" y2="210" stroke="#aaa091" stroke-width="1"/>

      <text x="160" y="245" font-family="${sans}" font-size="16" font-weight="600" fill="#5f6762" text-anchor="middle">RANGE: ${minScore} – ${maxScore}</text>
      <text x="160" y="290" font-family="${sans}" font-size="18" font-weight="800" fill="#b85c2d" text-anchor="middle">${consensusLabel.toUpperCase()}</text>
    </g>
  </svg>`;
}

/**
 * The card for pages that are not a single review — the index, rankings, methodology. Layout
 * points at this whenever no per-review `ogImage` is passed.
 */
export function buildDefaultOgSvg(stack: OgFontStack = 'web'): string {
  const sans = FONT_STACKS[stack].sans;
  const serif = FONT_STACKS[stack].serif;
  const initials = ['A', 'D', 'L', 'S', 'M'];

  return `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#f4efe6"/>

    <rect x="30" y="30" width="1140" height="570" fill="none" stroke="#d5ccbd" stroke-width="1"/>
    <rect x="40" y="40" width="1120" height="550" fill="none" stroke="#aaa091" stroke-width="1"/>

    <line x1="80" y1="110" x2="1120" y2="110" stroke="#d5ccbd" stroke-width="1"/>

    <text x="80" y="90" font-family="${sans}" font-size="18" font-weight="700" fill="#5f6762" letter-spacing="1">PixApps  /  JuryPress</text>
    <text x="1120" y="90" font-family="${sans}" font-size="14" font-weight="700" fill="#b85c2d" letter-spacing="2" text-anchor="end">HUMAN EDITING DISCLOSED · EXPERIMENT</text>

    <text x="80" y="300" font-family="${serif}" font-size="88" font-weight="800" fill="#17201d" letter-spacing="-2">JuryPress</text>
    <text x="80" y="360" font-family="${sans}" font-size="28" font-weight="500" fill="#5f6762">The automated AI review media</text>

    <line x1="80" y1="460" x2="1120" y2="460" stroke="#d5ccbd" stroke-width="1"/>

    <g transform="translate(80, 520)">
      ${initials
        .map(
          (initial, i) => `<circle cx="${20 + i * 45}" cy="0" r="20" fill="#fffdf8" stroke="#17201d" stroke-width="1.5" />
      <text x="${20 + i * 45}" y="5" font-family="${serif}" font-size="14" font-weight="bold" fill="#17201d" text-anchor="middle">${initial}</text>`
        )
        .join('\n      ')}
      <text x="240" y="5" font-family="${sans}" font-size="14" font-weight="600" fill="#7a817c">5 AI JUDGES · EVERY VERDICT SCORED AND PUBLISHED</text>
    </g>
  </svg>`;
}

/**
 * Rasterize a card to PNG. X only renders PNG/JPEG/WEBP/GIF for `summary_large_image`, so the
 * SVG route alone leaves every shared link without a card.
 */
export async function renderOgPng(svg: string): Promise<Uint8Array<ArrayBuffer>> {
  const missing = FONT_FILES.filter((file) => !fs.existsSync(file));
  if (missing.length > 0) {
    throw new Error(
      `OG card fonts are missing, which would produce a card with no text: ${missing.join(', ')}`
    );
  }

  const { Resvg } = await import('@resvg/resvg-js');
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
    font: {
      // System fonts would resolve differently on a Mac and on a CI runner, so the bundled
      // files are the only ones in scope.
      loadSystemFonts: false,
      fontFiles: FONT_FILES,
      defaultFontFamily: 'Noto Sans',
    },
  });

  // Copied out of the Node Buffer: a Response body needs a view backed by a plain ArrayBuffer.
  return new Uint8Array(resvg.render().asPng());
}
