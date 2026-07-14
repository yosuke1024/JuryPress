import { getAllReviews } from '../../lib/data';
import { getConsensus } from '../../lib/verdict';
import { withBase } from '../../lib/base';

export const prerender = true;

export async function GET() {
  try {
    const reviews = getAllReviews();
    
    // sort by published date descending
    reviews.sort((a, b) => new Date(b.review.published_at).getTime() - new Date(a.review.published_at).getTime());
    
    if (reviews.length === 0) {
      return new Response(JSON.stringify({ error: 'No reviews found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const latest = reviews[0];
    const consensus = getConsensus(latest.review.judge_score_range);
    
    const data = {
      title: latest.review.evaluation.article.headline,
      score: latest.review.jury_score,
      verdictDate: latest.review.published_at,
      consensusLabel: consensus.label,
      reviewUrl: withBase(`/reviews/${latest.slug}/`)
    };
    
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600'
      }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
