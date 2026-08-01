import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareCandidateWithIntegrityContext } from '../../src/lib/daily-evaluation';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { createRefinedFixture } from '../fixtures/refined-review';

/**
 * Shadow generation is a comparison instrument, and a comparison is only worth the quota it
 * spends if both sides were asked the same question. The shadow run reuses a stored run's
 * candidate and evidence, so the one thing that must not differ is the prompt — and the run
 * state stores the candidate BEFORE the daily pipeline merges the collected identity and
 * metadata snapshot into it. Reading the stored candidate as-is silently asks a different
 * question, which is the failure these tests exist to prevent.
 */

const CAPTURED = '__PROMPT_CAPTURED__';

/** Builds the prompt an evaluator would send, without sending it. */
async function promptFor(candidate: unknown, evidences: unknown[], recentArticles: any[] = []): Promise<string> {
  let prompt = '';
  const transport: any = {
    provider: 'gemini',
    generate: async (request: any) => {
      prompt = request.prompt;
      throw new Error(CAPTURED);
    }
  };
  const evaluator = new Evaluator({ transport });
  try {
    await evaluator.generateRaw(candidate as any, evidences as any, { promptVersion: '4.4.0', recentArticles });
  } catch (error: any) {
    if (!String(error?.message).includes(CAPTURED)) throw error;
  }
  return prompt;
}

function opening(headline: string) {
  return { headline, standfirstOpening: 'A standfirst.', verdictOpening: 'A verdict.' };
}

function storedRunCandidate() {
  // The shape the run state persists: the selection candidate, before any integrity merge.
  return {
    source: 'show_hn',
    sourceId: '1',
    name: 'example/refined-product',
    canonicalUrl: 'https://github.com/example/refined-product',
    sourceUrl: 'https://news.ycombinator.com/item?id=1',
    sourceRank: 1,
    popularityValue: 42,
    popularityUnit: 'stars',
    collectedAt: '2026-07-16T00:00:00.000Z',
    metadata: {}
  };
}

describe('shadow generation asks the same question as the run it compares against', () => {
  it('reproduces the daily pipeline prompt only after the integrity merge', async () => {
    const { context } = createRefinedFixture();
    const candidate = storedRunCandidate();

    const asStored = await promptFor(candidate, context.evidences);
    const prepared = prepareCandidateWithIntegrityContext(candidate as any, context);
    const asDaily = await promptFor(prepared.candidate, prepared.context.evidences);

    // Same inputs, two different prompts — this is the whole defect, stated as a test.
    expect(asStored).not.toBe(asDaily);

    // What the shadow model would have been denied: the product's canonical name and the
    // snapshot the prompt's own fact rules are written against.
    expect(asStored).toContain('Metadata Snapshot: None');
    expect(asDaily).toContain(context.metadata_snapshot!.snapshot_id);
    expect(asDaily).toContain(`Name: ${context.project_identity!.canonical_display_name}`);
    expect(asStored).not.toContain(`Name: ${context.project_identity!.canonical_display_name}`);
  });

  it('treats the recent-article block as part of the prompt, so the archive cannot drift', async () => {
    const { context } = createRefinedFixture();
    const prepared = prepareCandidateWithIntegrityContext(storedRunCandidate() as any, context);

    const asThen = await promptFor(prepared.candidate, prepared.context.evidences, [opening('A headline from that week')]);
    const asNow = await promptFor(prepared.candidate, prepared.context.evidences, [opening('A headline published since')]);

    // Same run, same inputs, different archive — a different prompt. This is why the shadow
    // workflow pins the archive to the run's generate commit instead of reading main.
    expect(asThen).not.toBe(asNow);
    expect(asThen).toContain('A headline from that week');
    expect(asNow).not.toContain('A headline from that week');
  });

  it('lets the caller pin the archive the recent-article block is read from', () => {
    const source = readFileSync('scripts/shadow-generate.ts', 'utf8');
    expect(source).toContain("'--archive-as-of'");
    // Read from the pinned root when given, and from the content root otherwise — never from
    // the content root unconditionally.
    expect(source).toContain('const archiveRoot = args.archiveRoot ?? contentRoot;');
    expect(source).toContain('readRecentArticleOpenings(archiveRoot)');
    expect(source).not.toContain('readRecentArticleOpenings(contentRoot)');
    // A mistyped path must fail before the model is called, not silently drop the block.
    expect(source).toContain('--archive-as-of must point at a content root containing reviews/');
    // The artifact says whether the pin was used, so promptIdentical: false can be diagnosed.
    expect(source).toContain('archivePinnedToRun');
  });

  it('feeds the shadow evaluator the prepared candidate, never the stored one', () => {
    const source = readFileSync('scripts/shadow-generate.ts', 'utf8');
    expect(source).toContain('prepareCandidateWithIntegrityContext(');

    // The merge has to happen before the call, not merely somewhere in the file.
    const prepareIndex = source.indexOf('prepareCandidateWithIntegrityContext(\n');
    const generateIndex = source.indexOf('evaluator.generateRaw');
    expect(prepareIndex).toBeGreaterThan(-1);
    expect(prepareIndex).toBeLessThan(generateIndex);

    // The raw stored candidate may only be read for the existence check and handed to the
    // merge. Passing it onward is the regression this guards.
    expect(source).not.toMatch(/generateRaw\(\s*runState\.candidate/);
    expect(source).toMatch(/const candidate = prepared\.candidate/);
  });
});
