import { describe, it, expect } from 'vitest';
import { checkEligibilityGate } from '../../src/lib/selection/eligibility';
import { hasRunnabilityEvidence } from '../../src/lib/evidence/runnability';
import type { Candidate } from '../../src/schemas/selection';
import type { Evidence } from '../../src/schemas/evidence';

/**
 * Selection and publication must reach the same runnability verdict.
 *
 * They did not. The eligibility gate accepted a `homepage` field, or a README containing
 * 'install', 'demo' — or 'https://', which every README contains — while the publication
 * gate demanded a manifest, an executing CI workflow or a documented run command. A
 * candidate in the gap between them was reserved, generated, mapped and quality-passed, and
 * then killed the run at the build step with a `generated` record that permanently excludes
 * the candidate from re-selection. Runs season-2-2026-09-04-daily and season-2-2026-09-05-daily
 * are the two consecutive days that cost.
 */

function candidate(): Candidate {
  return {
    source: 'github_oss',
    sourceId: '1',
    name: 'owner/repo',
    canonicalUrl: 'https://github.com/owner/repo',
    sourceUrl: 'https://github.com/owner/repo',
    sourceRank: 1,
    popularityValue: 500,
    popularityUnit: 'stars',
    collectedAt: '2026-09-05T00:00:00.000Z',
    metadata: {}
  } as Candidate;
}

/** A bundle whose only variable is the README — everything else passes every other check. */
function evidences(readme: string, presence: Record<string, boolean> = {}): Evidence[] {
  return [
    {
      type: 'api_metadata',
      url: 'https://api.github.com/repos/owner/repo',
      summary: JSON.stringify({
        stargazers_count: 500,
        license_spdx: 'MIT',
        homepage: 'https://owner.invalid',
        description: 'A widget.',
        pushed_at: '2026-09-01T00:00:00.000Z',
        topics: [],
        presence: { package_manifest: false, container_build: false, workflows: false, ...presence }
      })
    },
    { type: 'readme', url: 'https://raw.githubusercontent.com/owner/repo/main/README.md', summary: readme }
  ] as unknown as Evidence[];
}

const notRunnable = (readme: string, presence?: Record<string, boolean>) =>
  checkEligibilityGate(candidate(), evidences(readme, presence)).includes('not_runnable');

describe('the eligibility gate applies the publication gate\'s runnability rule', () => {
  it('rejects a README that only reads as runnable to a keyword scan', () => {
    // Each of these satisfied the old gate and none satisfies the publication gate: a
    // reserved candidate that could never have been published.
    expect(notRunnable('A curated list. Setup notes and a demo live at https://owner.invalid.')).toBe(true);
    expect(notRunnable('Install the extension from the store, then build your own presets.')).toBe(true);
  });

  it('no longer accepts a homepage field as a substitute for runnability', () => {
    // `homepage` is set in every bundle above; only the README below makes it eligible.
    expect(notRunnable('A widget with a website.')).toBe(true);
    expect(notRunnable('A widget. Install it with npm install widget.')).toBe(false);
  });

  it('accepts the two shapes the 2026-09-04/05 runs proved publishable', () => {
    expect(notRunnable('## Install\nnpx skills add owner/repo -g')).toBe(false);
    expect(notRunnable('## Install\ncurl -fsSL https://owner.invalid/install.sh | bash')).toBe(false);
  });

  it('accepts an attested package manifest without reading the README at all', () => {
    expect(notRunnable('A widget.', { package_manifest: true })).toBe(false);
  });

  it('reaches the same verdict as the publication gate for every case above', () => {
    for (const readme of [
      'A curated list. Setup notes and a demo live at https://owner.invalid.',
      'A widget with a website.',
      'A widget. Install it with npm install widget.',
      '## Install\nnpx skills add owner/repo -g'
    ]) {
      const bundle = evidences(readme);
      const metadata = JSON.parse(bundle[0].summary);
      expect(notRunnable(readme), readme).toBe(!hasRunnabilityEvidence(metadata, bundle));
    }
  });
});
