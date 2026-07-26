import { describe, it, expect } from 'vitest';
import { extractReadmeH1, isDistributionVariantOfRepository, isNameConsistentWithRepository, isValidDisplayName, nameAppearsInText, normalizeRepositoryName, resolveProjectIdentity } from '../../src/lib/identity';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { segmentStatementsStrict } from '../../src/lib/evaluation/public-claims';
import type { Evidence } from '../../src/schemas/evidence';

describe('Canonical Identity Validation Rules', () => {
  it('should accept valid display names', () => {
    expect(isValidDisplayName('AI Trains AI')).toBe(true);
    expect(isValidDisplayName('JuryPress')).toBe(true);
    expect(isValidDisplayName('Vitest Framework')).toBe(true);
  });

  it('should reject names containing only Markdown or HTML image elements', () => {
    expect(isValidDisplayName('![badge](https://img.shields.io)')).toBe(false);
    expect(isValidDisplayName('[link](https://github.com)')).toBe(false);
    expect(isValidDisplayName('<img src="badge.png" />')).toBe(false);
  });

  it('should reject names exceeding 35 characters', () => {
    expect(isValidDisplayName('This Display Name Is Way Too Long To Be A Product Name')).toBe(false);
  });

  it('should reject names starting with subjective or HN personal prefixes', () => {
    expect(isValidDisplayName('Show HN: I built an agent')).toBe(false);
    expect(isValidDisplayName('Ask HN: What is this')).toBe(false);
    expect(isValidDisplayName('I RL-trained a cool neural network')).toBe(false);
    expect(isValidDisplayName('We created an agent')).toBe(false);
  });

  it('should normalize repository names, handling scoped packages properly', () => {
    expect(normalizeRepositoryName('ai-trains-ai')).toBe('AI Trains AI');
    expect(normalizeRepositoryName('@npm/pkg')).toBe('Pkg');
    expect(normalizeRepositoryName('@scoped/some-package')).toBe('Some Package');
    expect(normalizeRepositoryName('my-pkg')).toBe('My Pkg');
  });

  it.each([
    ['script tag', '<script>alert(1)</script>'],
    ['nested tags', '<b><script>alert(1)</script></b>'],
    ['partial tag', '<script src=x'],
    ['name with markup', 'JuryPress <script>alert(1)</script>'],
    ['angle bracket only', 'Jury<Press']
  ])('rejects display names carrying markup rather than sanitizing them (%s)', (_label, name) => {
    expect(isValidDisplayName(name)).toBe(false);
  });

  it('resolves a markdown link H1 to its display text', () => {
    expect(extractReadmeH1('# [JuryPress](https://example.com)\n\nDaily reviews.')).toBe('JuryPress');
  });

  it('rejects a badge-only H1 and an H1 carrying HTML', () => {
    expect(extractReadmeH1('# ![badge](https://img.shields.io/build.svg)\n\ntext')).toBeNull();
    expect(extractReadmeH1('# <img src="logo.png"> JuryPress\n\ntext')).toBeNull();
  });
});

/**
 * Regressions for the two production name incidents of 2026-07-24 and 2026-07-25: a bash
 * comment inside a README code fence published as "or install uv:", and the React README's
 * badge-heavy H1 published as "React &middot;". Both were adopted by resolveProjectIdentity
 * as identity_source "readme_h1" and pinned into every sentence of the published article.
 */
