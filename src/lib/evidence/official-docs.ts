/**
 * Official documentation collection.
 *
 * The Grok Build review stated as fact that browser authentication was required, that local
 * models could not be used, and that the tool existed only to deliver paid models. The
 * official documentation contradicts all three. None of it was collected: the evidence base
 * was repository metadata, the README, a manifest and the repository page. The jury did not
 * reason badly from what it had — it was never given the material that would have stopped it.
 *
 * What makes this safe to widen is where the domain comes from. The project's own author
 * writes the README, so a README link is a link the subject of the review chose. Treating it
 * as the definition of "official" would let any repository nominate what JuryPress reads
 * about it. The domain therefore comes only from GitHub's own structured configuration —
 * the repository's `homepage`, falling back to the owning organisation's `blog` — and nothing
 * outside that host is fetched. A README may point at a path; it can never introduce a host.
 *
 * The organisation fallback is not a loosening. Most repositories leave `homepage` empty
 * (xai-org/grok-build, the review that prompted this work, is one), while their organisation
 * records the same domain the documentation lives on. Both fields are settings GitHub returns,
 * neither is free text inside the repository, and the org value is if anything the harder of
 * the two for a single repository to influence.
 */

/** Conventional documentation paths, tried against the confirmed official origin. */
export const OFFICIAL_DOC_PATHS = ['/docs', '/changelog', '/pricing', '/news'] as const;

/** Total official-domain pages fetched per review, including the homepage itself. */
export const OFFICIAL_DOCS_FETCH_CAP = 6;

/**
 * The origin that counts as official for this project, or null when there is none.
 *
 * Rejects anything that is not plain https, and anything whose host is a code-hosting or
 * package domain: those are already collected through their own paths, and a homepage
 * pointing back at the repository would otherwise spend the budget re-reading it.
 */
const NON_OFFICIAL_HOSTS = [
  'github.com',
  'www.github.com',
  'gitlab.com',
  'bitbucket.org',
  'huggingface.co',
  'npmjs.com',
  'www.npmjs.com',
  'crates.io',
  'pypi.org'
];

function parseOfficialCandidate(value: unknown): URL | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  // http is refused rather than upgraded: an official site that cannot serve TLS is not a
  // source worth treating as authoritative, and silently rewriting the scheme would fetch a
  // URL the repository never declared.
  if (url.protocol !== 'https:') return null;
  if (NON_OFFICIAL_HOSTS.includes(url.hostname.toLowerCase())) return null;
  return url;
}

/**
 * The official origin for this project: the repository's homepage when it declares one, the
 * owning organisation's blog otherwise. Both come from the GitHub API; neither is README text.
 */
export function resolveOfficialOrigin(homepage: unknown, ownerUrl?: unknown): URL | null {
  return parseOfficialCandidate(homepage) ?? parseOfficialCandidate(ownerUrl);
}

/** Same host only — not merely a suffix match, which `evil-x.ai` would pass against `x.ai`. */
export function isSameOfficialHost(candidate: string, origin: URL): boolean {
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === origin.hostname.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Documentation URLs to try, in priority order: the homepage itself, then the conventional
 * paths, then any link the README makes to the SAME host.
 *
 * README links are a hint about where a project keeps its documentation, nothing more. They
 * are filtered against the already-confirmed origin, so the README can only ever narrow the
 * search inside a host GitHub told us about.
 */
export function buildOfficialDocUrls(input: {
  homepage: unknown;
  /** The owning organisation's `blog`, used only when the repository declares no homepage. */
  ownerUrl?: unknown;
  readmeText?: string;
}): string[] {
  const origin = resolveOfficialOrigin(input.homepage, input.ownerUrl);
  if (!origin) return [];

  const urls: string[] = [origin.toString()];
  for (const docPath of OFFICIAL_DOC_PATHS) {
    urls.push(new URL(docPath, origin.origin).toString());
  }

  if (input.readmeText) {
    for (const match of input.readmeText.matchAll(/https:\/\/[^\s)>\]"'`]+/g)) {
      const cleaned = match[0].replace(/[.,;:]+$/, '');
      if (isSameOfficialHost(cleaned, origin)) urls.push(cleaned);
    }
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const url of urls) {
    const normalised = url.replace(/\/$/, '');
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    deduped.push(url);
  }
  return deduped.slice(0, OFFICIAL_DOCS_FETCH_CAP);
}
