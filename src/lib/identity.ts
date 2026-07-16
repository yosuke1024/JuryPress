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
 * Normalizes a repository name safely to a display name.
 * e.g., "ai-trains-ai" -> "AI Trains AI"
 * e.g., "jurypress" -> "Jurypress"
 */
export function isValidDisplayName(name: string): boolean {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'unknown project') return false;

  // URLs are locations, not product identities.
  if (/^(?:https?:\/\/|www\.)\S+$/i.test(trimmed)) return false;
  
  // Reject H1 containing only markdown images/links/badges
  const cleanMarkdown = trimmed.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '').trim();
  if (cleanMarkdown.length === 0) return false;
  
  // Reject if it only contains HTML tags
  const cleanHtml = cleanMarkdown.replace(/<[^>]*>/g, '').trim();
  if (cleanHtml.length === 0) return false;

  // Reject if it is too long (over 35 characters)
  if (trimmed.length > 35) return false;

  // Reject subjective start fragments
  const subjectivePrefixes = [/^(i|we|they|she|he|you)\b/i, /^(show|ask)\s+hn\b/i];
  if (subjectivePrefixes.some(rx => rx.test(trimmed))) {
    return false;
  }

  return true;
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
 * Extracts the first valid H1 from README markdown content.
 */
export function extractReadmeH1(readmeText: string): string | null {
  const lines = readmeText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Atx-style H1: # Title
    const matchAtx = line.match(/^#\s+(.+)$/);
    if (matchAtx) {
      const title = matchAtx[1].trim();
      const cleanTitle = title.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/<[^>]*>/g, '').trim();
      if (isValidDisplayName(cleanTitle)) {
        return cleanTitle;
      }
    }
    // Setext-style H1: Title\n===
    if (i < lines.length - 1) {
      const nextLine = lines[i + 1].trim();
      if (nextLine.match(/^={3,}$/)) {
        const title = line;
        const cleanTitle = title.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/<[^>]*>/g, '').trim();
        if (isValidDisplayName(cleanTitle)) {
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

  // 1. README H1
  if (params.readmeText) {
    const h1 = extractReadmeH1(params.readmeText);
    if (h1 && isValidDisplayName(h1)) {
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

  // 3. Official website URL / HTML name extraction
  if (params.officialWebsiteUrl) {
    try {
      const url = new URL(params.officialWebsiteUrl);
      const hostParts = url.hostname.split('.');
      const domain = hostParts.length > 2 ? hostParts[1] : hostParts[0];
      if (domain && domain !== 'github' && domain !== 'huggingface') {
        const name = normalizeRepositoryName(domain);
        if (isValidDisplayName(name)) {
          return {
            ...(result as any),
            canonical_display_name: name,
            identity_source: "official_website"
          };
        }
      }
    } catch (e) {}
  }

  if (params.officialSiteHtml) {
    const match = params.officialSiteHtml.match(/<title>([^<]+)<\/title>/i);
    if (match) {
      const title = match[1].replace(/(\||-).+$/, '').trim();
      if (title && isValidDisplayName(title)) {
        return {
          ...(result as any),
          canonical_display_name: title,
          identity_source: "official_website"
        };
      }
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
