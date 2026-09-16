export const SITE = {
  name: 'Technical Toolkit',
  /** Used for canonical URLs and the sitemap. Override via SITE_URL at build time. */
  url: import.meta.env['SITE_URL'] ?? 'https://technical-toolkit.vercel.app',
  tagline: 'Fast, private developer tools that run entirely in your browser.',
  description:
    'A growing collection of small developer and security tools. Everything runs client-side — nothing you type is ever sent anywhere.',
} as const;