describe('Identity incident regressions (2026-07-24 / 2026-07-25)', () => {
  const reactReadme = [
    '# [React](https://react.dev/) &middot; [![GitHub license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/facebook/react/blob/main/LICENSE) [![npm version](https://img.shields.io/npm/v/react.svg?style=flat)](https://www.npmjs.com/package/react)',
    '',
    'React is a JavaScript library for building user interfaces.'
  ].join('\n');

  const graphifyReadme = [
    'Read this in other languages',
    '',
    '**Ubuntu/Debian:**',
    '```bash',
    'sudo apt install python3.12 python3-pip pipx',
    '# or install uv:',
    'curl -LsSf https://astral.sh/uv/install.sh | sh',
    '```',
    '',
    '## Install'
  ].join('\n');

  it('decodes entities and drops the badge-separator tail from the React README H1', () => {
    expect(extractReadmeH1(reactReadme)).toBe('React');
  });

  it('never reads a bash comment inside a code fence as a heading', () => {
    expect(extractReadmeH1(graphifyReadme)).toBeNull();
    expect(extractReadmeH1('intro\n~~~sh\n# not a heading\n~~~\n# RealName\n')).toBe('RealName');
  });

  it('rejects both incident strings as display names', () => {
    expect(isValidDisplayName('React &middot;')).toBe(false);
    expect(isValidDisplayName('or install uv:')).toBe(false);
  });

  it('rejects instruction fragments, section headings, and entity residue generally', () => {
    expect(isValidDisplayName('Getting Started')).toBe(false);
    expect(isValidDisplayName('Installation')).toBe(false);
    expect(isValidDisplayName('run this first:')).toBe(false);
    expect(isValidDisplayName('Foo &amp; Bar')).toBe(false);
    // Names published today must keep passing.
    expect(isValidDisplayName('Moonshine 🌙')).toBe(true);
    expect(isValidDisplayName('minio-dash')).toBe(true);
  });

  it('holds scrape-derived names to repository consistency', () => {
    expect(isNameConsistentWithRepository('React', 'react')).toBe(true);
    expect(isNameConsistentWithRepository('Exmergo Dex', 'dex')).toBe(true);
    expect(isNameConsistentWithRepository('AI Trains AI', 'ai-trains-ai')).toBe(true);
    expect(isNameConsistentWithRepository('Visual Studio Code', 'vscode')).toBe(true);
    expect(isNameConsistentWithRepository('or install uv', 'graphify')).toBe(false);
    expect(isNameConsistentWithRepository('Sponsored Hero Banner', 'graphify')).toBe(false);
    expect(isNameConsistentWithRepository('Anything At All', undefined)).toBe(true);
  });

  it('resolves the Graphify incident README to the repository name, not the fence comment', () => {
    const identity = resolveProjectIdentity({
      readmeText: graphifyReadme,
      repositoryFullName: 'Graphify-Labs/graphify',
      sourceTitle: 'Graphify-Labs/graphify'
    });
    expect(identity.canonical_display_name).toBe('Graphify');
    expect(identity.identity_source).toBe('repository_name');
  });

  it('resolves the React incident README to a clean display name', () => {
    const identity = resolveProjectIdentity({
      readmeText: reactReadme,
      repositoryFullName: 'facebook/react',
      sourceTitle: 'facebook/react'
    });
    expect(identity.canonical_display_name).toBe('React');
    expect(identity.identity_source).toBe('readme_h1');
  });

  it('falls through to the repository name when a valid-looking H1 names something else', () => {
    const identity = resolveProjectIdentity({
      readmeText: '# Sponsored Hero Banner\n\ntext',
      repositoryFullName: 'Graphify-Labs/graphify',
      sourceTitle: 'Graphify-Labs/graphify'
    });
    expect(identity.canonical_display_name).toBe('Graphify');
    expect(identity.identity_source).toBe('repository_name');
  });

  it('matches product names against reader-facing text on the alphanumeric core', () => {
    expect(nameAppearsInText('Moonshine 🌙', 'Moonshine turns a PC into a couch console')).toBe(true);
    expect(nameAppearsInText('Graphify', 'Local AST codebase knowledge graphs beat blind vector searches')).toBe(false);
  });
});

/**
 * A second sweep over the published corpus, after the first fix landed, found three more
 * identity defects of the same family — a name that survives the gate is not the same thing
 * as a name that is right. Each case below is taken from a real record.
 */
