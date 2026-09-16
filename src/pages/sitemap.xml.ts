import type { APIRoute } from 'astro';
import { LIVE_TOOLS } from '../data/tools';
import { SITE } from '../data/site';

/**
 * Hand-rolled instead of pulling in @astrojs/sitemap: the page set is small,
 * fully known from the registry, and this way a planned tool never leaks into
 * the sitemap before it ships.
 */
const STATIC_PATHS = ['/', '/about/', '/privacy/'];

export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL(SITE.url)).origin;
  const paths = [...STATIC_PATHS, ...LIVE_TOOLS.map((tool) => `/tools/${tool.slug}/`)];

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map((path) => `  <url><loc>${origin}${path}</loc></url>`).join('\n')}
</urlset>
`;

  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
