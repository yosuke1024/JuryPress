import type { APIRoute } from 'astro';
import { buildDefaultOgSvg, renderOgPng } from '../lib/og-image';

export const GET: APIRoute = async () => {
  const png = await renderOgPng(buildDefaultOgSvg('raster'));

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png',
    },
  });
};
