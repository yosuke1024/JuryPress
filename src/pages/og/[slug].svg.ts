import type { APIRoute } from 'astro';
import { getAllReviews } from '../../lib/data';
import { getConsensus } from '../../lib/verdict';

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

  const productName = escapeXml(review.evaluation.product.name);
  const headline = escapeXml(
    review.evaluation.article.headline.length > 55 
      ? review.evaluation.article.headline.substring(0, 52) + '...'
      : review.evaluation.article.headline
  );
  
  const score = review.jury_score.toFixed(1);
  const minScore = review.judge_score_range.min.toFixed(1);
  const maxScore = review.judge_score_range.max.toFixed(1);
  const source = escapeXml(selection.source);
  const date = new Date(review.published_at).toISOString().split('T')[0];

  // Calculate Consensus Label
  const { label: consensusLabel } = getConsensus(review.judge_score_range);

  const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
    <!-- Warm paper canvas background -->
    <rect width="100%" height="100%" fill="#f4efe6"/>
    
    <!-- Outer thin border -->
    <rect x="30" y="30" width="1140" height="570" fill="none" stroke="#d5ccbd" stroke-width="1"/>
    <rect x="40" y="40" width="1120" height="550" fill="none" stroke="#aaa091" stroke-width="1"/>

    <!-- Header Border -->
    <line x1="80" y1="110" x2="1120" y2="110" stroke="#d5ccbd" stroke-width="1"/>
    
    <!-- Header Content -->
    <text x="80" y="90" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18" font-weight="700" fill="#5f6762" letter-spacing="1">PixApps  /  JuryPress</text>
    <text x="1120" y="90" font-family="ui-sans-serif, system-ui, sans-serif" font-size="14" font-weight="700" fill="#b85c2d" letter-spacing="2" text-anchor="end">HUMAN EDITING DISCLOSED · EXPERIMENT</text>

    <!-- Product name (large, bold editorial serif) -->
    <text x="80" y="220" font-family="Georgia, 'Times New Roman', serif" font-size="64" font-weight="800" fill="#17201d" letter-spacing="-1">${productName}</text>
    
    <!-- Shortened editorial headline -->
    <text x="80" y="290" font-family="ui-sans-serif, system-ui, sans-serif" font-size="28" font-weight="500" fill="#5f6762" line-height="1.4">${headline}</text>
    
    <!-- Table style ruler dividing metadata -->
    <line x1="80" y1="460" x2="720" y2="460" stroke="#d5ccbd" stroke-width="1"/>
    
    <!-- 5-Judge initials circles representation -->
    <g transform="translate(80, 500)">
      <!-- Alex -->
      <circle cx="20" cy="0" r="20" fill="#fffdf8" stroke="#17201d" stroke-width="1.5" />
      <text x="20" y="5" font-family="Georgia" font-size="14" font-weight="bold" fill="#17201d" text-anchor="middle">A</text>
      <!-- David -->
      <circle cx="65" cy="0" r="20" fill="#fffdf8" stroke="#17201d" stroke-width="1.5" />
      <text x="65" y="5" font-family="Georgia" font-size="14" font-weight="bold" fill="#17201d" text-anchor="middle">D</text>
      <!-- Lisa -->
      <circle cx="110" cy="0" r="20" fill="#fffdf8" stroke="#17201d" stroke-width="1.5" />
      <text x="110" y="5" font-family="Georgia" font-size="14" font-weight="bold" fill="#17201d" text-anchor="middle">L</text>
      <!-- Sarah -->
      <circle cx="155" cy="0" r="20" fill="#fffdf8" stroke="#17201d" stroke-width="1.5" />
      <text x="155" y="5" font-family="Georgia" font-size="14" font-weight="bold" fill="#17201d" text-anchor="middle">S</text>
      <!-- Marcus -->
      <circle cx="200" cy="0" r="20" fill="#fffdf8" stroke="#17201d" stroke-width="1.5" />
      <text x="200" y="5" font-family="Georgia" font-size="14" font-weight="bold" fill="#17201d" text-anchor="middle">M</text>
      
      <text x="240" y="5" font-family="ui-sans-serif, system-ui, sans-serif" font-size="14" font-weight="600" fill="#7a817c">5 AI JUDGES</text>
    </g>

    <!-- Source and Date info -->
    <text x="80" y="550" font-family="ui-sans-serif, system-ui, sans-serif" font-size="14" font-weight="700" fill="#7a817c">SOURCE: ${source.toUpperCase()}  ·  PUBLISHED: ${date}</text>

    <!-- Right Side Score Box (Verdict Plate style) -->
    <g transform="translate(800, 160)">
      <rect x="0" y="0" width="320" height="340" fill="#fffdf8" stroke="#17201d" stroke-width="2" rx="4"/>
      
      <text x="160" y="40" font-family="ui-sans-serif, system-ui, sans-serif" font-size="14" font-weight="700" fill="#5f6762" letter-spacing="1" text-anchor="middle">JURY SCORE</text>
      
      <text x="160" y="140" font-family="ui-sans-serif, system-ui, sans-serif" font-size="96" font-weight="800" fill="#17201d" text-anchor="middle">${score}</text>
      <text x="160" y="175" font-family="ui-sans-serif, system-ui, sans-serif" font-size="20" font-weight="700" fill="#7a817c" text-anchor="middle">/ 100</text>
      
      <line x1="40" y1="210" x2="280" y2="210" stroke="#aaa091" stroke-width="1"/>
      
      <text x="160" y="245" font-family="ui-sans-serif, system-ui, sans-serif" font-size="16" font-weight="600" fill="#5f6762" text-anchor="middle">RANGE: ${minScore} – ${maxScore}</text>
      <text x="160" y="290" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18" font-weight="800" fill="#b85c2d" text-anchor="middle">${consensusLabel.toUpperCase()}</text>
    </g>
  </svg>`;

  return new Response(svg, {
    headers: {
      'Content-Type': 'image/svg+xml',
    },
  });
};
