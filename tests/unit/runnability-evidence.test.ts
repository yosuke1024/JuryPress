import { describe, it, expect } from 'vitest';
import { hasRunnabilityEvidence } from '../../src/lib/evidence/runnability';

/**
 * Runnability evidence, the rule both the selector and the publication gate apply. The
 * deterministic acceptance routes (root manifest/container attestation; CI that installs AND
 * executes repository code; a shipped executable script; README run command) and every
 * rejected shape. Minimal reproduction of production record
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

/** A collected file evidence, addressed the way the collector addresses one. */
function file(repoPath: string, type = 'source_code') {
  return {
    evidence_id: `ev-${type}`,
    type,
    summary: 'irrelevant',
    url: `https://raw.githubusercontent.com/acme/widget/main/${repoPath}`
  } as any;
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

/**
 * Modern package runners. The substring hint list predates them, so a project whose only
 * documented install is `npx`, `uv` or `pnpm` read as unrunnable. Nanako0129/sepia
 * (season-2-2026-09-04-daily) is the production case: it generated, passed the quality gate
 * and then failed the publication gate, whose README documents `npx skills add`.
 */
describe('hasRunnabilityEvidence — modern run commands', () => {
  const flags = metadata({ package_manifest: false, container_build: false, workflows: false });

  it('accepts the npx install a skill repository documents (sepia shape)', () => {
    expect(hasRunnabilityEvidence(flags, [readme('npx skills add Nanako0129/sepia -g')])).toBe(true);
  });

  it('accepts uv, pipx, pnpm, bun, brew and deno invocations', () => {
    for (const command of ['uv run main.py', 'uv sync', 'uvx ruff', 'pipx install widget',
      'pnpm install', 'bun run dev', 'brew install widget', 'deno task start',
      'docker compose up -d', 'go install example.invalid/widget@latest']) {
      expect(hasRunnabilityEvidence(flags, [readme(`## Install\n${command}`)]), command).toBe(true);
    }
  });

  it('accepts a curl-pipe installer and a shipped script executed by path', () => {
    expect(hasRunnabilityEvidence(flags, [readme('curl -fsSL https://example.invalid/i.sh | bash')])).toBe(true);
    expect(hasRunnabilityEvidence(flags, [readme('Then run ./install.sh from the repo root.')])).toBe(true);
  });

  it('rejects prose that merely names the tooling', () => {
    for (const prose of ['Built with bun and pnpm under the hood.', 'A uv-friendly project.',
      'Docker images are published for every release.']) {
      expect(hasRunnabilityEvidence(flags, [readme(prose)]), prose).toBe(false);
    }
  });
});

/**
 * A shipped executable script. The collector fetched the file from the repository, so its
 * existence is attested the same way the API presence flags attest a manifest — the argument
 * the Apple build manifests already rest on, applied to the one artifact no presence flag
 * reports. codejunkie99/fable-orchestrator (season-2-2026-09-05-daily) is the production
 * case: a skill repository with no manifest, no container build and no CI, whose `install.sh`
 * sits at the repository root.
 */
describe('hasRunnabilityEvidence — shipped executable scripts', () => {
  const flags = metadata({ package_manifest: false, container_build: false, workflows: false });

  it('accepts a root install script (fable-orchestrator shape)', () => {
    expect(hasRunnabilityEvidence(flags, [readme('A routing skill.'), file('install.sh')])).toBe(true);
  });

  it('accepts a script under bin/ or scripts/', () => {
    expect(hasRunnabilityEvidence(flags, [file('skill/fable/scripts/ask_fable.sh')])).toBe(true);
    expect(hasRunnabilityEvidence(flags, [file('bin/widget.sh')])).toBe(true);
  });

  it('rejects a script that is not the project run path', () => {
    expect(hasRunnabilityEvidence(flags, [file('tests/test_skill.sh', 'test_file')])).toBe(false);
    expect(hasRunnabilityEvidence(flags, [file('examples/install.sh')])).toBe(false);
    expect(hasRunnabilityEvidence(flags, [file('src/widget.py')])).toBe(false);
  });

  it('reads only a repository path, never a project website URL', () => {
    expect(hasRunnabilityEvidence(flags, [
      { evidence_id: 'ev-site', type: 'official_site', summary: 'x', url: 'https://widget.invalid/bin/install.sh' } as any
    ])).toBe(false);
  });

  it('ignores an evidence with no URL rather than throwing', () => {
    expect(hasRunnabilityEvidence(flags, [readme('A curated list of things.')])).toBe(false);
  });
});