describe('Name quality beyond validity', () => {
  it('spells technical acronyms and part numbers the way a reader writes them', () => {
    // Published 2026-07-26 as "Esp32 Llm", in an article whose own prose wrote "ESP32-S3".
    expect(normalizeRepositoryName('esp32-llm')).toBe('ESP32 LLM');
    expect(normalizeRepositoryName('my-cli-gpu')).toBe('My CLI GPU');
    expect(normalizeRepositoryName('iot-dashboard')).toBe('IoT Dashboard');
    expect(normalizeRepositoryName('graphql-orm')).toBe('GraphQL ORM');
    // Unchanged behaviour for the names already in the corpus.
    expect(normalizeRepositoryName('ai-trains-ai')).toBe('AI Trains AI');
    expect(normalizeRepositoryName('minio-dash')).toBe('Minio Dash');
    expect(normalizeRepositoryName('grok-build')).toBe('Grok Build');
  });

  it('leaves letters-then-digits product names in title case', () => {
    // The reason part numbers are an explicit table rather than a regex: these are the same
    // shape as "esp32" and must NOT be shouted.
    expect(normalizeRepositoryName('web3-wallet')).toBe('Web3 Wallet');
    expect(normalizeRepositoryName('vue3-starter')).toBe('Vue3 Starter');
  });

  it('rejects call-to-action copy lifted from a README heading', () => {
    // Published as the product name of public-apis/public-apis, and quoted in the headline.
    expect(isValidDisplayName('Try Public APIs for free')).toBe(false);
    expect(isValidDisplayName('Download now for free')).toBe(false);
    expect(isValidDisplayName('Sign up to get started')).toBe(false);
    expect(isValidDisplayName('Introducing our new suite')).toBe(false);
  });

  it('keeps short names that merely begin with a CTA-shaped verb', () => {
    expect(isValidDisplayName('Download Manager')).toBe(true);
    expect(isValidDisplayName('Learn Rust')).toBe(true);
    expect(isValidDisplayName('Meet')).toBe(true);
  });

  it('treats a registry-mangled package name as a distribution variant, not a brand', () => {
    // Graphify publishes to PyPI as "graphifyy" because the plain name was taken.
    expect(isDistributionVariantOfRepository('Graphifyy', 'graphify')).toBe(true);
    expect(isDistributionVariantOfRepository('My-Tool', 'my_tool')).toBe(false); // same core
    // A genuinely different manifest name still wins its priority.
    expect(isDistributionVariantOfRepository('FastAPI', 'core')).toBe(false);
    expect(isDistributionVariantOfRepository('Esp32 Llm', 'esp32-ai')).toBe(false);
  });

  it('prefers the repository brand over a near-variant manifest name', () => {
    const identity = resolveProjectIdentity({
      manifestContent: '[project]\nname = "graphifyy"\n',
      manifestFileName: 'pyproject.toml',
      repositoryFullName: 'Graphify-Labs/graphify',
      sourceTitle: 'Graphify-Labs/graphify'
    });
    expect(identity.canonical_display_name).toBe('Graphify');
    expect(identity.identity_source).toBe('repository_name');
  });

  it('still takes a manifest name that genuinely names the project', () => {
    const identity = resolveProjectIdentity({
      manifestContent: JSON.stringify({ name: 'fastify' }),
      manifestFileName: 'package.json',
      repositoryFullName: 'acme/server-core',
      sourceTitle: 'acme/server-core'
    });
    expect(identity.canonical_display_name).toBe('Fastify');
    expect(identity.identity_source).toBe('package_manifest');
  });
});

describe('Official Website Identity Resolution', () => {
  const base = { repositoryFullName: 'owner/refined-tool', sourceTitle: 'Show HN: my thing' };

  it.each([
    ['vercel.app', 'https://foo.vercel.app'],
    ['pages.dev', 'https://foo.pages.dev'],
    ['readthedocs.io', 'https://project.readthedocs.io'],
    ['github.io', 'https://owner.github.io']
  ])('does not mine a product name out of the hostname (%s)', (_label, officialWebsiteUrl) => {
    const identity = resolveProjectIdentity({ ...base, officialWebsiteUrl });
    expect(identity.canonical_display_name).toBe('Refined Tool');
    expect(identity.identity_source).toBe('repository_name');
  });

  it('uses an explicit og:site_name from the official site', () => {
    const identity = resolveProjectIdentity({
      ...base,
      officialWebsiteUrl: 'https://foo.vercel.app',
      officialSiteHtml: '<html><head><meta property="og:site_name" content="RefinedTool"><title>RefinedTool | Docs</title></head><body></body></html>'
    });
    expect(identity.canonical_display_name).toBe('RefinedTool');
    expect(identity.identity_source).toBe('official_website');
  });

  it('prefers application-name, then og:site_name, then og:title', () => {
    const identity = resolveProjectIdentity({
      ...base,
      officialSiteHtml: '<html><head><meta name="application-name" content="Refined Tool App"><meta property="og:site_name" content="Refined Tool Site"><meta property="og:title" content="Refined Tool Title"></head></html>'
    });
    expect(identity.canonical_display_name).toBe('Refined Tool App');
  });

  it('strips a tagline from the site name', () => {
    const identity = resolveProjectIdentity({
      ...base,
      officialSiteHtml: '<html><head><meta property="og:title" content="RefinedTool — the fastest parser"></head></html>'
    });
    expect(identity.canonical_display_name).toBe('RefinedTool');
  });

  it('falls back to the repository name when the site states no usable name', () => {
    const identity = resolveProjectIdentity({
      ...base,
      officialWebsiteUrl: 'https://foo.vercel.app',
      officialSiteHtml: '<html><head><title>   </title></head><body><p>Welcome</p></body></html>'
    });
    expect(identity.canonical_display_name).toBe('Refined Tool');
    expect(identity.identity_source).toBe('repository_name');
  });

  it('keeps README H1 and package manifest ahead of the official website', () => {
    const officialSiteHtml = '<html><head><meta property="og:site_name" content="Refined Tool Site"></head></html>';
    const fromReadme = resolveProjectIdentity({ ...base, officialSiteHtml, readmeText: '# Refined Tool Pro\n\ntext' });
    expect(fromReadme.canonical_display_name).toBe('Refined Tool Pro');
    expect(fromReadme.identity_source).toBe('readme_h1');

    const fromManifest = resolveProjectIdentity({
      ...base,
      officialSiteHtml,
      manifestContent: JSON.stringify({ name: 'manifest-name' }),
      manifestFileName: 'package.json'
    });
    expect(fromManifest.canonical_display_name).toBe('Manifest Name');
    expect(fromManifest.identity_source).toBe('package_manifest');
  });
});

