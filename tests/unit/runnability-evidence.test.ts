import { describe, it, expect } from 'vitest';
import { hasRunnabilityEvidence } from '../../scripts/validate-content';

/**
 * Publication-gate runnability evidence. The three deterministic acceptance routes
 * (root manifest/container attestation; CI that installs AND executes repository code;
 * README run command) and every rejected shape. Minimal reproduction of production record
 * season-2-manual-29633364803 (public-apis/public-apis): no package manifest, no container
 * build, but an attested CI workflow that pip-installs its requirements and runs a
 * repository validation script.
 */

function metadata(presence: Record<string, boolean>) {
  return { stargazers_count: 42, license_spdx: 'MIT', presence };
}

function ci(summary: string) {
  return { evidence_id: 'ev-ci', type: 'ci_workflow', summary } as any;
}

function readme(summary: string) {
  return { evidence_id: 'ev-readme', type: 'readme', summary } as any;
}

// Mirrors the shape of the public-apis "Tests of push & pull" workflow.
const PUBLIC_APIS_STYLE_WORKFLOW = [
  'name: "Tests of push & pull"',
  'steps:',
  '  - name: Install dependencies',
  '    run: python -m pip install -r scripts/requirements.txt',
  '  - name: Validate Markdown format',
  '    run: python scripts/validate/format.py README.md'
].join('\n');

describe('hasRunnabilityEvidence — accepted routes', () => {
  it('accepts an attested package manifest (unchanged short-circuit)', () => {
    expect(hasRunnabilityEvidence(metadata({ package_manifest: true, container_build: false }), [])).toBe(true);
  });

  it('accepts an attested container build (unchanged short-circuit)', () => {
    expect(hasRunnabilityEvidence(metadata({ package_manifest: false, container_build: true }), [])).toBe(true);
  });

  it('accepts attested CI that installs dependencies and executes a repository script (public-apis shape)', () => {
    expect(hasRunnabilityEvidence(
      metadata({ package_manifest: false, container_build: false, workflows: true }),
      [ci(PUBLIC_APIS_STYLE_WORKFLOW)]
    )).toBe(true);
  });

  it('accepts attested CI that installs and runs a canonical test runner', () => {
    expect(hasRunnabilityEvidence(
      metadata({ package_manifest: false, container_build: false, workflows: true }),
      [ci('run: npm ci\nrun: npm test')]
    )).toBe(true);
  });

  it('accepts a README documenting git clone', () => {
    expect(hasRunnabilityEvidence(
      metadata({ package_manifest: false, container_build: false }),
      [readme('## Install\nRun git clone https://example.invalid/repo.git and follow the steps.')]
    )).toBe(true);
  });
});

describe('hasRunnabilityEvidence — rejected shapes stay fail-closed', () => {
  it('rejects CI evidence when the API metadata does not attest workflows', () => {
    expect(hasRunnabilityEvidence(
      metadata({ package_manifest: false, container_build: false, workflows: false }),
      [ci(PUBLIC_APIS_STYLE_WORKFLOW)]
    )).toBe(false);
  });

  it('rejects attested workflows with no collected ci_workflow evidence', () => {
    expect(hasRunnabilityEvidence(
      metadata({ package_manifest: false, container_build: false, workflows: true }),
      []
    )).toBe(false);
  });

  it('rejects a workflow of pure `uses:` actions that never runs anything', () => {
    expect(hasRunnabilityEvidence(
      metadata({ package_manifest: false, container_build: false, workflows: true }),
      [ci('steps:\n  - uses: actions/checkout@v4\n  - uses: actions/stale@v9')]
    )).toBe(false);
  });

  it('rejects an echo-only workflow', () => {
    expect(hasRunnabilityEvidence(
      metadata({ package_manifest: false, container_build: false, workflows: true }),
      [ci('run: echo "hello"')]
    )).toBe(false);
  });

  it('rejects a workflow that installs dependencies but executes nothing', () => {
    expect(hasRunnabilityEvidence(
      metadata({ package_manifest: false, container_build: false, workflows: true }),
      [ci('run: python -m pip install -r scripts/requirements.txt')]
    )).toBe(false);
  });

  it('rejects a bare "clone" in prose — a product description is not a run instruction', () => {
    expect(hasRunnabilityEvidence(
      metadata({ package_manifest: false, container_build: false }),
      [readme('| Saidit | Open Source Reddit Clone | OAuth | Yes |')]
    )).toBe(false);
  });

  it('rejects a bundle with no runnability signal at all', () => {
    expect(hasRunnabilityEvidence(
      metadata({ package_manifest: false, container_build: false }),
      [readme('A curated list of things.')]
    )).toBe(false);
  });
});

/**
 * Apple-platform projects. Production run season-2-2026-08-29-daily (YangJiiii/3105) was
 * generated, passed the quality gate, and then failed the publication gate as unrunnable:
 * a native iOS app has no npm/pip-style manifest, no container build and no CI, and its
 * README documents Xcode rather than a shell command. The bundle a resumed run replays is
 * frozen at collection time, so the manifest has to be readable from the README too.
 */
describe('hasRunnabilityEvidence — Apple-platform projects', () => {
  it('accepts a README naming an Xcode project when every presence flag is false (3105 shape)', () => {
    expect(hasRunnabilityEvidence(
      metadata({ package_manifest: false, container_build: false, workflows: false }),
      [readme('## Project layout\n├── ThreeOneOSFive.xcodeproj # Xcode project and 3105 scheme')]
    )).toBe(true);
  });

  it('accepts a README naming a SwiftPM manifest, a workspace or a Podfile', () => {
    const flags = metadata({ package_manifest: false, container_build: false });
    expect(hasRunnabilityEvidence(flags, [readme('Open `Package.swift` in Xcode.')])).toBe(true);
    expect(hasRunnabilityEvidence(flags, [readme('Open `App.xcworkspace`.')])).toBe(true);
    expect(hasRunnabilityEvidence(flags, [readme('Dependencies live in the Podfile.')])).toBe(true);
  });

  it('accepts a README documenting a Swift or CocoaPods run command', () => {
    const flags = metadata({ package_manifest: false, container_build: false });
    expect(hasRunnabilityEvidence(flags, [readme('Build it with swift build, then run the binary.')])).toBe(true);
    expect(hasRunnabilityEvidence(flags, [readme('Run xcodebuild -scheme App.')])).toBe(true);
    expect(hasRunnabilityEvidence(flags, [readme('Run pod install first.')])).toBe(true);
  });

  it('rejects a README that only says the product is a Swift iOS app', () => {
    expect(hasRunnabilityEvidence(
      metadata({ package_manifest: false, container_build: false, workflows: false }),
      [readme('A beautiful native iOS app written in Swift and SwiftUI. Screenshots below.')]
    )).toBe(false);
  });
});
