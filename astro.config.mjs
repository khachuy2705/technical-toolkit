// @ts-check
import { defineConfig } from 'astro/config';

// Canonical URLs and the sitemap need the deployed origin. Vercel exposes the
// production domain as VERCEL_PROJECT_PRODUCTION_URL; SITE_URL overrides it for
// a custom domain.
const site =
  process.env.SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : 'https://technical-toolkit.vercel.app');

export default defineConfig({
  site,
  output: 'static',
  // Directory format gives clean URLs (/tools/password-generator/) with no
  // server rules, which is what a static host wants.
  build: { format: 'directory' },
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
});
