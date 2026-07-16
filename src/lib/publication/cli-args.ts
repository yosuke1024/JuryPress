import { z } from 'zod';
import { assertSafeRunKey } from './run-keys';

/**
 * Explicit, validated CLI contract for scripts/run-daily.ts.
 *
 *   --operation publish_new|resume_pending
 *   --trigger scheduled|manual
 *   --run-key <run-key>
 *   --reserve-only
 *   --generate-reserved
 *   --github-output <path>
 *   --update-status <status> [--slug <slug>]   (state-transition mode)
 *
 * Invoked with no operation flags (the legacy private workflow), the CLI behaves exactly
 * like the historical scheduled daily: JST daily run key, one article per day.
 */

const RawArgsSchema = z.object({
  operation: z.enum(['publish_new', 'resume_pending']).default('publish_new'),
  trigger: z.enum(['scheduled', 'manual']).default('scheduled'),
  runKey: z.string().optional(),
  reserveOnly: z.boolean().default(false),
  generateReserved: z.boolean().default(false),
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
    '--github-output', '--update-status', '--slug', '--workflow-run-id'
  ]);
  for (const arg of argv) {
    if (arg.startsWith('--') && !known.has(arg)) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  const parsed = RawArgsSchema.parse({
    operation: valueAfter(argv, '--operation') ?? 'publish_new',
    trigger: valueAfter(argv, '--trigger') ?? 'scheduled',
    runKey: valueAfter(argv, '--run-key'),
    reserveOnly: argv.includes('--reserve-only'),
    generateReserved: argv.includes('--generate-reserved'),
    githubOutput: valueAfter(argv, '--github-output'),
    updateStatus: valueAfter(argv, '--update-status'),
    slug: valueAfter(argv, '--slug'),
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
  if (parsed.runKey) {
    assertSafeRunKey(parsed.runKey);
  }
  if (parsed.operation === 'publish_new' && parsed.trigger === 'manual' && !parsed.runKey && !parsed.workflowRunId) {
    throw new Error('Manual publish_new requires GITHUB_RUN_ID (or --workflow-run-id) to build the run key.');
  }

  return parsed;
}
