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
export function normalizeRepositoryName(repoName: string): string {
  // Replace symbols with space
  const words = repoName.replace(/[-_.]/g, ' ').split(/\s+/).filter(Boolean);
  return words
    .map(word => {
      // Specific capitalization for common abbreviations
      const upper = word.toUpperCase();
      if (['AI', 'RL', 'ML', 'API', 'UI', 'UX', 'CI', 'CD', 'E2E', 'HN', 'SDK'].includes(upper)) {
        return upper;
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
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
      if (title && !title.toLowerCase().startsWith('readme')) {
        return title;
      }
    }
    // Setext-style H1: Title\n===
    if (i < lines.length - 1) {
      const nextLine = lines[i + 1].trim();
      if (nextLine.match(/^={3,}$/)) {
        const title = line;
        if (title && !title.toLowerCase().startsWith('readme')) {
          return title;
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
  // If the title is "I RL-trained an agent...", do not extract "I RL".
  // We can try to extract something, but if it is too risky, fallback to a safer title or clean representation.
  // Standard title-based inference: If it contains "I RL-trained...", maybe it is not a clean product name.
  // Let's filter out subjective start fragments.
  let cleaned = sourceTitle;
  
  // Remove starting personal statements or generic prefixes
  cleaned = cleaned.replace(/^(I |we |they |show hn:|ask hn:)\s*/i, '');
  
  // If the title is too long, we might just use a truncated version or clean title.
  // However, the rule explicitly forbids using fragments like "I RL" as a product name.
  // If we must infer from source title, let's take the first 3 words but ensure it doesn't result in "I RL" etc.
  // Actually, we can return a normalized title or the source title itself if no specific product name is found.
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 0) {
    if (words[0].toLowerCase() === 'rl' && words.length > 1) {
      return `RL ${words[1]}`;
    }
    // Take first 2-3 words, avoiding single characters or pronouns
    const candidateWords = words.slice(0, 3).join(' ');
    if (candidateWords.toLowerCase() === 'i rl' || candidateWords.toLowerCase() === 'i rl trained') {
      return "RL Agent"; // Safe fallback
    }
    return words.slice(0, 3).join(' ');
  }
  return "Unknown Project";
}

/**
 * Resolves the ProjectIdentity based on priority:
 * 1. README H1
 * 2. Package manifest name
 * 3. Official website product name (represented in evidence type 'official_site')
 * 4. Normalized GitHub repository name
 * 5. Source title inference
 */
export function resolveProjectIdentity(params: {
  readmeText?: string;
  manifestContent?: string;
  manifestFileName?: string;
  officialSiteHtml?: string;
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
    if (h1 && h1.length > 1 && h1.toLowerCase() !== 'i rl') {
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
    if (manifestName && manifestName.length > 1 && manifestName.toLowerCase() !== 'i rl') {
      return {
        ...(result as any),
        canonical_display_name: manifestName,
        identity_source: "package_manifest"
      };
    }
  }

  // 3. Official website (we can parse <title> or og:title from officialSiteHtml if available)
  if (params.officialSiteHtml) {
    // Basic <title> extraction
    const match = params.officialSiteHtml.match(/<title>([^<]+)<\/title>/i);
    if (match) {
      const title = match[1].replace(/(\||-).+$/, '').trim(); // Remove suffix like " | GitHub"
      if (title && title.length > 1 && title.toLowerCase() !== 'i rl') {
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
    if (normalized && normalized.length > 1 && normalized.toLowerCase() !== 'i rl') {
      return {
        ...(result as any),
        canonical_display_name: normalized,
        identity_source: "repository_name"
      };
    }
  }

  // 5. Source title inference
  const inferred = inferFromSourceTitle(params.sourceTitle);
  return {
    ...(result as any),
    canonical_display_name: inferred,
    identity_source: "source_title_inference"
  };
}
