import * as cheerio from 'cheerio';
import crypto from 'crypto';
import dns from 'dns';
import http from 'http';
import https from 'https';
import type { Candidate } from '../../schemas/selection';
import { 
  EvidenceSchema, 
  type Evidence, 
  type EvidenceFactClass,
  type GitHubMetadataSnapshot,
  type DiscussionItem,
  type DiscussionEvidence,
  type EvidenceCollectionResult
} from '../../schemas/evidence';
import { resolveDataMode } from '../content-root';
import { buildOfficialDocUrls } from './official-docs';
import { pickRootSourceFile, pickSourceFromTree, type RepoEntry } from './source-detection';
import { extractPackageManifestName, extractReadmeH1, resolveProjectIdentity, type ProjectIdentity } from '../identity';

/** Comments per classification serialized into the evidence summary sent to the model. */
const MODEL_INPUT_COMMENT_CAP = 5;

export class EvidenceCollector {
  public evidenceUsage = {
    raw_character_count: 0,
    sanitized_character_count: 0,
    characters_sent_to_model: 0,
    budget_limit: 24000,
    reduction_ratio: 0 as number | null
  };

  public metadataSnapshot?: GitHubMetadataSnapshot;
  public projectIdentity?: ProjectIdentity;
  public discussionEvidence?: DiscussionEvidence;
  private discussionItems: DiscussionItem[] = [];

  private factClassForEvidence(type: string): EvidenceFactClass {
    if (type === 'api_metadata') return 'confirmed_fact';
    if (['source_code', 'test_file', 'ci_workflow', 'dependency_manifest'].includes(type)) {
      return 'repository_observation';
    }
    if (type === 'source_discussion') return 'community_opinion';
    // official_docs is first-party but still the creator speaking: documentation saying a
    // tool runs locally is evidence that the claim exists, not that the behaviour was seen.
    // Promoting it to confirmed_fact would repeat, in the opposite direction, the error that
    // made this collection necessary.
    if (['readme', 'official_site', 'official_docs', 'additional_evidence'].includes(type)) {
      return 'creator_claim';
    }
    return 'unverified';
  }


  /**
   * A representative source file from anywhere in the tree, when the project keeps no source
   * at its root. One recursive tree listing rather than a directory-by-directory walk: the
   * walk settled on whichever crate sorted first, which in a Rust workspace is often a build
   * or proto helper with no core source. Seeing the whole tree at once avoids that. A
   * truncated tree (very large repos) or a failed request simply yields no extra source
   * evidence, exactly as before.
   */
  private async probeTreeForSourceFile(
    repoPath: string,
    branch: string
  ): Promise<{ path: string; name: string } | null> {
    let tree: any;
    try {
      const json = await this.safeFetch(
        `https://api.github.com/repos/${repoPath}/git/trees/${branch}?recursive=1`
      );
      tree = json ? JSON.parse(json) : null;
    } catch {
      return null;
    }
    if (!tree || !Array.isArray(tree.tree)) return null;

    const paths = tree.tree.filter((e: any) => e.type === 'blob').map((e: any) => e.path as string);
    const chosen = pickSourceFromTree(paths);
    return chosen ? { path: chosen, name: chosen.slice(chosen.lastIndexOf('/') + 1) } : null;
  }

  private isPrivateIP(ip: string): boolean {
    // Basic IPv4 private/local check
    const parts = ip.split('.');
    if (parts.length === 4) {
      if (parts[0] === '10') return true;
      if (parts[0] === '127') return true;
      if (parts[0] === '172' && parseInt(parts[1]) >= 16 && parseInt(parts[1]) <= 31) return true;
      if (parts[0] === '192' && parts[1] === '168') return true;
      if (parts[0] === '169' && parts[1] === '254') return true; // Link-local
    }
    // Basic IPv6 check
    if (ip === '::1' || ip.toLowerCase().startsWith('fc') || ip.toLowerCase().startsWith('fd') || ip.toLowerCase().startsWith('fe80')) {
      return true;
    }
    return false;
  }

