import * as cheerio from 'cheerio';
import crypto from 'crypto';
import dns from 'dns';
import http from 'http';
import https from 'https';
import type { Candidate } from '../../schemas/selection';
import { EvidenceSchema, type Evidence } from '../../schemas/evidence';

export class EvidenceCollector {
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
    $('script, style, noscript, iframe, frame, object, embed, canvas, video, audio').remove();
    return $('body').text().replace(/\s+/g, ' ').trim();
  }

  public async collect(candidate: Candidate): Promise<Evidence[]> {
    const evidences: Evidence[] = [];
    const uniqueUrls = new Set<string>();
    const uniqueIds = new Set<string>();
    
    const addEvidence = (ev: Evidence | null) => {
      if (ev && !uniqueIds.has(ev.evidence_id) && !uniqueUrls.has(ev.url)) {
        uniqueIds.add(ev.evidence_id);
        uniqueUrls.add(ev.url);
        evidences.push(ev);
      }
    };
    
    const fetchEvidence = async (url: string, type: string, title: string) => {
      const text = await this.safeFetch(url);
      if (text) {
        const isHtml = text.trim().startsWith('<');
        const cleanText = isHtml ? this.sanitizeHtml(text) : text;
        const hash = crypto.createHash('sha256').update(cleanText).digest('hex');
        
        const evidenceId = `ev-${crypto.createHash('md5').update(url).digest('hex').substring(0,8)}`;
        
        const evidenceData = {
          evidence_id: evidenceId,
          type: type,
          url: url,
          title: title,
          retrieved_at: new Date().toISOString(),
          content_hash: hash,
          summary: cleanText.substring(0, 100000), // Max 100k chars for LLM context, but mapped to summary
          claims: [] // empty for now, LLM will generate claims in its output based on this summary
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
    const officialEvidence = await fetchEvidence(candidate.canonicalUrl, 'official_site', candidate.name);
    addEvidence(officialEvidence);

    // 2. Source Discussion URL
    if (candidate.canonicalUrl !== candidate.sourceUrl) {
      const sourceEvidence = await fetchEvidence(candidate.sourceUrl, 'source_discussion', `Source: ${candidate.source}`);
      addEvidence(sourceEvidence);
    }
    
    // 3. Fallback: If GitHub, fetch Repo API
    if (candidate.canonicalUrl.includes('github.com') && evidences.length < 2) {
      try {
        const repoPath = new URL(candidate.canonicalUrl).pathname.replace(/^\/|\/$/g, '');
        const apiEvidence = await fetchEvidence(`https://api.github.com/repos/${repoPath}`, 'api_metadata', `${candidate.name} API`);
        addEvidence(apiEvidence);
      } catch (e) {}
    }

    // 4. Fallback: If Hugging Face, fetch Space API
    if (candidate.canonicalUrl.includes('huggingface.co/spaces') && evidences.length < 2) {
      try {
        const parts = new URL(candidate.canonicalUrl).pathname.split('/').filter(Boolean);
        if (parts[0] === 'spaces' && parts.length >= 3) {
          const apiEvidence = await fetchEvidence(`https://huggingface.co/api/spaces/${parts[1]}/${parts[2]}`, 'api_metadata', `${candidate.name} API`);
          addEvidence(apiEvidence);
        }
      } catch (e) {}
    }

    return evidences;
  }
}
