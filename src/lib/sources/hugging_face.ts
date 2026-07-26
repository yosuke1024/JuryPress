import type { Candidate } from '../../schemas/selection';
import type { SourceAdapter } from './adapter';
import { SourceError } from './adapter';

/**
 * "Hugging Face Rising": recently created Spaces gaining likes, ranked by like
 * velocity — NOT the all-time likes leaderboard.
 *
 * Pool construction (two free API calls, unioned by id):
 *   - top Spaces by likes (catches recent creations that already rose high)
 *   - newest Spaces by createdAt (catches early risers the likes sort misses)
 * Then filter to Spaces created within MAX_AGE_DAYS with likes inside
 * [MIN_LIKES, MAX_LIKES], and rank by likes per day since creation.
 *
 * A Space without a usable createdAt timestamp is dropped: recency cannot be
 * proven, and degrading to the all-time ranking is exactly the behavior this
 * source exists to avoid. An empty pool is acceptable — the weekday schedule
 * falls back to the next configured source.
 */
const MAX_AGE_DAYS = 180;
const MIN_LIKES = 20;
const MAX_LIKES = 5000;
const FETCH_LIMIT = 300;
const MIN_AGE_DAYS = 1;

export class HuggingFaceAdapter implements SourceAdapter {
  constructor(public id: string) {}

  private async fetchList(sort: string): Promise<any[]> {
    const url = `https://huggingface.co/api/spaces?sort=${sort}&direction=-1&limit=${FETCH_LIMIT}&full=true`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch HF spaces (sort=${sort}): ${response.status}`);
    }
    const items = await response.json();
    return Array.isArray(items) ? items : [];
  }

  async fetchCandidates(date: Date): Promise<Candidate[]> {
    try {
      // createdAt sort support is not guaranteed by the API; the likes list alone
      // still yields a valid (if smaller) pool, so its failure is non-fatal.
      const likesList = await this.fetchList('likes');
      let createdList: any[] = [];
      try {
        createdList = await this.fetchList('createdAt');
      } catch (e: any) {
        console.warn(`HF createdAt sort unavailable, continuing with likes pool only: ${e.message}`);
      }

      const byId = new Map<string, any>();
      for (const item of [...likesList, ...createdList]) {
        if (item && item.id && !byId.has(item.id)) byId.set(item.id, item);
      }

      const eligible: Array<{ item: any; ageDays: number; likes: number; velocity: number }> = [];
      for (const item of byId.values()) {
        const createdAt = item.createdAt ? new Date(item.createdAt).getTime() : NaN;
        if (!Number.isFinite(createdAt)) continue; // recency unprovable
        const ageDays = (date.getTime() - createdAt) / (1000 * 60 * 60 * 24);
        if (ageDays > MAX_AGE_DAYS || ageDays < 0) continue;
        const likes = item.likes || 0;
        if (likes < MIN_LIKES || likes > MAX_LIKES) continue;
        const velocity = likes / Math.max(MIN_AGE_DAYS, ageDays);
        eligible.push({ item, ageDays, likes, velocity });
      }

      eligible.sort((a, b) => {
        if (b.velocity !== a.velocity) return b.velocity - a.velocity;
        if (b.likes !== a.likes) return b.likes - a.likes;
        return String(a.item.id).localeCompare(String(b.item.id));
      });

      if (eligible.length === 0 && byId.size > 0) {
        console.warn(`HF pool empty after recency/likes filter (${byId.size} raw items); falling back to next source.`);
      }

      const candidates: Candidate[] = [];
      const collectedAt = new Date().toISOString();
      let rank = 1;

      for (const { item, likes, velocity } of eligible) {
        candidates.push({
          source: this.id,
          sourceId: item.id,
          name: item.id.split('/').pop() || item.id, // Usually "author/SpaceName", we want "SpaceName"
          canonicalUrl: `https://huggingface.co/spaces/${item.id}`,
          sourceUrl: `https://huggingface.co/spaces/${item.id}`,
          sourceRank: rank++,
          popularityValue: likes,
          popularityUnit: 'likes',
          publishedAt: item.createdAt || item.lastModified,
          collectedAt,
          metadata: {
            author: item.author,
            sdk: item.sdk,
            rank_by: 'likes_per_day',
            likes_per_day: Math.round(velocity * 100) / 100
          }
        });
      }

      return candidates;
    } catch (e) {
      throw new SourceError('Failed to fetch from Hugging Face', this.id, e);
    }
  }
}
