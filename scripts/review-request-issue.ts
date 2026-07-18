import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  REVIEW_REQUEST_LABELS,
  REVIEW_REQUEST_REPO,
  REVIEW_REQUEST_SITE_PREFIX
} from '../src/config/review-requests';
import { parseReviewRequestIssueBody } from '../src/lib/review-requests/issue-body';
import { GitHubApiError, GitHubIssuesClient, type GitHubIssue } from '../src/lib/review-requests/github-issues';
import { validateCanonicalRepositoryUrl, validatePublicHttpsUrl } from '../src/schemas/review-request';
import { buildRequestRunKey } from '../src/lib/publication/run-keys';
import { readRecord } from '../src/lib/generation/record-store';
import { resolveContentRoot } from '../src/lib/content-root';
import type { RequestCandidateFile } from '../src/lib/review-requests/request-candidate';

/**
 * Operator CLI for review-request issues. Everything the publish_request workflow does to
 * a GitHub Issue goes through this file:
 *
 *   fetch            validate the issue + build the request-candidate file
 *   mark-processing  label the issue as processing and post the start comment (once)
 *   decline          post a public-safe decline reason, label, and close (not_planned)
 *   mark-published   post the article URL + score, label, and close (completed)
 *   mark-retry       label the issue retry-needed; NEVER closes, NEVER posts error details
 *
 * Issue-derived values never reach a shell: this CLI takes only a validated integer issue
 * number (plus enum reason codes and a slug), reads everything else from the API itself,
 * and emits only enumerable outputs to GITHUB_OUTPUT.
 */

const STATUS_MARKERS = {
  processing: '<!-- jurypress-review-request-status:processing -->',
  published: '<!-- jurypress-review-request-status:published -->',
  declined: '<!-- jurypress-review-request-status:declined -->'
} as const;

const DECLINE_REASON_TEXT: Record<string, string> = {
  issue_body_missing: 'The issue body is empty, so the request details could not be read.',
  issue_body_too_large: 'The issue body exceeds the size limit for automated processing.',
  machine_block_missing: 'The machine-readable request block is missing from the issue body.',
  machine_block_multiple: 'The issue body contains more than one machine-readable request block.',
  machine_block_malformed: 'The machine-readable request block could not be parsed.',
  machine_block_unsupported_version: 'The machine-readable request block uses an unsupported schema version.',
  machine_block_invalid_fields: 'The machine-readable request block contains missing or invalid fields.',
  unsupported_repository: 'The requested repository URL is not a supported public source (a public GitHub repository or Hugging Face Space is required).',
  repository_not_found: 'The requested repository could not be found as a public repository.',
  duplicate_published: 'JuryPress has already published a review for this product.',
  duplicate_active_request: 'Another active run or review request already covers this product.',
  insufficient_evidence: 'The official sources did not provide enough evidence for a complete jury evaluation.',
  no_public_repository: 'The Eligibility Gate requires a canonical public repository on a supported source.',
  missing_oss_license: 'The Eligibility Gate requires an explicit open-source license, and none was found.',
  unsupported_license: 'The repository license could not be matched to an approved open-source SPDX identifier.',
  not_software_product: 'The Eligibility Gate determined this is not an evaluable software product (for example: an empty repository, a list, a tutorial, or a news page).',
  archived_repository: 'The repository is archived, which the Eligibility Gate excludes.',
  mirror_or_unmodified_fork: 'The repository appears to be a mirror or an unmodified fork, which the Eligibility Gate excludes.',
  missing_clear_purpose: 'The Eligibility Gate could not identify a clear stated purpose for the product.',
  not_runnable: 'The Eligibility Gate could not verify that the product is runnable or reproducible.',
  stale_project: 'The project has no meaningful updates within the freshness window required by the Eligibility Gate.',
  quality_exclusion: 'The generated review did not pass JuryPress\'s quality validation. A quality failure is terminal for this request: the evaluation is not re-run to chase a passing result.'
};

function appendGithubOutputs(outputFile: string | undefined, outputs: Record<string, string | number | boolean>): void {
  if (!outputFile) return;
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join('\n');
  fs.appendFileSync(outputFile, `${lines}\n`);
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function requireIssueNumber(args: string[]): number {
  const raw = valueAfter(args, '--issue-number');
  if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
    throw new Error('--issue-number must be a positive integer.');
  }
  return Number(raw);
}

function buildClient(): GitHubIssuesClient {
  const token = process.env.JURYPRESS_ISSUE_TOKEN;
  if (!token) {
    throw new Error('JURYPRESS_ISSUE_TOKEN is required but not set.');
  }
  return new GitHubIssuesClient({ token, repo: REVIEW_REQUEST_REPO });
}

function readSeason(): number {
  const seasonConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8'));
  return seasonConfig.season;
}

function assertSafeSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Slug contains forbidden characters: "${slug}"`);
  }
}

function articleUrlForSlug(slug: string): string {
  assertSafeSlug(slug);
  return `${REVIEW_REQUEST_SITE_PREFIX}/reviews/${slug}/`;
}

async function hasMarkerComment(client: GitHubIssuesClient, issueNumber: number, marker: string): Promise<boolean> {
  const comments = await client.listComments(issueNumber);
  return comments.some(c => c.body.includes(marker));
}

async function commentOnce(client: GitHubIssuesClient, issueNumber: number, marker: string, body: string): Promise<boolean> {
  if (await hasMarkerComment(client, issueNumber, marker)) {
    console.log(`[Issue] Comment with marker already exists on #${issueNumber}; skipping duplicate.`);
    return false;
  }
  await client.createComment(issueNumber, `${body}\n\n${marker}`);
  return true;
}

/**
 * Repo metadata fetch for candidate identity + real source metrics. Uses GITHUB_TOKEN
 * when available (rate limits); a 404 is an input problem (decline), 403/429/5xx are
 * transient operational failures (retryable, non-zero exit).
 */
async function fetchOfficialMetadata(platform: 'github' | 'hugging-face', repoPath: string): Promise<
  { found: false } | { found: true; name: string; sourceId: string; value: number; metric: 'stars' | 'likes'; metadata: Record<string, unknown> }
> {
  if (platform === 'github') {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'JuryPress-Review-Requests/1.0'
    };
    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
    }
    const res = await fetch(`https://api.github.com/repos/${repoPath}`, { headers });
    if (res.status === 404) return { found: false };
    if (!res.ok) throw new GitHubApiError(res.status, 'repository metadata fetch');
    const data: any = await res.json();
    return {
      found: true,
      name: data.name || repoPath.split('/')[1],
      sourceId: data.full_name || repoPath,
      value: typeof data.stargazers_count === 'number' ? data.stargazers_count : 0,
      metric: 'stars',
      metadata: {
        official_full_name: data.full_name || repoPath,
        description: data.description || '',
        license_spdx: data.license ? (data.license.spdx_id || data.license.key || 'unknown') : 'unknown',
        stars: data.stargazers_count ?? 0,
        forks: data.forks_count ?? 0,
        archived: Boolean(data.archived)
      }
    };
  }

  const res = await fetch(`https://huggingface.co/api/spaces/${repoPath}`, {
    headers: { 'User-Agent': 'JuryPress-Review-Requests/1.0' }
  });
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new GitHubApiError(res.status, 'space metadata fetch');
  const data: any = await res.json();
  return {
    found: true,
    name: repoPath.split('/')[1],
    sourceId: repoPath,
    value: typeof data.likes === 'number' ? data.likes : 0,
    metric: 'likes',
    metadata: {
      official_full_name: repoPath,
      sdk: data.sdk || 'unknown',
      license_spdx: data.cardData?.license || 'unknown',
      likes: data.likes ?? 0
    }
  };
}

interface FetchInvalidResult {
  valid: false;
  skipNotify: boolean;
  codes: string[];
}

