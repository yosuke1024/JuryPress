import type { APIRoute } from 'astro';
import { getAllReviews } from '../../lib/data';
import { buildOgSvg, renderOgPng } from '../../lib/og-image';

export async function getStaticPaths() {
  const reviews = getAllReviews();
  return reviews.map((r: any) => ({
    params: { slug: r.slug },
    props: { entry: r },
  }));
}

export const GET: APIRoute = async ({ props }) => {
  const png = await renderOgPng(buildOgSvg(props.entry, 'raster'));

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
    },
  });
};
