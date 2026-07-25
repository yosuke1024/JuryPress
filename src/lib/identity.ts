import * as cheerio from 'cheerio';

export type IdentitySource =
  | "readme_h1"
  | "package_manifest"
  | "official_website"
  | "repository_name"
  | "source_title_inference";

export type ProjectIdentity = {
  canonical_display_name: string;
  repository_full_name?: string;
  repository_name?: string;
  source_title: string;
  identity_source: IdentitySource;
};

/**
 * Named entities that legitimately appear in scraped titles and README headings. Unknown
 * entities are left as-is so isValidDisplayName can reject the string as markup residue —
 * decoding "most" of a name is worse than refusing it.
 */
const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&', quot: '"', apos: "'", nbsp: ' ',
  middot: '·', bull: '•', mdash: '—', ndash: '–', hellip: '…',
  copy: '©', reg: '®', trade: '™', times: '×', deg: '°',
  laquo: '«', raquo: '»', sect: '§', para: '¶'
};

const HTML_ENTITY_PATTERN = /&[a-zA-Z][a-zA-Z0-9]*;|&#\d+;|&#[xX][0-9a-fA-F]+;/;

/**
 * Decodes the HTML entities a title can legitimately carry. `&lt;`/`&gt;` are deliberately
 * NOT decoded (they are not in the table): a heading that spells out angle brackets is
 * carrying markup, and the residual-entity rejection in isValidDisplayName handles it.
 */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (match, hex) => {
      const code = parseInt(hex, 16);
      try { return String.fromCodePoint(code); } catch { return match; }
    })
    .replace(/&#(\d+);/g, (match, dec) => {
      const code = parseInt(dec, 10);
      try { return String.fromCodePoint(code); } catch { return match; }
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) => NAMED_HTML_ENTITIES[name.toLowerCase()] ?? match);
}

/**
 * README section headings that name a part of the document, never the product. Compared
 * against the lowercased, punctuation-stripped candidate. This list is a fast reject for the
 * common cases; the structural net for arbitrary README fragments is the repository-name
 * consistency check in resolveProjectIdentity.
 */
const README_SECTION_HEADINGS = new Set([
  'getting started', 'quick start', 'quickstart', 'introduction', 'overview', 'features',
  'installation', 'install', 'usage', 'how to use', 'how it works', 'prerequisites',
  'requirements', 'table of contents', 'contents', 'documentation', 'docs', 'license',
  'contributing', 'changelog', 'faq', 'about', 'examples', 'demo', 'roadmap', 'support',
  'setup', 'configuration', 'acknowledgements', 'acknowledgments',
  'read this in other languages'
]);

/**
 * Whether a string is publishable as a product's display name.
 *
 * This predicate guards every identity source AND the publication-side product.name checks,
 * so a rule added here rejects the value everywhere at once. Rules exist for both incident
 * classes seen in production: markup residue ("React &middot;", from an undecoded README H1
 * entity) and sentence/instruction fragments ("or install uv:", a bash comment mistaken for
 * a heading).
 */
export function isValidDisplayName(name: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'unknown project') return false;

  // URLs are locations, not product identities.
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(trimmed)) return false;

  // Markup is never part of a product name. Reject rather than strip: stripping
  // tags with a regex is incomplete sanitization (nested/partial tags survive),
  // and a name that needed sanitizing is not a name we should publish.
  if (/[<>]/.test(trimmed)) return false;

  // Undecoded HTML entities are markup residue ("React &middot;"), not name material.
  if (HTML_ENTITY_PATTERN.test(trimmed)) return false;

  // A name must have an alphanumeric core; decoration alone is not an identity.
  if (!/[a-zA-Z0-9]/.test(trimmed)) return false;

  // A colon/semicolon-terminated string is a sentence or instruction fragment
  // ("or install uv:"), never a title.
  if (/[:;]$/.test(trimmed)) return false;

  // Leading connectives mark a fragment cut out of a larger sentence.
  if (/^(?:or|and|then|also|via|e\.g\.|i\.e\.)\s/i.test(trimmed)) return false;

  // Document-structure headings are not product names.
  const headingKey = trimmed.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (README_SECTION_HEADINGS.has(headingKey)) return false;

  // Reject H1 containing only markdown images/links/badges
  const cleanMarkdown = trimmed.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '').trim();
  if (cleanMarkdown.length === 0) return false;

  // Reject if it is too long (over 35 characters)
  if (trimmed.length > 35) return false;

  // Reject subjective start fragments
  const subjectivePrefixes = [/^(i|we|they|she|he|you)\b/i, /^(show|ask)\s+hn\b/i];
  if (subjectivePrefixes.some(rx => rx.test(trimmed))) {
    return false;
  }

  return true;
}