describe('Evaluation Integrity & Confidence Ceilings', () => {
  const dummyEvidences: Evidence[] = [
    {
      evidence_id: 'ev-1',
      type: 'readme',
      url: 'https://github.com/test/project/blob/main/README.md',
      title: 'Project README',
      retrieved_at: new Date().toISOString(),
      content_hash: 'hash-1',
      summary: 'Test project readme. conftest.py exists.',
      claims: []
    },
    {
      evidence_id: 'ev-2',
      type: 'api_metadata',
      url: 'https://api.github.com/repos/test/project',
      title: 'Project API Metadata',
      retrieved_at: new Date().toISOString(),
      content_hash: 'hash-2',
      summary: 'stars: 10, forks: 2',
      claims: []
    }
  ];

  // Helper to build a standard V2 criteria list for a judge. Reasoning carries an absence
  // phrase that is also a calibrated phrase, so it survives a high->low ceiling downgrade
  // without triggering the reasoning-prepend remediation. Empty limitations are injected by
  // the ceiling and covered by system_generated references.
  const buildV2Criteria = () => {
    const ids = [
      'purpose_usefulness',
      'implementation_evidence',
      'technical_quality',
      'usability_onboarding',
      'differentiation_insight',
      'project_health_stewardship'
    ];
    return ids.map(id => ({
      criterion_id: id,
      score: 4,
      confidence: 'high', // Use high to avoid complex limitations rules for medium/low during test bootstrap
      reasoning: `The available evidence does not establish verified ${id} behaviour.`,
      evidence_ids: [] as string[],
      limitations: [] as string[]
    }));
  };

  const dummyProduct = {
    name: "Test Project",
    category: "The available evidence does not establish a firm category.",
    summary: "The available evidence does not establish a full summary.",
    primary_audience: "The available evidence does not establish a specific audience."
  };
  const dummyArticle = {
    headline: "The available evidence does not establish a definitive headline",
    standfirst: "The available evidence does not establish a strong standfirst.",
    jury_summary: "The available evidence does not establish a complete jury summary.",
    where_jury_agreed: ["No verified consensus point was collected."],
    where_jury_disagreed: [] as any[],
    evidence_limitations: [] as string[],
    evidence_classifications: [] as any[],
    final_verdict: "The available evidence does not establish a firm verdict.",
    meta_description: "The available evidence does not establish a full description."
  };
  const dummyJudges = [
    { judge_id: "alex", judge_name: "Alex", role: "Technical Expert", verdict: "Perspective one could not verify runtime behaviour.", strengths: ["No verified strength was collected for perspective one."], concerns: ["No verified concern was resolved for perspective one."], decisive_question: "What could not be verified for perspective one?", criteria: buildV2Criteria() },
    { judge_id: "david", judge_name: "David", role: "Product Manager", verdict: "Perspective two could not verify runtime behaviour.", strengths: [] as string[], concerns: [] as string[], decisive_question: "What could not be verified for perspective two?", criteria: buildV2Criteria() },
    { judge_id: "lisa", judge_name: "Lisa", role: "UX Designer", verdict: "Perspective three could not verify runtime behaviour.", strengths: [] as string[], concerns: [] as string[], decisive_question: "What could not be verified for perspective three?", criteria: buildV2Criteria() },
    { judge_id: "sarah", judge_name: "Sarah", role: "Security Engineer", verdict: "Perspective four could not verify runtime behaviour.", strengths: [] as string[], concerns: [] as string[], decisive_question: "What could not be verified for perspective four?", criteria: buildV2Criteria() },
    { judge_id: "marcus", judge_name: "Marcus", role: "QA Lead", verdict: "Perspective five could not verify runtime behaviour.", strengths: [] as string[], concerns: [] as string[], decisive_question: "What could not be verified for perspective five?", criteria: buildV2Criteria() }
  ];

  // Generate full statement coverage (all unverified — every field carries absence wording).
  const buildAnnotations = () => {
    const anns: any[] = [];
    const add = (path: string, text: string) => {
      for (const statement of segmentStatementsStrict(text)) anns.push({ public_output_path: path, statement_text: statement, support_mode: 'unverified', evidence_ids: [] });
    };
    add('product.category', dummyProduct.category);
    add('product.summary', dummyProduct.summary);
    add('product.primary_audience', dummyProduct.primary_audience);
    add('article.headline', dummyArticle.headline);
    add('article.standfirst', dummyArticle.standfirst);
    add('article.jury_summary', dummyArticle.jury_summary);
    add('article.where_jury_agreed.0', dummyArticle.where_jury_agreed[0]);
    add('article.final_verdict', dummyArticle.final_verdict);
    add('article.meta_description', dummyArticle.meta_description);
    dummyJudges.forEach((judge, ji) => {
      add(`judges.${ji}.verdict`, judge.verdict);
      judge.strengths.forEach((s, i) => add(`judges.${ji}.strengths.${i}`, s));
      judge.concerns.forEach((c, i) => add(`judges.${ji}.concerns.${i}`, c));
      add(`judges.${ji}.decisive_question`, judge.decisive_question);
      judge.criteria.forEach((crit, ci) => add(`judges.${ji}.criteria.${ci}.reasoning`, crit.reasoning));
    });
    return anns;
  };

  const dummyEvaluationInput = {
    schema_version: "2.0.0" as const,
    evaluation_integrity_version: "1.0.0" as const,
    public_statement_annotations: buildAnnotations(),
    product: dummyProduct,
    article: dummyArticle,
    judges: dummyJudges,
    overall_evidence_confidence: 0.9,
    project_identity: {
      canonical_display_name: "Test Project",
      identity_source: "readme_h1" as const,
      source_title: "Test Project"
    },
    metadata_snapshot: {
      snapshot_id: "snap-123",
      fetched_at: new Date().toISOString(),
      repository_full_name: "test/project",
      repository_url: "https://github.com/test/project",
      default_branch: "main",
      stars: 10,
      forks: 2,
      open_issues: 0,
      latest_commit_sha: "sha123",
      latest_commit_at: new Date().toISOString(),
      license: "MIT",
      archived: false
    },
    core_source_evidence: {
      source_count: 3,
      source_files: ["src/index.ts"]
    },
    test_evidence_summary: {
      has_pytest_configuration: true,
      actual_test_files: ["tests/test_main.py"],
      ci_workflows: [".github/workflows/ci.yml"],
      documented_test_commands: ["pytest"],
      test_result_artifacts: [],
      test_badges: [],
      relevant_source_files: ["src/index.ts"],
      confidence: "HIGH" as const,
      limitations: [],
      verified_execution_results: [] // EMPTY: Trigger downgrade
    },
    claim_references: [],
    counter_evidence_references: [],
    confidence_adjustments: [],
    discussion_evidence: { items: [] }
  };

  it('should enforce LOW cap for implementation_evidence and 0.66 overall ceiling when verified_execution_results is empty', () => {
    const evaluator = new Evaluator();
    const result = evaluator.recalculateScores(dummyEvaluationInput as any, dummyEvidences, { prompt_version: "2.1.0" }) as any;
    
    // In V2, implementation_evidence is used.
    const alexCrit = result.judges[0].criteria.find((c: any) => c.criterion_id === 'implementation_evidence');
    expect(alexCrit).toBeDefined();
    expect(alexCrit?.confidence).toBe('low');

    // Check overall confidence ceiling capped at 0.66
    expect(result.overall_evidence_confidence).toBeLessThanOrEqual(0.66);

    // Verify adjustments details including scope, judge_id, and criterion_id
    expect(result.confidence_adjustments).toBeDefined();
    expect(result.confidence_adjustments.length).toBeGreaterThan(0);
    
    const criterionAdj = result.confidence_adjustments.find((a: any) => a.scope === 'criterion');
    expect(criterionAdj).toBeDefined();
    expect(criterionAdj?.judge_id).toBe('alex');
    expect(criterionAdj?.criterion_id).toBe('implementation_evidence');
    expect(criterionAdj?.original_confidence).toBe('HIGH');
    expect(criterionAdj?.final_confidence).toBe('LOW');

    const overallAdj = result.confidence_adjustments.find((a: any) => a.scope === 'overall');
    expect(overallAdj).toBeDefined();
    expect(overallAdj?.original_confidence).toBe('HIGH');
    expect(overallAdj?.final_confidence).toBe('MEDIUM');
  });
});