  private async safeFetch(urlStr: string, redirects = 0, useToken = true): Promise<string | null> {
    if (redirects > 3) {
      console.warn('Max redirects exceeded:', urlStr);
      return null;
    }
    try {
      const parsedUrl = new URL(urlStr);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return null;
      }
      if (parsedUrl.hostname === 'localhost') return null;

      // DNS lookup
      const lookup = await dns.promises.lookup(parsedUrl.hostname).catch(() => null);
      if (!lookup) return null;
      if (this.isPrivateIP(lookup.address)) {
        console.warn('Blocked private/local IP:', lookup.address);
        return null;
      }

      return new Promise((resolve, reject) => {
        const client = parsedUrl.protocol === 'https:' ? https : http;
        const headers: Record<string, string> = {
          'User-Agent': 'Mozilla/5.0 (compatible; JuryPress/1.0; +https://pixapps.ai/jurypress/)'
        };
        
        if (process.env.GITHUB_TOKEN && parsedUrl.hostname === 'api.github.com' && useToken) {
          headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
        }

        const req = client.request(parsedUrl, {
          method: 'GET',
          headers,
          timeout: 10000
        }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            // follow redirect
            resolve(this.safeFetch(new URL(res.headers.location, urlStr).toString(), redirects + 1, useToken));
            return;
          }

          if (res.statusCode === 401 && useToken && process.env.GITHUB_TOKEN) {
            console.warn('[safeFetch] GITHUB_TOKEN returned 401 Bad Credentials. Retrying without token...');
            resolve(this.safeFetch(urlStr, redirects, false));
            return;
          }

          if (!res.statusCode || res.statusCode >= 400) {
            resolve(null);
            return;
          }

          const contentType = res.headers['content-type'] || '';
          if (!contentType.includes('text/html') && !contentType.includes('text/plain') && !contentType.includes('application/json')) {
            res.destroy();
            resolve(null);
            return;
          }

          let data = '';
          let bytes = 0;
          const maxBytes = 2 * 1024 * 1024; // 2MB stream limit

          res.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              res.destroy();
              resolve(null); // Return null if too large
            } else {
              data += chunk.toString('utf8');
            }
          });