function collapseForComparison(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Whether a scraped display name plausibly names the same project as the repository.
 *
 * Scrape-derived sources (README H1, official site) can surface text that has nothing to do
 * with the project — a section heading, a bash comment, a hosting provider's banner. A real
 * display name almost always shares its alphanumeric core, or at least one token, with the
 * repository name ("Exmergo Dex" / "dex", "AI Trains AI" / "ai-trains-ai"). No repository
 * name to compare against means no verdict: returns true.
 */
export function isNameConsistentWithRepository(displayName: string, repositoryName?: string | null): boolean {
  if (!repositoryName) return true;
  const nameCollapsed = collapseForComparison(displayName);
  const repoCollapsed = collapseForComparison(repositoryName);
  if (!nameCollapsed || !repoCollapsed) return true;
  if (nameCollapsed.includes(repoCollapsed) || repoCollapsed.includes(nameCollapsed)) return true;

  const nameTokens = displayName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const repoTokens = repositoryName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return nameTokens.some(nameToken => repoTokens.some(repoToken =>
    nameToken === repoToken ||
    (nameToken.length >= 4 && repoToken.length >= 4 &&
      (nameToken.includes(repoToken) || repoToken.includes(nameToken)))
  ));
}

/**
 * Whether the product name appears in reader-facing text. Compared on the collapsed
 * alphanumeric core so punctuation, spacing, and decoration ("Moonshine 🌙") do not defeat
 * the match.
 */
export function nameAppearsInText(displayName: string, text: string): boolean {
  const nameCollapsed = collapseForComparison(displayName);
  if (!nameCollapsed) return false;
  return collapseForComparison(text).includes(nameCollapsed);
}

/**
 * Normalizes a repository name safely to a display name.
 * e.g., "ai-trains-ai" -> "AI Trains AI"
 * e.g., "@npm/pkg" -> "Pkg"
 */
export function normalizeRepositoryName(repoName: string): string {
  let cleaned = repoName;
  // Handle scoped packages like @npm/pkg or @scoped/some-package
  if (cleaned.startsWith('@')) {
    cleaned = cleaned.replace(/^@[^/]+\//, ''); // Remove @scoped/
  }
  
  const words = cleaned.replace(/[-_.]/g, ' ').split(/\s+/).filter(Boolean);
  const normalized = words
    .map(word => {
      const upper = word.toUpperCase();
      if (['AI', 'RL', 'ML', 'API', 'UI', 'UX', 'CI', 'CD', 'E2E', 'HN', 'SDK'].includes(upper)) {
        return upper;
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
  return normalized;
}

/**
 * Resolves a markdown heading into a candidate display name.
 *
 * Headings carrying markup are rejected outright rather than sanitized: an H1
 * containing HTML is not a product name, and regex tag-stripping is incomplete
 * against nested or partial tags. Image syntax (logos, CI badges) is dropped and
 * links contribute only their display text, so "[JuryPress](https://x)" yields
 * "JuryPress" while a badge-only heading yields null.
 *
 * Entities are decoded and separator tails dropped AFTER link/image resolution, so the
 * canonical React README H1 — "[React](https://react.dev/) &middot; [badges…]" — resolves to
 * "React" rather than surviving as "React &middot;". A decoded entity that turns out to be
 * markup (&lt;/&gt; stay undecoded by design) is rejected like any other markup.
 */
export function markdownTitleToDisplayName(rawTitle: string): string | null {
  if (/[<>]/.test(rawTitle)) return null;

  let text = rawTitle
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  text = decodeHtmlEntities(text);
  if (/[<>]/.test(text)) return null;

  // A separator mid-string starts a tagline; a separator at the end is the stump left where
  // links and badges were stripped. Both are decoration, not name.
  text = stripSiteTagline(text)
    .replace(/\s+[|·•–—-]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

  return text.length > 0 ? text : null;
}

/**
 * Extracts the first valid H1 from README markdown content.
 *
 * Fenced code blocks are skipped entirely: a `#` inside a ``` fence is a shell comment, not
 * a heading. The production incident this guards against is literal — a README whose install
 * section contained "# or install uv:" inside a bash fence, which this function then adopted
 * as the project's canonical display name.
 */
export function extractReadmeH1(readmeText: string): string | null {
  const lines = readmeText.split('\n');
  let fenceMarker: '`' | '~' | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const fence = line.match(/^(`{3,}|~{3,})/);
    if (fence) {
      const marker = fence[1][0] as '`' | '~';
      if (fenceMarker === null) {
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        fenceMarker = null;
      }
      continue;
    }
    if (fenceMarker !== null) continue;

    // Atx-style H1: # Title
    const matchAtx = line.match(/^#\s+(.+)$/);
    if (matchAtx) {
      const cleanTitle = markdownTitleToDisplayName(matchAtx[1].trim());
      if (cleanTitle && isValidDisplayName(cleanTitle)) {
        return cleanTitle;
      }
    }
    // Setext-style H1: Title\n===
    if (i < lines.length - 1) {
      const nextLine = lines[i + 1].trim();
      if (nextLine.match(/^={3,}$/)) {
        const cleanTitle = markdownTitleToDisplayName(line);
        if (cleanTitle && isValidDisplayName(cleanTitle)) {
          return cleanTitle;
        }
      }
    }
  }
  return null;
}

/**
 * Extracts product name from package manifest contents.
 */
export function extractPackageManifestName(manifestContent: string, fileName: string): string | null {
  try {
    if (fileName === 'package.json') {
      const parsed = JSON.parse(manifestContent);
      if (parsed.name && typeof parsed.name === 'string') {
        return normalizeRepositoryName(parsed.name);
      }
    } else if (fileName === 'Cargo.toml') {
      const match = manifestContent.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (match) return normalizeRepositoryName(match[1]);
    } else if (fileName === 'pyproject.toml') {
      const match = manifestContent.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (match) return normalizeRepositoryName(match[1]);
    } else if (fileName === 'go.mod') {
      const match = manifestContent.match(/^\s*module\s+(.+)$/m);
      if (match) {
        const parts = match[1].trim().split('/');
        return normalizeRepositoryName(parts[parts.length - 1]);
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Drops a trailing tagline from a site name, e.g. "JuryPress — daily reviews"
 * -> "JuryPress". Requires whitespace around the separator so hyphenated names
 * such as "Foo-Bar" survive intact.
 */
function stripSiteTagline(rawName: string): string {
  return rawName.replace(/\s+[|·•–—-]\s+.*$/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Extracts an EXPLICIT product name from official site HTML.
 *
 * Only names the site states about itself are accepted. The hostname is never
 * mined for a name: "foo.vercel.app" names the host that serves the project,
 * not the project, and would yield "Vercel". Returns null when the page states
 * no usable name, so the caller falls back to the repository name.
 *
 * The document is parsed rather than regex-scraped, and every candidate goes
 * through isValidDisplayName, which rejects anything carrying markup.
 */
export function extractExplicitSiteName(html: string): string | null {
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return null;
  }

  const candidates = [
    $('meta[name="application-name"]').attr('content'),
    $('meta[property="og:site_name"]').attr('content'),
    $('meta[property="og:title"]').attr('content'),
    $('h1').first().text(),
    $('title').first().text()
  ];

  for (const raw of candidates) {
    if (!raw) continue;
    const name = stripSiteTagline(raw);
    if (name && isValidDisplayName(name)) return name;
  }
  return null;
}

/**
 * Infers product name from the source title, avoiding single words or fragments like "I RL".
 */
export function inferFromSourceTitle(sourceTitle: string): string {
  let cleaned = sourceTitle;
  
  // Remove starting personal statements or generic prefixes
  cleaned = cleaned.replace(/^(I |we |they |show hn:|ask hn:)\s*/i, '');
  
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    if (words[0].toLowerCase() === 'rl' && words.length > 1) {
      return `RL ${words[1]}`;
    }
    // Take first 2-3 words, avoiding single characters or pronouns
    const candidateWords = words.slice(0, 3).join(' ');
    if (candidateWords.toLowerCase() === 'i rl' || candidateWords.toLowerCase() === 'i rl trained' || candidateWords.toLowerCase() === 'rl') {
      return "RL Agent"; 
    }
    const result = words.slice(0, 3).join(' ');
    if (isValidDisplayName(result)) {
      return result;
    }
  }
  return "Unknown Project";
}

/**
 * Resolves the ProjectIdentity based on priority:
 * 1. README H1
 * 2. Package manifest name
 * 3. Official website product name
 * 4. Normalized GitHub repository name
 * 5. Source title inference
 */
export function resolveProjectIdentity(params: {
  readmeText?: string;
  manifestContent?: string;
  manifestFileName?: string;
  officialSiteHtml?: string;
  /**
   * Recorded for provenance only. A URL is a location, not a name: deriving one
   * from the hostname turns "foo.vercel.app" into "Vercel". Names come from
   * officialSiteHtml.
   */
  officialWebsiteUrl?: string;
  repositoryFullName?: string;
  sourceTitle: string;
}): ProjectIdentity {
  const result: Partial<ProjectIdentity> = {
    source_title: params.sourceTitle,
  };

  if (params.repositoryFullName) {
    result.repository_full_name = params.repositoryFullName;
    const parts = params.repositoryFullName.split('/');
    result.repository_name = parts[parts.length - 1];
  }

  // 1. README H1. Scrape-derived, so it must also agree with the repository name: a README
  // fragment that shares nothing with the repository ("or install uv:" for graphify) is not
  // this project's name, however well-formed, and the resolution falls through to a source
  // that cannot be wrong about which project it names.
  if (params.readmeText) {
    const h1 = extractReadmeH1(params.readmeText);
    if (h1 && isValidDisplayName(h1) && isNameConsistentWithRepository(h1, result.repository_name)) {
      return {
        ...(result as any),
        canonical_display_name: h1,
        identity_source: "readme_h1"
      };
    }
  }

  // 2. Package manifest name
  if (params.manifestContent && params.manifestFileName) {
    const manifestName = extractPackageManifestName(params.manifestContent, params.manifestFileName);
    if (manifestName && isValidDisplayName(manifestName)) {
      return {
        ...(result as any),
        canonical_display_name: manifestName,
        identity_source: "package_manifest"
      };
    }
  }

  // 3. Official website: an EXPLICIT name stated by the page itself. The URL
  // alone never contributes a name — see extractExplicitSiteName. When the page
  // states no usable name this priority is skipped rather than guessed at.
  // Scrape-derived like the README, so held to the same repository-consistency bar:
  // a hosting banner or campaign title that shares nothing with the repository is
  // skipped, not adopted.
  if (params.officialSiteHtml) {
    const siteName = extractExplicitSiteName(params.officialSiteHtml);
    if (siteName && isNameConsistentWithRepository(siteName, result.repository_name)) {
      return {
        ...(result as any),
        canonical_display_name: siteName,
        identity_source: "official_website"
      };
    }
  }

  // 4. Normalized GitHub repository name
  if (result.repository_name) {
    const normalized = normalizeRepositoryName(result.repository_name);
    if (normalized && isValidDisplayName(normalized)) {
      return {
        ...(result as any),
        canonical_display_name: normalized,
        identity_source: "repository_name"
      };
    }
  }

  // 5. Source title inference
  const inferred = inferFromSourceTitle(params.sourceTitle);
  if (!isValidDisplayName(inferred)) {
    throw new Error(`Unable to resolve a valid canonical display name from source title: ${params.sourceTitle}`);
  }
  return {
    ...(result as any),
    canonical_display_name: inferred,
    identity_source: "source_title_inference"
  };
}
