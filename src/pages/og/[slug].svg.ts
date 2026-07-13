import type { APIRoute } from 'astro';
import { getAllReviews } from '../../lib/data';

export async function getStaticPaths() {
  const reviews = getAllReviews();
  return reviews.map((r: any) => ({
    params: { slug: r.slug },
    props: { entry: r },
  }));
}

export const GET: APIRoute = async ({ props }) => {
  const { entry } = props;
  const { review, selection } = entry;
  
  function escapeXml(unsafe: string) {
    return unsafe.replace(/[<>&'"]/g, function (c) {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
      }
      return c;
    });
  }

  const title = escapeXml(review.evaluation.article.headline.substring(0, 60));
  const score = review.jury_score.toFixed(1);
  const source = escapeXml(selection.source);

  const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="#111111"/>
    <text x="600" y="200" font-family="sans-serif" font-size="64" font-weight="bold" fill="#ffffff" text-anchor="middle">${title}</text>
    <text x="600" y="320" font-family="sans-serif" font-size="120" font-weight="bold" fill="#ff4081" text-anchor="middle">${score} / 100</text>
    <text x="600" y="450" font-family="sans-serif" font-size="40" fill="#cccccc" text-anchor="middle">JuryPress Review - ${source}</text>
    <rect x="0" y="600" width="1200" height="30" fill="#ff4081"/>
  </svg>`;

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
    },
  });
};