async function handleFetch(args: string[]): Promise<void> {
  const issueNumber = requireIssueNumber(args);
  const candidateFilePath = valueAfter(args, '--candidate-file');
  const githubOutput = valueAfter(args, '--github-output') ?? process.env.GITHUB_OUTPUT;
  if (!candidateFilePath) {
    throw new Error('--candidate-file is required for fetch.');
  }

  const runKey = buildRequestRunKey(readSeason(), issueNumber);
  const client = buildClient();

  const emitInvalid = (result: FetchInvalidResult) => {
    console.log(`[Fetch] Issue #${issueNumber} is not processable: ${result.codes.join(', ')} (notify=${!result.skipNotify})`);
    appendGithubOutputs(githubOutput, {
      request_valid: false,
      skip_notify: result.skipNotify,
      decline_reason_codes: result.codes.join(','),
      run_key: runKey,
      issue_url: ''
    });
  };

  const issue: GitHubIssue | null = await client.getIssue(issueNumber);
  if (!issue) {
    emitInvalid({ valid: false, skipNotify: true, codes: ['issue_not_found'] });
    return;
  }
  if (issue.is_pull_request) {
    emitInvalid({ valid: false, skipNotify: true, codes: ['issue_is_pull_request'] });
    return;
  }
  if (!issue.labels.includes(REVIEW_REQUEST_LABELS.request)) {
    // Never touch an issue that is not a review request — a mistyped issue number must
    // not decorate arbitrary issues with comments or labels.
    emitInvalid({ valid: false, skipNotify: true, codes: ['not_review_request'] });
    return;
  }
  if (issue.state !== 'open') {
    emitInvalid({ valid: false, skipNotify: true, codes: ['issue_not_open'] });
    return;
  }

  const parsed = parseReviewRequestIssueBody(issue.body);
  if (!parsed.ok) {
    emitInvalid({ valid: false, skipNotify: false, codes: [parsed.code] });
    return;
  }
  const block = parsed.block;

  const canonical = validateCanonicalRepositoryUrl(block.canonical_repository_url);
  if (!canonical) {
    emitInvalid({ valid: false, skipNotify: false, codes: ['unsupported_repository'] });
    return;
  }

  const official = await fetchOfficialMetadata(canonical.platform, canonical.path);
  if (!official.found) {
    emitInvalid({ valid: false, skipNotify: false, codes: ['repository_not_found'] });
    return;
  }

  const now = new Date().toISOString();
  const additionalEvidenceUrls: string[] = [];
  const officialUrl = block.official_url ? validatePublicHttpsUrl(block.official_url, { allowQuery: true }) : null;
  if (officialUrl) additionalEvidenceUrls.push(officialUrl);
  for (const url of block.additional_official_urls) {
    const validated = validatePublicHttpsUrl(url, { allowQuery: true });
    if (validated && !additionalEvidenceUrls.includes(validated)) {
      additionalEvidenceUrls.push(validated);
    }
  }

  // The candidate carries NO requester free text: name/id/metrics come from official
  // APIs, sourceUrl equals the canonical URL so evidence collection can only target the
  // official source, and the issue is referenced by number/URL alone.
  const candidateFile: RequestCandidateFile = {
    schema_version: '1.0.0',
    generated_at: now,
    issue: {
      repo: REVIEW_REQUEST_REPO,
      number: issue.number,
      url: issue.html_url
    },
    request: {
      request_id: block.request_id,
      requester_relationship: block.requester_relationship
    },
    candidate: {
      source: 'reader_request',
      sourceId: official.sourceId,
      name: official.name,
      canonicalUrl: canonical.url,
      sourceUrl: canonical.url,
      sourceRank: 0,
      popularityValue: official.value,
      popularityUnit: official.metric,
      collectedAt: now,
      metadata: official.metadata,
      ...(additionalEvidenceUrls.length > 0 ? { additional_evidence_urls: additionalEvidenceUrls } : {})
    },
    source_metrics: [
      {
        platform: canonical.platform,
        metric: official.metric,
        value: official.value,
        source_url: canonical.url,
        retrieved_at: now
      }
    ]
  };

  fs.mkdirSync(path.dirname(path.resolve(candidateFilePath)), { recursive: true });
  fs.writeFileSync(candidateFilePath, `${JSON.stringify(candidateFile, null, 2)}\n`);
  console.log(`[Fetch] Issue #${issueNumber} validated; candidate file written for ${canonical.url}.`);

  appendGithubOutputs(githubOutput, {
    request_valid: true,
    skip_notify: false,
    decline_reason_codes: '',
    run_key: runKey,
    issue_url: issue.html_url
  });
}

async function handleMarkProcessing(args: string[]): Promise<void> {
  const issueNumber = requireIssueNumber(args);
  const client = buildClient();

  await commentOnce(
    client,
    issueNumber,
    STATUS_MARKERS.processing,
    [
      'The operator has started processing this review request.',
      '',
      'The product will now be checked against the JuryPress Eligibility Gate. If it is eligible, official evidence is collected and the five-person AI jury evaluates it under the standard rubric. The result — publication or a decline with its reason — will be posted on this issue.'
    ].join('\n')
  );
  await client.addLabels(issueNumber, [REVIEW_REQUEST_LABELS.processing]);
  await client.removeLabel(issueNumber, REVIEW_REQUEST_LABELS.awaitingOperator);
  console.log(`[Issue] #${issueNumber} marked processing.`);
}