          res.on('end', () => resolve(data));
        });

        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });

        req.on('error', () => resolve(null));
        req.end();
      });

    } catch (e) {
      return null;
    }
  }

  private sanitizeHtml(html: string): string {
    const $ = cheerio.load(html);
    $('script, style, noscript, iframe, frame, object, embed, canvas, video, audio, svg, meta, head').remove();
    $('nav, footer, header, aside, .nav, .footer, .header, .sidebar, .menu, #menu, .cookie-notice, .sponsor, .contributors, .related-articles, .changelog, .release-notes').remove();
    
    $('p, li, h1, h2, h3, h4, h5, h6, pre, code, section, article').each((_, el) => {
      $(el).prepend('\n').append('\n');
    });

    return $('body').text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n\n').trim();
  }

  private extractHnComments(html: string, sourceUrl: string, parentEvidenceId: string): DiscussionItem[] {
    const $ = cheerio.load(html);
    const comments: string[] = [];
    $('.commtext').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt) comments.push(txt);
    });

    const items: DiscussionItem[] = [];
    const criticalRegex = /\b(reward\s+design|metric\s+gaming|benchmark\s+leakage|reproducibility|security\s+(?:risk|concern|boundary)|missing\s+failure|unclear\s+target|deployment\s+complexity|data\s+leak(?:age)?|overfitting?|cannot\s+reproduce|hard\s+to\s+reproduce|design\s+flaw|failure|drawback|limitation|critical\s+issue|bug|error)\b/i;
    const positiveRegex = /\b(great|awesome|good|impressive|nice|love|clean|fast|powerful|innovative|interesting|cool)\b/i;

    const isNegated = (text: string, word: string): boolean => {
      const lower = text.toLowerCase();
      const negationPatterns = [
        new RegExp(`\\b(no|not|without|never)\\s+${word}\\b`, 'i'),
        new RegExp(`\\b${word}\\s+(is\\s+not|are\\s+not|was\\s+not|were\\s+not)\\b`, 'i')
      ];
      return negationPatterns.some(pat => pat.test(lower));
    };

    let idx = 0;
    for (const comment of comments) {
      const lower = comment.toLowerCase();
      let isCritical = false;
      const critMatch = comment.match(criticalRegex);
      if (critMatch) {
        const matchedWord = critMatch[0].toLowerCase();
        isCritical = !isNegated(comment, matchedWord);
      }

      let isPositive = false;
      if (!isCritical) {
        isPositive = positiveRegex.test(comment);
      }

      let classification: "positive" | "critical" | "neutral" = "neutral";
      if (isCritical) {
        classification = "critical";
      } else if (isPositive) {
        classification = "positive";
      }

      const item: DiscussionItem = {
        discussion_item_id: `${parentEvidenceId}-item-${idx++}`,
        parent_evidence_id: parentEvidenceId,
        source_url: sourceUrl,
        excerpt: comment.substring(0, 300),
        fact_class: "community_opinion",
        classification: classification,
        materiality_reason_code: isCritical ? "COMMUNITY_CRITICISM" : undefined,
        // Set by the caller once the summary actually sent to the model is known.
        included_in_model_input: false,
        requires_public_response: false
      };
      items.push(item);
    }

    return items;
  }

  private truncateSmart(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    
    // 1. Try paragraph boundary (\n\n)
    let cutPoint = text.lastIndexOf('\n\n', maxLen);
    if (cutPoint !== -1 && cutPoint > maxLen * 0.5) {
      return text.substring(0, cutPoint).trim() + '\n...[Truncated due to budget]';
    }
    
    // 2. Try newline boundary (\n)
    cutPoint = text.lastIndexOf('\n', maxLen);
    if (cutPoint !== -1 && cutPoint > maxLen * 0.5) {
      return text.substring(0, cutPoint).trim() + '\n...[Truncated due to budget]';
    }

    // 3. Try sentence boundary
    const sentenceBoundaryRegex = /[.!?。！？]\s/g;
    let match;
    let bestSentenceCut = -1;
    while ((match = sentenceBoundaryRegex.exec(text)) !== null) {
      if (match.index <= maxLen) {
        bestSentenceCut = match.index + 1;
      } else {
        break;
      }
    }
    if (bestSentenceCut !== -1 && bestSentenceCut > maxLen * 0.5) {
      return text.substring(0, bestSentenceCut).trim() + '\n...[Truncated due to budget]';
    }

    return text.substring(0, maxLen).trim() + '\n...[Truncated due to budget]';
  }

  public async collect(candidate: Candidate): Promise<Evidence[]> {
    const result = await this.collectWithContext(candidate);
    return result.evidences;
  }

  public async collectWithContext(candidate: Candidate): Promise<EvidenceCollectionResult> {
    this.evidenceUsage.raw_character_count = 0;
    this.evidenceUsage.sanitized_character_count = 0;
    this.metadataSnapshot = undefined;
    this.projectIdentity = undefined;
    this.discussionEvidence = undefined;
    this.discussionItems = [];
    const evidences: Evidence[] = [];
    const uniqueUrls = new Set<string>();
    const uniqueIds = new Set<string>();
    const uniqueHashes = new Set<string>();
    
    let snapshotId: string | undefined;

    const addEvidence = (ev: Evidence | null) => {
      if (ev && !uniqueIds.has(ev.evidence_id) && !uniqueUrls.has(ev.url) && !uniqueHashes.has(ev.content_hash)) {
        uniqueIds.add(ev.evidence_id);
        uniqueUrls.add(ev.url);
        uniqueHashes.add(ev.content_hash);
        evidences.push(ev);
      }
    };
    
    const fetchEvidence = async (url: string, type: string, title: string, maxLen = 4000): Promise<Evidence | null> => {
      if (uniqueUrls.has(url)) return null;
      const text = await this.safeFetch(url);
      if (text) {
        this.evidenceUsage.raw_character_count += text.length;
        const isHtml = text.trim().startsWith('<');
        let cleanText = text;
        let discussionItems: DiscussionItem[] = [];
        const evidenceId = `ev-${crypto.createHash('md5').update(url).digest('hex').substring(0,8)}`;

        if (isHtml) {
          let isHn = false;
          try {
            const parsed = new URL(url);
            isHn = parsed.hostname === 'news.ycombinator.com';
          } catch (e) {}

          if (type === 'source_discussion' && isHn) {
            discussionItems = this.extractHnComments(text, url, evidenceId);
            this.discussionItems.push(...discussionItems);

            let summaryText = '=== Discussion Analysis ===\n';
            const criticalItems = discussionItems.filter(i => i.classification === 'critical');
            const positiveItems = discussionItems.filter(i => i.classification === 'positive');
            const neutralItems = discussionItems.filter(i => i.classification === 'neutral');

            summaryText += 'Positive Comments:\n' + (positiveItems.length > 0 ? positiveItems.slice(0, MODEL_INPUT_COMMENT_CAP).map(c => `- ${c.excerpt}`).join('\n') : '- None') + '\n\n';
            summaryText += 'Critical Comments (Community Concerns):\n' + (criticalItems.length > 0 ? criticalItems.slice(0, MODEL_INPUT_COMMENT_CAP).map(c => `- ${c.excerpt}`).join('\n') : '- None') + '\n\n';
            summaryText += 'Neutral Comments:\n' + (neutralItems.length > 0 ? neutralItems.slice(0, MODEL_INPUT_COMMENT_CAP).map(c => `- ${c.excerpt}`).join('\n') : '- None');

            cleanText = summaryText;
          } else {
            cleanText = this.sanitizeHtml(text);
          }
        }
        this.evidenceUsage.sanitized_character_count += cleanText.length;

        const hash = crypto.createHash('sha256').update(cleanText).digest('hex');
        const summary = this.truncateSmart(cleanText, maxLen);

        // Decide inclusion against the summary as finally sent: the per-class cap
        // is applied above, but truncation to the budget can still drop excerpts
        // that were selected. An excerpt counts as model input only if it
        // survived verbatim.
        for (const item of discussionItems) {
          item.included_in_model_input = summary.includes(item.excerpt);
          item.requires_public_response = item.included_in_model_input
            && item.classification === 'critical'
            && Boolean(item.materiality_reason_code);
        }

        const factClass = this.factClassForEvidence(type);
        const evidenceData = {
          evidence_id: evidenceId,
          type: type,
          url: url,
          title: title,
          retrieved_at: new Date().toISOString(),
          content_hash: hash,
          summary,
          snapshot_id: snapshotId,
          claims: [{
            claim_id: `${evidenceId}-default`,
            text: `${title} was collected from ${url}.`,
            claim_type: factClass
          }]
        };
        
        try {
          return EvidenceSchema.parse(evidenceData);
        } catch (e) {
          console.warn('Evidence schema validation failed for URL:', url);
          return null;
        }
      }
      return null;
    };

    let isProduction = false;
    try {
      isProduction = resolveDataMode() === 'production';
    } catch (e) {}

    let isGithub = false;
    let isHuggingFace = false;
    try {
      const parsed = new URL(candidate.canonicalUrl);
      const hostname = parsed.hostname.toLowerCase();
      isGithub = hostname === 'github.com' || hostname.endsWith('.github.com');
      isHuggingFace = (hostname === 'huggingface.co' || hostname.endsWith('.huggingface.co')) && parsed.pathname.startsWith('/spaces');
    } catch (e) {}

    // 1. Fetch Repository Details First (for GitHub/HuggingFace metadata extraction)
    if (isGithub) {
      try {
        const repoPath = new URL(candidate.canonicalUrl).pathname.replace(/^\/|\/$/g, '');
        
        // Repo Details
        const repoJsonStr = await this.safeFetch(`https://api.github.com/repos/${repoPath}`);
        if (!repoJsonStr) {
          throw new Error(`Failed to fetch repo metadata from GitHub API: ${repoPath}`);
        }
        const repoData = JSON.parse(repoJsonStr);

        // Generate a single unique and deterministic snapshot ID for this execution run
        snapshotId = `snap-${crypto.createHash('md5').update(`${candidate.canonicalUrl}-${new Date().toISOString()}`).digest('hex').substring(0, 12)}`;

        // Root files to verify presence
        const contentsJsonStr = await this.safeFetch(`https://api.github.com/repos/${repoPath}/contents/`);
        const filesList = contentsJsonStr ? JSON.parse(contentsJsonStr) : [];
        const fileNames = Array.isArray(filesList) ? filesList.map((f: any) => f.name) : [];
        const filePaths = Array.isArray(filesList) ? filesList.map((f: any) => f.path) : [];

        // Check workflows
        const hasWorkflows = fileNames.some((n: string) => n.toLowerCase() === '.github') 
          ? (await this.safeFetch(`https://api.github.com/repos/${repoPath}/contents/.github/workflows`).then(res => res ? JSON.parse(res).length > 0 : false).catch(() => false))
          : false;

        // Releases
        const releasesJsonStr = await this.safeFetch(`https://api.github.com/repos/${repoPath}/releases`);
        const releasesList = releasesJsonStr ? JSON.parse(releasesJsonStr) : [];
        const latestRelease = Array.isArray(releasesList) && releasesList.length > 0 ? releasesList[0] : null;

        // Fetch latest commit details (Exactly once as part of the metadata snapshot)
        let latestCommitSha: string | undefined;
        let latestCommitAt: string | undefined;
        try {
          const commitsJsonStr = await this.safeFetch(`https://api.github.com/repos/${repoPath}/commits?per_page=1`);
          const commitsList = commitsJsonStr ? JSON.parse(commitsJsonStr) : [];
          if (Array.isArray(commitsList) && commitsList.length > 0) {
            latestCommitSha = commitsList[0].sha;
            latestCommitAt = commitsList[0].commit?.committer?.date || commitsList[0].commit?.author?.date;
          }
        } catch (err) {}

        const presence = {
          CONTRIBUTING: fileNames.some(n => n.toUpperCase().startsWith('CONTRIBUTING')),
          SECURITY: fileNames.some(n => n.toUpperCase().startsWith('SECURITY')),
          CODE_OF_CONDUCT: fileNames.some(n => n.toUpperCase().startsWith('CODE_OF_CONDUCT')),
          CHANGELOG: fileNames.some(n => n.toUpperCase().startsWith('CHANGELOG') || n.toUpperCase().startsWith('HISTORY')),
          workflows: hasWorkflows,
          test_related: fileNames.some(n => n.toLowerCase().includes('test') || n.toLowerCase().includes('spec')) || filePaths.some(p => p.toLowerCase().includes('test') || p.toLowerCase().includes('spec')),
          package_manifest: fileNames.some(n => ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Gemfile', 'build.gradle', 'pom.xml'].includes(n)),
          container_build: fileNames.some(n => ['Dockerfile', 'docker-compose.yml', 'Containerfile'].includes(n))
        };

        const metadataSummary = {
          stargazers_count: repoData.stargazers_count,
          forks_count: repoData.forks_count,
          open_issues_count: repoData.open_issues_count,
          license_spdx: repoData.license ? (repoData.license.spdx_id || repoData.license.key || 'unknown') : 'unknown',
          created_at: repoData.created_at,
          updated_at: repoData.updated_at,
          pushed_at: repoData.pushed_at,
          default_branch: repoData.default_branch,
          latest_release_date: latestRelease ? latestRelease.published_at : 'unknown',
          latest_release_tag: latestRelease ? latestRelease.tag_name : 'unknown',
          contributors_count: 'unknown',
          presence: presence
        };

        // Create the Immutable GitHub Metadata Snapshot
        const snapshot: GitHubMetadataSnapshot = {
          snapshot_id: snapshotId,
          fetched_at: new Date().toISOString(),
          repository_full_name: repoData.full_name || repoPath,
          repository_url: repoData.html_url || candidate.canonicalUrl,
          default_branch: repoData.default_branch || 'main',
          stars: repoData.stargazers_count,
          forks: repoData.forks_count,
          open_issues: repoData.open_issues_count,
          latest_commit_sha: latestCommitSha,
          latest_commit_at: latestCommitAt || repoData.pushed_at,
          license: repoData.license ? (repoData.license.spdx_id || repoData.license.key || 'unknown') : 'unknown',
          archived: repoData.archived || false,
          homepage: typeof repoData.homepage === 'string' && repoData.homepage.trim() !== ''
            ? repoData.homepage.trim()
            : null
        };
        this.metadataSnapshot = snapshot;

        const apiEvidenceId = `ev-${crypto.createHash('md5').update(`https://api.github.com/repos/${repoPath}`).digest('hex').substring(0,8)}`;
        const apiEvidence = {
          evidence_id: apiEvidenceId,
          type: 'api_metadata',
          url: `https://api.github.com/repos/${repoPath}`,
          title: `${candidate.name} GitHub API Metadata`,
          retrieved_at: new Date().toISOString(),
          content_hash: crypto.createHash('sha256').update(JSON.stringify(metadataSummary)).digest('hex'),
          summary: JSON.stringify(metadataSummary, null, 2),
          snapshot_id: snapshotId,
          claims: [{
            claim_id: `${apiEvidenceId}-metadata`,
            text: `GitHub API metadata for ${repoData.full_name || repoPath} was captured in snapshot ${snapshotId}.`,
            claim_type: 'confirmed_fact' as const
          }]
        };
        addEvidence(apiEvidence);

        const defaultBranch = repoData.default_branch || 'main';
        const readmeEvidence = await fetchEvidence(`https://raw.githubusercontent.com/${repoPath}/${defaultBranch}/README.md`, 'readme', `${candidate.name} README`, 12000);
        addEvidence(readmeEvidence);

        // Collect actual source evidence files (manifest, workflow, test file, core source code)
        const candidatesForEvidence: { path: string; type: string; title: string }[] = [];

        // 1. Dependency manifest
        const manifestFiles = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Gemfile', 'build.gradle', 'pom.xml'];
        const foundManifest = Array.isArray(filesList) ? filesList.find((f: any) => f.type === 'file' && manifestFiles.includes(f.name)) : null;
        if (foundManifest) {
          candidatesForEvidence.push({
            path: foundManifest.path,
            type: 'dependency_manifest',
            title: `Dependency Manifest (${foundManifest.name})`
          });
        }

        // 2. CI workflow
        const githubDir = Array.isArray(filesList) ? filesList.find((f: any) => f.name.toLowerCase() === '.github' && f.type === 'dir') : null;
        if (githubDir) {
          try {
            const workflowsJson = await this.safeFetch(`https://api.github.com/repos/${repoPath}/contents/.github/workflows`);
            const workflowsList = workflowsJson ? JSON.parse(workflowsJson) : [];
            if (Array.isArray(workflowsList)) {
              const ymlFile = workflowsList.find((f: any) => f.type === 'file' && (f.name.endsWith('.yml') || f.name.endsWith('.yaml')));
              if (ymlFile) {
                candidatesForEvidence.push({
                  path: ymlFile.path,
                  type: 'ci_workflow',
                  title: `CI Workflow (${ymlFile.name})`
                });
              }
            }
          } catch (err) {}
        }

        // 3. Test files
        const testDir = Array.isArray(filesList) ? filesList.find((f: any) => (f.name.toLowerCase() === 'tests' || f.name.toLowerCase() === 'test') && f.type === 'dir') : null;
        if (testDir) {
          try {
            const testFilesJson = await this.safeFetch(`https://api.github.com/repos/${repoPath}/contents/${testDir.path}`);
            const testFilesList = testFilesJson ? JSON.parse(testFilesJson) : [];
            if (Array.isArray(testFilesList)) {
              const testFile = testFilesList.find((f: any) => f.type === 'file' && (f.name.includes('test') || f.name.includes('spec')));
              if (testFile) {
                candidatesForEvidence.push({
                  path: testFile.path,
                  type: 'test_file',
                  title: `Test File (${testFile.name})`
                });
              }
            }
          } catch (err) {}
        } else if (Array.isArray(filesList)) {
          const testFile = filesList.find((f: any) => f.type === 'file' && (f.name.toLowerCase().includes('test') || f.name.toLowerCase().includes('spec')));
          if (testFile) {
            candidatesForEvidence.push({
              path: testFile.path,
              type: 'test_file',
              title: `Test File (${testFile.name})`
            });
          }
        }

        // 4. Source code. A representative source file, found by extension across the
        // languages JuryPress meets (Rust, C, Go, Java… — not only the JS/TS/Go/Python entry
        // filenames the previous detector knew) and across the directories projects actually
        // use. This is the evidence that lets technical quality be assessed; its absence is
        // the signal that it cannot be, so the detector must reflect the project, not its own
        // blind spots. See source-detection.ts.
        const rootEntries = Array.isArray(filesList) ? (filesList as RepoEntry[]) : [];
        const rootSource = pickRootSourceFile(rootEntries);
        if (rootSource) {
          candidatesForEvidence.push({
            path: rootSource.path,
            type: 'source_code',
            title: `Core Source File (${rootSource.name})`
          });
        } else {
          // Code in a subdirectory (a Rust workspace's crates/<name>/src, a Go cmd/<name>,
          // an internal/ package). One recursive tree listing sees the whole layout and picks
          // a representative file; see probeTreeForSourceFile.
          const srcFile = await this.probeTreeForSourceFile(repoPath, defaultBranch);
          if (srcFile) {
            candidatesForEvidence.push({
              path: srcFile.path,
              type: 'source_code',
              title: `Core Source File (${srcFile.name})`
            });
          }
        }

        // Fetch candidates (limit to 3 files to save tokens, aiming for at least 2)
        let manifestContent: string | undefined;
        let manifestFileName: string | undefined;

        let fetchedSourceCount = 0;
        for (const cand of candidatesForEvidence) {
          if (fetchedSourceCount >= 3) break;
          const fileUrl = `https://raw.githubusercontent.com/${repoPath}/${defaultBranch}/${cand.path}`;
          const ev = await fetchEvidence(fileUrl, cand.type, cand.title, 4000);
          if (ev) {
            addEvidence(ev);
            fetchedSourceCount++;
            if (cand.type === 'dependency_manifest') {
              manifestContent = ev.summary;
              manifestFileName = cand.path.split('/').pop();
            }
          }
        }

        // Resolve Project Identity using resolved README and manifest values.
        // The homepage is only fetched when README and manifest both fail to
        // name the project, so the official-website priority costs a request
        // only when it can actually decide the name. It goes through safeFetch
        // like every other request; identity gets no private fetch path.
        const readmeText = readmeEvidence?.summary;
        const namedByRepo = (readmeText && extractReadmeH1(readmeText))
          || (manifestContent && manifestFileName && extractPackageManifestName(manifestContent, manifestFileName));
        let officialSiteHtml: string | undefined;
        if (!namedByRepo && repoData.homepage) {
          officialSiteHtml = (await this.safeFetch(repoData.homepage, 0, false)) || undefined;
        }

        // Most repositories leave homepage empty while their organisation records the domain
        // the documentation actually lives on, so the owner is consulted as a fallback — and
        // only then, to spend no request when the repository has already answered.
        let ownerUrl: string | null = null;
        if (!repoData.homepage && repoData.owner?.login) {
          const ownerJson = await this.safeFetch(`https://api.github.com/users/${repoData.owner.login}`);
          if (ownerJson) {
            try {
              const owner = JSON.parse(ownerJson);
              ownerUrl = typeof owner.blog === 'string' && owner.blog.trim() !== '' ? owner.blog.trim() : null;
            } catch {
              // An unreadable owner record simply leaves the project without official docs.
            }
          }
        }

        // The snapshot is written before the owner is consulted, so it is completed here
        // rather than left recording only half of what the decision rested on.
        if (this.metadataSnapshot) this.metadataSnapshot.owner_url = ownerUrl;

        // Official documentation, from the domain GitHub reports as this repository's
        // homepage. This is where a project states what it supports — authentication modes,
        // local execution, pricing — and its absence is how a review ends up asserting the
        // opposite. Best effort throughout: a project with no homepage, or one that cannot be
        // reached, collects nothing extra and the review proceeds exactly as before.
        for (const docUrl of buildOfficialDocUrls({ homepage: repoData.homepage, ownerUrl, readmeText })) {
          addEvidence(await fetchEvidence(docUrl, 'official_docs', `Official documentation: ${docUrl}`, 6000));
        }

        this.projectIdentity = resolveProjectIdentity({
          readmeText,
          manifestContent,
          manifestFileName,
          repositoryFullName: repoData.full_name,
          sourceTitle: candidate.name,
          officialSiteHtml,
          officialWebsiteUrl: repoData.homepage
        });

      } catch (e: any) {
        console.warn(`Failed to collect GitHub metadata: ${e.message}`);
        if (isProduction) {
          throw new Error(`Mandatory GitHub metadata collection failed: ${e.message}`);
        }
      }
    } else if (isHuggingFace) {
      try {
        const parts = new URL(candidate.canonicalUrl).pathname.split('/').filter(Boolean);
        if (parts[0] === 'spaces' && parts.length >= 3) {
          const spacePath = `${parts[1]}/${parts[2]}`;
          const spaceJsonStr = await this.safeFetch(`https://huggingface.co/api/spaces/${spacePath}`);
          if (!spaceJsonStr) {
            throw new Error(`Failed to fetch HF space metadata: ${spacePath}`);
          }
          const spaceData = JSON.parse(spaceJsonStr);

          const metadataSummary = {
            likes: spaceData.likes || 0,
            sdk: spaceData.sdk || 'unknown',
            created_at: spaceData.createdAt || 'unknown',
            last_modified: spaceData.lastModified || 'unknown',
            license_spdx: spaceData.cardData ? (spaceData.cardData.license || 'unknown') : 'unknown',
            presence: {
              CONTRIBUTING: false,
              SECURITY: false,
              CODE_OF_CONDUCT: false,
              CHANGELOG: false,
              workflows: false,
              test_related: false,
              package_manifest: false,
              container_build: spaceData.sdk === 'docker'
            }
          };

          const apiEvidenceId = `ev-${crypto.createHash('md5').update(`https://huggingface.co/api/spaces/${spacePath}`).digest('hex').substring(0,8)}`;
          const apiEvidence = {
            evidence_id: apiEvidenceId,
            type: 'api_metadata',
            url: `https://huggingface.co/api/spaces/${spacePath}`,
            title: `${candidate.name} Hugging Face API Metadata`,
            retrieved_at: new Date().toISOString(),
            content_hash: crypto.createHash('sha256').update(JSON.stringify(metadataSummary)).digest('hex'),
            summary: JSON.stringify(metadataSummary, null, 2),
            claims: [{
              claim_id: `${apiEvidenceId}-metadata`,
              text: `Hugging Face API metadata for ${spacePath} was collected.`,
              claim_type: 'confirmed_fact' as const
            }]
          };
          addEvidence(apiEvidence);

          // Attempt to load README/app card
          const readmeEvidence = await fetchEvidence(`https://huggingface.co/spaces/${spacePath}/raw/main/README.md`, 'readme', `${candidate.name} README`, 12000);
          addEvidence(readmeEvidence);
        }
      } catch (e: any) {
        console.warn(`Failed to collect HF Space metadata: ${e.message}`);
        if (isProduction) {
          throw new Error(`Mandatory HuggingFace Space metadata collection failed: ${e.message}`);
        }
      }
    }

    // 2. Official landing page / documentation URL (if not already fetched via GitHub raw files)
    const officialEvidence = await fetchEvidence(candidate.canonicalUrl, 'official_site', candidate.name, 6000);
    addEvidence(officialEvidence);

    // 3. Source Discussion URL
    if (candidate.canonicalUrl !== candidate.sourceUrl) {
      const sourceEvidence = await fetchEvidence(candidate.sourceUrl, 'source_discussion', `Source: ${candidate.source}`, 4000);
      addEvidence(sourceEvidence);
    }

    // 4. Additional Evidence URLs
    if (candidate.additional_evidence_urls) {
      for (const url of candidate.additional_evidence_urls) {
        try {
          const addEvidenceVal = await fetchEvidence(url, 'additional_evidence', `${candidate.name} Additional Evidence`, 6000);
          addEvidence(addEvidenceVal);
        } catch (e) {}
      }
    }

    if (evidences.length < 2) {
      throw new Error("Failed to collect at least 2 unique evidences.");
    }

    this.discussionEvidence = {
      items: this.discussionItems
    };

    if (!this.projectIdentity) {
      let repositoryFullName: string | undefined;
      try {
        const parsed = new URL(candidate.canonicalUrl);
        repositoryFullName = parsed.pathname.replace(/^\/+|\/+$/g, '') || undefined;
      } catch {}
      this.projectIdentity = resolveProjectIdentity({
        repositoryFullName,
        sourceTitle: candidate.name
      });
    }

    if (!this.projectIdentity?.canonical_display_name) {
      throw new Error('Failed to resolve a canonical project identity.');
    }

    return {
      evidences,
      project_identity: this.projectIdentity,
      metadata_snapshot: this.metadataSnapshot,
      discussion_evidence: this.discussionEvidence,
      evaluation_integrity_version: "1.0.0",
      evidence_usage: {
        raw_character_count: this.evidenceUsage.raw_character_count,
        sanitized_character_count: this.evidenceUsage.sanitized_character_count
      }
    };
  }
}
