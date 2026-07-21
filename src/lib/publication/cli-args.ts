import { z } from 'zod';
import { assertSafeRunKey } from './run-keys';

/**
 * Explicit, validated CLI contract for scripts/run-daily.ts.
 *
 *   --operation publish_new|resume_pending|publish_request
 *   --trigger scheduled|manual
 *   --run-key <run-key>
 *   --issue-number <n>                          (publish_request only)
 *   --request-candidate <path>                  (publish_request reservation input)
 *   --reserve-only
 *   --generate-reserved
 *   --github-output <path>
 *   --update-status <status> [--slug <slug>]   (state-transition mode)
 *
 * Invoked with no operation flags (the legacy private workflow), the CLI behaves exactly
 * like the historical scheduled daily: JST daily run key, one article per day.
 */

const RawArgsSchema = z.object({
  operation: z.enum(['publish_new', 'resume_pending', 'publish_request', 'regenerate']).default('publish_new'),
  trigger: z.enum(['scheduled', 'manual']).default('scheduled'),
  runKey: z.string().optional(),
  issueNumber: z.number().int().positive().optional(),
  requestCandidate: z.string().optional(),
  /** regenerate only: the slug of the withdrawn review to re-review as a supersession. */
  targetSlug: z.string().optional(),
  reserveOnly: z.boolean().default(false),
  generateReserved: z.boolean().default(false),
  /**
   * Phase 2 of the response-first pipeline: re-read the persisted record, judge it, append
   * the verdict. A separate invocation from generation on purpose — the workflow commits the
   * raw response in between, so it is durable on the remote before anything can reject it.
   */
  validateRecord: z.boolean().default(false),
  githubOutput: z.string().optional(),
  updateStatus: z.string().optional(),
  slug: z.string().optional(),
  workflowRunId: z.string().optional()
});

export type RunCliArgs = z.infer<typeof RawArgsSchema>;

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function parseRunCliArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunCliArgs {
  const known = new Set([
    '--operation', '--trigger', '--run-key', '--reserve-only', '--generate-reserved',
    '--validate-record', '--github-output', '--update-status', '--slug', '--workflow-run-id',
    '--issue-number', '--request-candidate', '--target-slug'
  ]);
  for (const arg of argv) {
    if (arg.startsWith('--') && !known.has(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const issueNumberRaw = valueAfter(argv, '--issue-number');
  if (issueNumberRaw !== undefined && !/^[1-9]\d*$/.test(issueNumberRaw)) {
    throw new Error(`--issue-number must be a positive integer, got "${issueNumberRaw}".`);
  }

  const parsed = RawArgsSchema.parse({
    operation: valueAfter(argv, '--operation') ?? 'publish_new',
    trigger: valueAfter(argv, '--trigger') ?? 'scheduled',
    runKey: valueAfter(argv, '--run-key'),
    issueNumber: issueNumberRaw !== undefined ? Number(issueNumberRaw) : undefined,
    requestCandidate: valueAfter(argv, '--request-candidate'),
    reserveOnly: argv.includes('--reserve-only'),
    generateReserved: argv.includes('--generate-reserved'),
    validateRecord: argv.includes('--validate-record'),
    githubOutput: valueAfter(argv, '--github-output'),
    updateStatus: valueAfter(argv, '--update-status'),
    slug: valueAfter(argv, '--slug'),
    targetSlug: valueAfter(argv, '--target-slug'),
    workflowRunId: valueAfter(argv, '--workflow-run-id') ?? env.GITHUB_RUN_ID
  });

  if (parsed.reserveOnly && parsed.generateReserved) {
    throw new Error('--reserve-only and --generate-reserved are mutually exclusive.');
  }
  if (parsed.operation === 'resume_pending') {
    if (!parsed.runKey) {
      throw new Error('--run-key is required for --operation resume_pending.');
    }
    if (parsed.reserveOnly) {
      throw new Error('resume_pending never reserves a new candidate; --reserve-only is invalid.');
    }
  }
  if (parsed.operation === 'publish_request') {
    if (!parsed.updateStatus && !parsed.issueNumber) {
      throw new Error('--issue-number is required for --operation publish_request.');
    }
    if (parsed.reserveOnly && !parsed.requestCandidate) {
      throw new Error('publish_request reservation requires --request-candidate (the validated issue candidate file).');
    }
  } else if (parsed.issueNumber !== undefined || parsed.requestCandidate !== undefined) {
    throw new Error('--issue-number and --request-candidate are only valid with --operation publish_request.');
  }
  if (parsed.operation === 'regenerate') {
    if (!parsed.targetSlug) {
      throw new Error('--target-slug is required for --operation regenerate.');
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(parsed.targetSlug)) {
      throw new Error(`--target-slug contains forbidden characters: "${parsed.targetSlug}"`);
    }
    if (parsed.targetSlug.length > 160) {
      throw new Error(`--target-slug is too long (${parsed.targetSlug.length} chars, max 160): "${parsed.targetSlug}"`);
    }
    // The run key embeds the workflow run id so a retry after an excluded attempt is a fresh
    // run rather than resuming the excluded record — same self-healing as a manual run.
    if (!parsed.workflowRunId) {
      throw new Error('Regenerate requires GITHUB_RUN_ID (or --workflow-run-id) to build the run key.');
    }
  } else if (parsed.targetSlug !== undefined) {
    throw new Error('--target-slug is only valid with --operation regenerate.');
  }
  if (parsed.runKey) {
    assertSafeRunKey(parsed.runKey);
  }
  if (parsed.operation === 'publish_new' && parsed.trigger === 'manual' && !parsed.runKey && !parsed.workflowRunId) {
    throw new Error('Manual publish_new requires GITHUB_RUN_ID (or --workflow-run-id) to build the run key.');
  }

  return parsed;
}
