import { z } from 'zod';
import { REVIEW_REQUEST_LIMITS } from '../config/review-requests';

/**
 * Schemas and validators for reader review requests.
 *
 * Requests arrive as GitHub issues created through the issue-form template. Issue bodies
 * are editable after creation, so the publish_request workflow fully re-validates every
 * parsed value here before any pipeline work.
 */

export const REQUESTER_RELATIONSHIPS = ['creator_maintainer', 'contributor', 'user', 'other'] as const;
export type RequesterRelationship = (typeof REQUESTER_RELATIONSHIPS)[number];

const URL_SHORTENER_HOSTS = new Set([
  'bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'ow.ly', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 's.id', 'lnkd.in'
]);

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function containsControlCharacters(value: string): boolean {
  return CONTROL_CHARS.test(value);
}

function isIpLiteral(hostname: string): boolean {
  // Bracketed IPv6 hostnames arrive from URL parsing without brackets in Node, with them
  // in some runtimes — normalize before testing.
  const host = hostname.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (host.includes(':')) return true; // Only IPv6 literals contain ':' in a hostname.
  return false;
}

function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host.endsWith('.localhost')
    || host === 'local'
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host === '0.0.0.0';
}

function isPrivateIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  const parts = host.split('.');
  if (parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p))) {
    if (parts[0] === '10' || parts[0] === '127') return true;
    if (parts[0] === '172' && parseInt(parts[1], 10) >= 16 && parseInt(parts[1], 10) <= 31) return true;
    if (parts[0] === '192' && parts[1] === '168') return true;
    if (parts[0] === '169' && parts[1] === '254') return true;
  }
  const lower = host.toLowerCase();
  if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) return true;
  return false;
}

export interface UrlValidationOptions {
  /** Reject query strings (canonical repository URLs must be bare). */
  allowQuery?: boolean;
}

/**
 * Validates a public https URL for use as an official source. Returns the normalized URL
 * (no trailing slash) or null when the value is not acceptable.
 */
export function validatePublicHttpsUrl(value: string, options: UrlValidationOptions = {}): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > REVIEW_REQUEST_LIMITS.urlMaxLength) return null;
  if (containsControlCharacters(trimmed) || /\s/.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (parsed.hash) return null;
  if (!options.allowQuery && parsed.search) return null;

  const hostname = parsed.hostname;
  if (!hostname || isLocalHostname(hostname)) return null;
  if (isIpLiteral(hostname) || isPrivateIpLiteral(hostname)) return null;
  if (URL_SHORTENER_HOSTS.has(hostname.toLowerCase())) return null;
  if (!hostname.includes('.')) return null;

  return trimmed.replace(/\/+$/, '');
}

export interface CanonicalRepository {
  /** Normalized canonical URL (https, no trailing slash). */
  url: string;
  platform: 'github' | 'hugging-face';
  /** `owner/repo` for GitHub, `owner/space` for Hugging Face Spaces. */
  path: string;
}

const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Validates a canonical repository URL against the sources the Eligibility Gate can
 * actually evaluate: a public GitHub repository or a Hugging Face Space.
 */
export function validateCanonicalRepositoryUrl(value: string): CanonicalRepository | null {
  const normalized = validatePublicHttpsUrl(value, { allowQuery: false });
  if (!normalized) return null;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segments = parsed.pathname.split('/').filter(Boolean);

  if (host === 'github.com') {
    if (segments.length !== 2) return null;
    const [owner, repo] = segments;
    if (!GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(repo)) return null;
    if (repo.toLowerCase().endsWith('.git')) return null;
    return {
      url: `https://github.com/${owner}/${repo}`,
      platform: 'github',
      path: `${owner}/${repo}`
    };
  }

  if (host === 'huggingface.co') {
    if (segments.length !== 3 || segments[0] !== 'spaces') return null;
    const [, owner, space] = segments;
    if (!GITHUB_SEGMENT.test(owner) || !GITHUB_SEGMENT.test(space)) return null;
    return {
      url: `https://huggingface.co/spaces/${owner}/${space}`,
      platform: 'hugging-face',
      path: `${owner}/${space}`
    };
  }

  return null;
}

function boundedText(min: number, max: number) {
  return z.string()
    .transform(v => v.trim())
    .refine(v => v.length >= min && v.length <= max, { message: `must be between ${min} and ${max} characters` })
    .refine(v => !containsControlCharacters(v), { message: 'must not contain control characters or line breaks' });
}

/** A review request parsed from the issue-form body, fully re-validated. */
export const ReviewRequestFormSchema = z.object({
  product_name: boundedText(REVIEW_REQUEST_LIMITS.productNameMin, REVIEW_REQUEST_LIMITS.productNameMax),
  canonical_repository_url: z.string().refine(v => validateCanonicalRepositoryUrl(v) !== null, {
    message: 'must be a supported public repository URL (GitHub repository or Hugging Face Space, https only)'
  }),
  official_url: z.string().refine(v => validatePublicHttpsUrl(v, { allowQuery: true }) !== null, {
    message: 'must be a public https URL'
  }).nullable(),
  purpose: boundedText(REVIEW_REQUEST_LIMITS.purposeMin, REVIEW_REQUEST_LIMITS.purposeMax),
  requester_relationship: z.enum(REQUESTER_RELATIONSHIPS),
  additional_official_urls: z.array(z.string().refine(v => validatePublicHttpsUrl(v, { allowQuery: true }) !== null, {
    message: 'must be a public https URL'
  })).max(REVIEW_REQUEST_LIMITS.additionalUrlsMax)
}).strict();

export type ReviewRequestForm = z.infer<typeof ReviewRequestFormSchema>;
