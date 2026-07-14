import * as cheerio from 'cheerio';
import crypto from 'crypto';
import dns from 'dns';
import http from 'http';
import https from 'https';
import type { Candidate } from '../../schemas/selection';
import { EvidenceSchema, type Evidence } from '../../schemas/evidence';
import { resolveDataMode } from '../content-root';

export class EvidenceCollector {
  public evidenceUsage = {
    raw_character_count: 0,
    sanitized_character_count: 0,
    characters_sent_to_model: 0,
    budget_limit: 24000,
    reduction_ratio: 0 as number | null
  };

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

  private extractHnComments(html: string): string {
    const $ = cheerio.load(html);
    const comments: string[] = [];
    $('.commtext').each((_, el) => {
      const txt = $(el).text().trim();
      if (txt) comments.push(txt);
    });
    const limited = comments.slice(0, 15);
    return limited.map((c, i) => `Comment ${i+1}: ${c}`).join('\n\n');
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
    const evidences: Evidence[] = [];
    const uniqueUrls = new Set<string>();
    const uniqueIds = new Set<string>();
    const uniqueHashes = new Set<string>();
    
    const addEvidence = (ev: Evidence | null) => {
      if (ev && !uniqueIds.has(ev.evidence_id) && !uniqueUrls.has(ev.url) && !uniqueHashes.has(ev.content_hash)) {
        uniqueIds.add(ev.evidence_id);
        uniqueUrls.add(ev.url);
        uniqueHashes.add(ev.content_hash);
        evidences.push(ev);
      }
    };
    
    const fetchEvidence = async (url: string, type: string, title: string, maxLen: number) => {
      const text = await this.safeFetch(url);
      if (text) {
        this.evidenceUsage.raw_character_count += text.length;
        const isHtml = text.trim().startsWith('<');
        let cleanText = text;
        if (isHtml) {
          let isHn = false;
          try {
            const parsed = new URL(url);
            isHn = parsed.hostname === 'news.ycombinator.com';
          } catch (e) {}

          if (type === 'source_discussion' && isHn) {
            cleanText = this.extractHnComments(text);
          } else {
            cleanText = this.sanitizeHtml(text);
          }
        }
        this.evidenceUsage.sanitized_character_count += cleanText.length;
        
        const hash = crypto.createHash('sha256').update(cleanText).digest('hex');
        const evidenceId = `ev-${crypto.createHash('md5').update(url).digest('hex').substring(0,8)}`;
        
        const evidenceData = {
          evidence_id: evidenceId,
          type: type,
          url: url,
          title: title,
          retrieved_at: new Date().toISOString(),
          content_hash: hash,
          summary: this.truncateSmart(cleanText, maxLen),
          claims: []
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
          contributors_count: repoData.subscribers_count || 'unknown',
          presence: presence
        };

        const apiEvidenceId = `ev-${crypto.createHash('md5').update(`https://api.github.com/repos/${repoPath}`).digest('hex').substring(0,8)}`;
        const apiEvidence = {
          evidence_id: apiEvidenceId,
          type: 'api_metadata',
          url: `https://api.github.com/repos/${repoPath}`,
          title: `${candidate.name} GitHub API Metadata`,
          retrieved_at: new Date().toISOString(),
          content_hash: crypto.createHash('sha256').update(JSON.stringify(metadataSummary)).digest('hex'),
          summary: JSON.stringify(metadataSummary, null, 2),
          claims: []
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

        // 4. Source code entry point
        const entryFiles = ['index.ts', 'index.js', 'main.go', 'app.py', 'main.py', 'src/index.ts', 'src/main.ts', 'src/index.js'];
        const foundEntry = Array.isArray(filesList) ? filesList.find((f: any) => f.type === 'file' && entryFiles.includes(f.name)) : null;
        if (foundEntry) {
          candidatesForEvidence.push({
            path: foundEntry.path,
            type: 'source_code',
            title: `Main Entry Point (${foundEntry.name})`
          });
        } else {
          const srcDir = Array.isArray(filesList) ? filesList.find((f: any) => f.name.toLowerCase() === 'src' && f.type === 'dir') : null;
          if (srcDir) {
            try {
              const srcFilesJson = await this.safeFetch(`https://api.github.com/repos/${repoPath}/contents/src`);
              const srcFilesList = srcFilesJson ? JSON.parse(srcFilesJson) : [];
              if (Array.isArray(srcFilesList)) {
                const srcFile = srcFilesList.find((f: any) => f.type === 'file' && (f.name.endsWith('.ts') || f.name.endsWith('.js') || f.name.endsWith('.go') || f.name.endsWith('.py')));
                if (srcFile) {
                  candidatesForEvidence.push({
                    path: srcFile.path,
                    type: 'source_code',
                    title: `Core Source File (${srcFile.name})`
                  });
                }
              }
            } catch (err) {}
          }
        }

        // Fetch candidates (limit to 3 files to save tokens, aiming for at least 2)
        let fetchedSourceCount = 0;
        for (const cand of candidatesForEvidence) {
          if (fetchedSourceCount >= 3) break;
          const fileUrl = `https://raw.githubusercontent.com/${repoPath}/${defaultBranch}/${cand.path}`;
          const ev = await fetchEvidence(fileUrl, cand.type, cand.title, 4000);
          if (ev) {
            addEvidence(ev);
            fetchedSourceCount++;
          }
        }

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
            claims: []
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

    return evidences;
  }
}