async function handleDecline(args: string[]): Promise<void> {
  const issueNumber = requireIssueNumber(args);
  const codesRaw = valueAfter(args, '--reason-codes') ?? '';
  const existingSlug = valueAfter(args, '--existing-slug');
  const client = buildClient();

  const codes = codesRaw.split(',').map(c => c.trim()).filter(c => c.length > 0);
  if (codes.length === 0) {
    throw new Error('--reason-codes must contain at least one reason code.');
  }
  if (!codes.every(code => /^[a-z0-9_]+$/.test(code))) {
    throw new Error('Reason codes must be lowercase enum codes.');
  }

  const reasonLines = codes.map(code => `- ${DECLINE_REASON_TEXT[code] ?? `The request was declined (reason code: \`${code}\`).`}`);
  const bodyLines = [
    'This review request has been declined.',
    '',
    ...reasonLines
  ];
  if (existingSlug) {
    bodyLines.push('', `The existing review is available here: ${articleUrlForSlug(existingSlug)}`);
  }
  bodyLines.push(
    '',
    'Declining a request never reflects on the product\'s quality by itself — it only means the request did not meet the requirements for an automated JuryPress review. A new request can be submitted if the situation changes (for example, after adding a supported open-source license).'
  );

  await commentOnce(client, issueNumber, STATUS_MARKERS.declined, bodyLines.join('\n'));
  await client.addLabels(issueNumber, [REVIEW_REQUEST_LABELS.declined]);
  await client.removeLabel(issueNumber, REVIEW_REQUEST_LABELS.awaitingOperator);
  await client.removeLabel(issueNumber, REVIEW_REQUEST_LABELS.processing);
  await client.removeLabel(issueNumber, REVIEW_REQUEST_LABELS.retryNeeded);
  await client.closeIssue(issueNumber, 'not_planned');
  console.log(`[Issue] #${issueNumber} declined (${codes.join(', ')}) and closed.`);
}

async function handleMarkPublished(args: string[]): Promise<void> {
  const issueNumber = requireIssueNumber(args);
  const runKey = valueAfter(args, '--run-key');
  if (!runKey) {
    throw new Error('--run-key is required for mark-published.');
  }
  const client = buildClient();

  const contentRoot = resolveContentRoot();
  const record = readRecord(contentRoot, runKey);
  if (!record || record.publication.status !== 'published' || !record.slug) {
    throw new Error(`[Issue] Run ${runKey} is not published; refusing to notify the issue.`);
  }
  const slug = record.slug;
  assertSafeSlug(slug);

  // Resolve the published review for the product name and jury score.
  let productName = record.candidate.name || 'The requested product';
  let juryScoreText = 'Not assessable (evidence-limited)';
  const reviewsDir = path.join(contentRoot, 'reviews');
  if (fs.existsSync(reviewsDir)) {
    outer:
    for (const year of fs.readdirSync(reviewsDir)) {
      const yearDir = path.join(reviewsDir, year);
      if (!fs.statSync(yearDir).isDirectory()) continue;
      for (const month of fs.readdirSync(yearDir)) {
        const reviewPath = path.join(yearDir, month, slug, 'review.json');
        if (fs.existsSync(reviewPath)) {
          try {
            const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
            if (review.product?.name) productName = review.product.name;
            if (typeof review.jury_score === 'number') {
              juryScoreText = `${review.jury_score} / 5`;
            }
          } catch (e) {
            // Fall back to record values.
          }
          break outer;
        }
      }
    }
  }

  const articleUrl = articleUrlForSlug(slug);
  const body = [
    'This review request has been completed and the review is now published.',
    '',
    `- **Product**: ${productName}`,
    `- **Jury Score**: ${juryScoreText}`,
    `- **Review**: ${articleUrl}`,
    '',
    'The review was produced by the standard JuryPress pipeline: the same Eligibility Gate, evidence collection, rubric, and quality validation as every automated daily selection. Thank you for the request!'
  ].join('\n');

  await commentOnce(client, issueNumber, STATUS_MARKERS.published, body);
  await client.addLabels(issueNumber, [REVIEW_REQUEST_LABELS.published]);
  await client.removeLabel(issueNumber, REVIEW_REQUEST_LABELS.awaitingOperator);
  await client.removeLabel(issueNumber, REVIEW_REQUEST_LABELS.processing);
  await client.removeLabel(issueNumber, REVIEW_REQUEST_LABELS.retryNeeded);
  await client.closeIssue(issueNumber, 'completed');
  console.log(`[Issue] #${issueNumber} marked published (${articleUrl}) and closed.`);
}

async function handleMarkRetry(args: string[]): Promise<void> {
  const issueNumber = requireIssueNumber(args);
  const client = buildClient();
  // Label only: the issue stays open and re-runnable, and no error details are ever
  // posted (tokens, internal paths and raw responses must never reach a public issue).
  await client.addLabels(issueNumber, [REVIEW_REQUEST_LABELS.retryNeeded]);
  console.log(`[Issue] #${issueNumber} labeled retry-needed (left open).`);
}

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  switch (subcommand) {
    case 'fetch':
      await handleFetch(rest);
      break;
    case 'mark-processing':
      await handleMarkProcessing(rest);
      break;
    case 'decline':
      await handleDecline(rest);
      break;
    case 'mark-published':
      await handleMarkPublished(rest);
      break;
    case 'mark-retry':
      await handleMarkRetry(rest);
      break;
    default:
      console.error('Usage: review-request-issue.ts <fetch|mark-processing|decline|mark-published|mark-retry> --issue-number <n> [...]');
      process.exit(2);
  }
}

main().catch((e: any) => {
  console.error(`[review-request-issue] ${e.message}`);
  process.exit(1);
});
