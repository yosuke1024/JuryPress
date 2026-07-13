import type { Candidate } from '../../schemas/selection';
import type { SourceAdapter } from './adapter';
import { SourceError } from './adapter';

export class HuggingFaceAdapter implements SourceAdapter {
  constructor(public id: string) {}

  async fetchCandidates(date: Date): Promise<Candidate[]> {
    try {
      const url = `https://huggingface.co/api/spaces?sort=likes&direction=-1&limit=50`;
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch HF spaces: ${response.status}`);
      }

      const items = await response.json();

      const candidates: Candidate[] = [];
      const collectedAt = new Date().toISOString();
      let rank = 1;

      for (const item of items) {
        if (!item.id) continue;
        
        candidates.push({
          source: this.id,
          sourceId: item.id,
          name: item.id.split('/').pop() || item.id, // Usually "author/SpaceName", we want "SpaceName"
          canonicalUrl: `https://huggingface.co/spaces/${item.id}`,
          sourceUrl: `https://huggingface.co/spaces/${item.id}`,
          sourceRank: rank++,
          popularityValue: item.likes || 0,
          popularityUnit: 'likes',
          publishedAt: item.lastModified || item.createdAt,
          collectedAt,
          metadata: {
            author: item.author,
            sdk: item.sdk
          }
        });
      }

      return candidates;
    } catch (e) {
      throw new SourceError('Failed to fetch from Hugging Face', this.id, e);
    }
  }
}
