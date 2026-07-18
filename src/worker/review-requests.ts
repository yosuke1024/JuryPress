import {
  REVIEW_REQUEST_LABELS,
  REVIEW_REQUEST_LIMITS,
  REVIEW_REQUEST_PRODUCTION_ORIGIN,
  REVIEW_REQUEST_REPO,
  REVIEW_REQUEST_TURNSTILE_ACTION
} from '../config/review-requests';
import {
  ReviewRequestSubmissionSchema,
  validateCanonicalRepositoryUrl,
  validatePublicHttpsUrl
} from '../schemas/review-request';
import { buildIssueBody, buildIssueTitle } from '../lib/review-requests/issue-body';
import { GitHubApiError, GitHubIssuesClient } from '../lib/review-requests/github-issues';

/**
 * POST /jurypress/api/review-requests — the only dynamic endpoint on the site.
 *
 * Fail-closed by design: missing secrets are a 503 before anything reads the body,
 * Turnstile is verified server-side on every request, and no upstream (GitHub/Turnstile)
 * response body or token ever reaches the client.
 */

export interface ReviewRequestWorkerEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  TURNSTILE_SECRET_KEY?: string;
  JURYPRESS_ISSUE_TOKEN?: string;
  /** Overridable for previews; defaults to the production origin. */
  REVIEW_REQUESTS_ALLOWED_ORIGIN?: string;
}

export interface ReviewRequestDeps {
  fetchImpl?: typeof fetch;
  randomUUID?: () => string;
  turnstileVerifyUrl?: string;
  githubApiBase?: string;
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: code, message });
}

export async function handleReviewRequestApi(
  request: Request,
  env: ReviewRequestWorkerEnv,
  deps: ReviewRequestDeps = {}
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  if (request.method !== 'POST') {
    return errorResponse(405, 'method_not_allowed', 'Only POST is supported.');
  }

  // Fail closed BEFORE reading anything when the endpoint is not fully configured.
  if (!env.TURNSTILE_SECRET_KEY || !env.JURYPRESS_ISSUE_TOKEN) {
    return errorResponse(503, 'service_unavailable', 'Review requests are temporarily unavailable.');
  }

  const allowedOrigin = (env.REVIEW_REQUESTS_ALLOWED_ORIGIN || REVIEW_REQUEST_PRODUCTION_ORIGIN).replace(/\/+$/, '');
  const origin = request.headers.get('Origin');
  if (!origin || origin.replace(/\/+$/, '') !== allowedOrigin) {
    return errorResponse(403, 'forbidden_origin', 'Cross-origin requests are not accepted.');
  }

  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return errorResponse(415, 'unsupported_media_type', 'Content-Type must be application/json.');
  }

  const declaredLength = Number(request.headers.get('Content-Length') || '0');
  if (declaredLength > REVIEW_REQUEST_LIMITS.requestBodyMaxBytes) {
    return errorResponse(413, 'payload_too_large', 'Request body is too large.');
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return errorResponse(400, 'invalid_request', 'The request body could not be read.');
  }
  if (rawBody.length > REVIEW_REQUEST_LIMITS.requestBodyMaxBytes) {
    return errorResponse(413, 'payload_too_large', 'Request body is too large.');
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    return errorResponse(400, 'invalid_request', 'The request body is not valid JSON.');
  }

  // Honeypot check runs before schema validation so automated form fillers get the same
  // generic rejection as any other invalid payload.
  if (typeof parsedBody === 'object' && parsedBody !== null && (parsedBody as any).website) {
    return errorResponse(400, 'invalid_request', 'The submission could not be accepted.');
  }

  const submission = ReviewRequestSubmissionSchema.safeParse(parsedBody);
  if (!submission.success) {
    const fields = Array.from(new Set(submission.error.issues.map(i => i.path.join('.') || 'payload')));
    return errorResponse(400, 'invalid_request', `Invalid fields: ${fields.join(', ')}.`);
  }
  const data = submission.data;

  // Server-side Turnstile verification (client-side state is never trusted).
  let verdict: { success: boolean; hostname?: string; action?: string };
  try {
    const verifyBody = new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: data.turnstile_token
    });
    const remoteIp = request.headers.get('CF-Connecting-IP');
    if (remoteIp) verifyBody.set('remoteip', remoteIp);

    const verifyRes = await fetchImpl(deps.turnstileVerifyUrl ?? TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: verifyBody.toString()
    });
    if (!verifyRes.ok) {
      return errorResponse(503, 'verification_unavailable', 'Human verification is temporarily unavailable. Please try again.');
    }
    verdict = await verifyRes.json() as any;
  } catch {
    return errorResponse(503, 'verification_unavailable', 'Human verification is temporarily unavailable. Please try again.');
  }

  const expectedHostname = new URL(allowedOrigin).hostname;
  if (!verdict.success
    || (verdict.hostname && verdict.hostname !== expectedHostname)
    || (verdict.action && verdict.action !== REVIEW_REQUEST_TURNSTILE_ACTION)) {
    // Covers failed, expired and re-used tokens — siteverify rejects all of them.
    return errorResponse(400, 'turnstile_failed', 'Human verification failed. Please refresh and try again.');
  }
  if (!verdict.hostname || !verdict.action) {
    return errorResponse(400, 'turnstile_failed', 'Human verification failed. Please refresh and try again.');
  }

  const canonical = validateCanonicalRepositoryUrl(data.canonical_repository_url);
  if (!canonical) {
    return errorResponse(400, 'invalid_request', 'Invalid fields: canonical_repository_url.');
  }
  const officialUrl = data.official_url ? validatePublicHttpsUrl(data.official_url, { allowQuery: true }) : null;
  const additionalUrls = (data.additional_official_urls ?? [])
    .map(url => validatePublicHttpsUrl(url, { allowQuery: true }))
    .filter((url): url is string => url !== null);

  const requestId = (deps.randomUUID ?? (() => crypto.randomUUID()))();

  let issue: { number: number; htmlUrl: string };
  try {
    const client = new GitHubIssuesClient({
      token: env.JURYPRESS_ISSUE_TOKEN,
      repo: REVIEW_REQUEST_REPO,
      fetchImpl,
      apiBase: deps.githubApiBase
    });
    issue = await client.createIssue({
      title: buildIssueTitle(data.product_name),
      body: buildIssueBody({
        schema_version: '1.0.0',
        request_id: requestId,
        product_name: data.product_name,
        canonical_repository_url: canonical.url,
        official_url: officialUrl,
        purpose: data.purpose,
        requester_relationship: data.requester_relationship,
        additional_official_urls: additionalUrls
      }),
      labels: [REVIEW_REQUEST_LABELS.request, REVIEW_REQUEST_LABELS.awaitingOperator]
    });
  } catch (e: unknown) {
    // Map upstream failures to safe public errors; never echo the upstream body or the
    // token, and never report success when the issue was not created.
    if (e instanceof GitHubApiError) {
      if (e.status === 429 || e.status === 403) {
        return errorResponse(429, 'rate_limited', 'Too many requests right now. Please try again later.');
      }
      return errorResponse(503, 'service_unavailable', 'Review requests are temporarily unavailable. Please try again later.');
    }
    return errorResponse(503, 'service_unavailable', 'Review requests are temporarily unavailable. Please try again later.');
  }

  return jsonResponse(201, {
    issueNumber: issue.number,
    issueUrl: issue.htmlUrl
  });
}
