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
const possiblePaths = [
  path.join(distDir, 'index.html'),
  path.join(distDir, 'JuryPress', 'index.html')
];
const hasBuildOutput = possiblePaths.some(p => fs.existsSync(p));

describe.runIf(hasBuildOutput)('Brand Attribution in Build Output', () => {
  let indexHtml: string;

  beforeAll(() => {
    const foundPath = possiblePaths.find(p => fs.existsSync(p));
    if (!foundPath) {
      throw new Error('Build output not found');
    }
    indexHtml = fs.readFileSync(foundPath, 'utf8');
  });

  it('should contain "PixApps" link in the header', () => {
    expect(indexHtml).toContain('PixApps');
  });

  it('should contain Judgie-AI link in the page', () => {
    expect(indexHtml).toContain('Judgie-AI');
  });

  it('should contain footer brand attribution', () => {
    expect(indexHtml).toContain('Jury personas and the evaluation rubric come from');
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
