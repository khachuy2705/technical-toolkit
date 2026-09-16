import type { APIRoute } from 'astro';
import { SITE } from '../data/site';

/**
 * Generated rather than kept in `public/` so the sitemap line always points at
 * the origin this build was made for — a hardcoded URL silently rots the moment
 * the project gets a custom domain.
 */
export const GET: APIRoute = ({ site }) => {
  const origin = (site ?? new URL(SITE.url)).origin;

  return new Response(
    `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`,
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
  );
};
