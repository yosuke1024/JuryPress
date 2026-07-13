import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Brand attribution integration tests.
 *
 * These tests verify that brand attribution text appears in the built HTML.
 * They require `npm run build` to have been run first.
 */

const distDir = path.join(process.cwd(), 'dist');

function readHtml(relativePath: string): string {
  const filePath = path.join(distDir, relativePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Build output not found: ${filePath}. Run 'npm run build' first.`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

describe('Brand Attribution in Build Output', () => {
  let indexHtml: string;

  beforeAll(() => {
    if (!fs.existsSync(distDir)) {
      throw new Error(`dist/ directory not found. Run 'npm run build' first.`);
    }
    // Try common build output paths for Astro with base path
    const possiblePaths = ['index.html', 'JuryPress/index.html'];
    for (const p of possiblePaths) {
      const full = path.join(distDir, p);
      if (fs.existsSync(full)) {
        indexHtml = fs.readFileSync(full, 'utf8');
        return;
      }
    }
    throw new Error('Could not find index.html in dist/');
  });

  it('should contain "A PixApps experiment" in the header', () => {
    expect(indexHtml).toContain('A <a');
    expect(indexHtml).toContain('PixApps');
    expect(indexHtml).toContain('experiment');
  });

  it('should contain Judgie-AI link in the page', () => {
    expect(indexHtml).toContain('Judgie-AI');
  });

  it('should contain footer brand attribution', () => {
    expect(indexHtml).toContain('Jury personas and evaluation rubric are sourced from');
  });

  it('should contain UTM parameters in links', () => {
    expect(indexHtml).toContain('utm_source=jurypress');
    expect(indexHtml).toContain('utm_medium=referral');
    expect(indexHtml).toContain('utm_campaign=product_ecosystem');
  });

  it('should not contain old PixApps CTA bar text', () => {
    expect(indexHtml).not.toContain('Discover more tools at');
  });

  it('should contain PixApps URL with HTTPS', () => {
    expect(indexHtml).toContain('https://pixapps.ai/');
  });

  it('should contain Judgie-AI URL with HTTPS', () => {
    expect(indexHtml).toContain('https://github.com/yosuke1024/Judgie-AI');
  });
});
