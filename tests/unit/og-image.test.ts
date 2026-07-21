import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { buildOgSvg, buildDefaultOgSvg, renderOgPng } from '../../src/lib/og-image';

function entry(overrides: { name?: string; headline?: string } = {}) {
  return {
    review: {
      jury_score: 81.8,
      judge_score_range: { min: 74.0, max: 90.0 },
      published_at: '2026-07-13T00:00:00Z',
      evaluation: {
        product: { name: overrides.name ?? 'Fixture Product' },
        article: { headline: overrides.headline ?? 'Fixture Product: The Ultimate CI Test Subject' },
      },
    },
    selection: { source: 'github' },
  };
}

/** Read width/height out of the PNG IHDR chunk, which starts at byte 16. */
function pngDimensions(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe('OG card', () => {
  it('renders the jury score exactly as recorded', () => {
    const svg = buildOgSvg(entry());
    expect(svg).toContain('>81.8<');
    expect(svg).toContain('RANGE: 74.0 – 90.0');
  });

  it('names only bundled font families on the raster path', () => {
    // System fonts are unavailable on CI, and resvg drops uncovered glyphs without erroring,
    // so a stray Georgia here would ship a card with missing text.
    const svg = buildOgSvg(entry(), 'raster');
    expect(svg).not.toContain('Georgia');
    expect(svg).not.toContain('ui-sans-serif');
    expect(svg).toContain('Noto Serif');
    expect(svg).toContain('Noto Sans');
  });

  it('keeps the web path on the browser font stack', () => {
    expect(buildOgSvg(entry(), 'web')).toContain('ui-sans-serif');
  });

  it('shrinks a long product name instead of running it under the score plate', () => {
    const svg = buildOgSvg(entry({ name: 'Three.js Object Sculptor Codex Plugin' }));
    const fontSize = Number(svg.match(/font-size="(\d+)" font-weight="800" fill="#17201d"/)![1]);

    expect(fontSize).toBeLessThan(64);
    expect(fontSize).toBeGreaterThanOrEqual(34);
    expect(svg).toContain('>Three.js Object Sculptor Codex Plugin<');
  });

  it('truncates a headline too wide for the text column', () => {
    const headline = 'Isolating game streams to keep your Linux host completely free of the guest';
    const svg = buildOgSvg(entry({ headline }));

    expect(svg).not.toContain(headline);
    expect(svg).toMatch(/>Isolating game streams to keep your Linux host\S*\.\.\.</);
  });

  it('strips glyphs the bundled fonts cannot draw', () => {
    const svg = buildOgSvg(entry({ name: 'Moonshine 🌙' }));
    expect(svg).toContain('>Moonshine<');
    expect(svg).not.toContain('🌙');
  });

  it('escapes markup in record-supplied text', () => {
    const svg = buildOgSvg(entry({ name: '<script>&' }));
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;&amp;');
  });

  it('ships every font file the raster path declares', () => {
    for (const file of ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSerif-Bold.ttf']) {
      expect(fs.existsSync(path.resolve(process.cwd(), 'assets/fonts', file))).toBe(true);
    }
  });

  it('rasterizes to a 1200x630 PNG', async () => {
    const png = await renderOgPng(buildOgSvg(entry(), 'raster'));

    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(pngDimensions(png)).toEqual({ width: 1200, height: 630 });
  });

  it('rasterizes the default card for non-review pages', async () => {
    const png = await renderOgPng(buildDefaultOgSvg('raster'));
    expect(pngDimensions(png)).toEqual({ width: 1200, height: 630 });
  });
});
