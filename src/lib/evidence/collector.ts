import * as cheerio from 'cheerio';
import crypto from 'crypto';
import dns from 'dns';
import http from 'http';
import https from 'https';
import type { Candidate } from '../../schemas/selection';
import { EvidenceSchema, type Evidence } from '../../schemas/evidence';

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

  private async safeFetch(urlStr: string, redirects = 0): Promise<string | null> {
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
        const req = client.request(parsedUrl, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; JuryPress/1.0; +https://yosuke1024.github.io/jurypress)'
          },
          timeout: 10000
        }, (res) => {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            // follow redirect
            resolve(this.safeFetch(new URL(res.headers.location, urlStr).toString(), redirects + 1));
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
        const cleanText = isHtml ? this.sanitizeHtml(text) : text;
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
          // Verify schema before saving
          return EvidenceSchema.parse(evidenceData);
        } catch (e) {
          console.warn('Evidence schema validation failed for URL:', url);
          return null;
        }
      }
      return null;
    };

    // 1. Official Candidate URL
    const officialEvidence = await fetchEvidence(candidate.canonicalUrl, 'official_site', candidate.name, 6000);
    addEvidence(officialEvidence);

    // 2. Source Discussion URL
    if (candidate.canonicalUrl !== candidate.sourceUrl) {
      const sourceEvidence = await fetchEvidence(candidate.sourceUrl, 'source_discussion', `Source: ${candidate.source}`, 4000);
      addEvidence(sourceEvidence);
    }
    
    // 3. Fallback: If GitHub, fetch Repo API
    if (candidate.canonicalUrl.includes('github.com') && evidences.length < 2) {
      try {
        const repoPath = new URL(candidate.canonicalUrl).pathname.replace(/^\/|\/$/g, '');
        const apiEvidence = await fetchEvidence(`https://api.github.com/repos/${repoPath}`, 'api_metadata', `${candidate.name} API`, 4000);
        addEvidence(apiEvidence);
        
        const readmeEvidence = await fetchEvidence(`https://raw.githubusercontent.com/${repoPath}/HEAD/README.md`, 'readme', `${candidate.name} README`, 12000);
        addEvidence(readmeEvidence);
      } catch (e) {}
    }

    // 4. Fallback: If Hugging Face, fetch Space API
    if (candidate.canonicalUrl.includes('huggingface.co/spaces') && evidences.length < 2) {
      try {
        const parts = new URL(candidate.canonicalUrl).pathname.split('/').filter(Boolean);
        if (parts[0] === 'spaces' && parts.length >= 3) {
          const apiEvidence = await fetchEvidence(`https://huggingface.co/api/spaces/${parts[1]}/${parts[2]}`, 'api_metadata', `${candidate.name} API`, 4000);
          addEvidence(apiEvidence);
        }
      } catch (e) {}
    }

    if (evidences.length < 2) {
      throw new Error("Failed to collect at least 2 unique evidences.");
    }

    return evidences;
  }
}
