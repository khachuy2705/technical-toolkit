/**
 * The tool registry — the single source of truth for the site.
 *
 * The home page grid, the header navigation, the sitemap and the "other tools"
 * footer all derive from this array. Adding a tool means adding one entry here
 * and one page under `src/pages/tools/<slug>.astro`; nothing else needs to know.
 */

export type ToolStatus = 'live' | 'planned';

export interface Tool {
  readonly slug: string;
  readonly name: string;
  /** One line, shown on the card. */
  readonly tagline: string;
  /** Full sentence, used for <meta name="description">. */
  readonly description: string;
  readonly keywords: readonly string[];
  /** Inner markup of a 24x24 stroked SVG. */
  readonly icon: string;
  readonly status: ToolStatus;
}

export const TOOLS: readonly Tool[] = [
  {
    slug: 'password-generator',
    name: 'Password Generator',
    tagline: 'Random passwords with a live strength readout.',
    description:
      'Generate strong random passwords in your browser. Tune length and character sets, exclude ambiguous glyphs, and see the exact entropy of every result.',
    keywords: ['password generator', 'random password', 'strong password', 'entropy'],
    icon: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
    status: 'live',
  },
  {
    slug: 'passphrase-generator',
    name: 'Passphrase Generator',
    tagline: 'Diceware phrases you can actually remember.',
    description:
      'Generate memorable diceware passphrases from the EFF wordlists. Pick word count, separators and capitalisation, with entropy shown for every combination.',
    keywords: ['passphrase generator', 'diceware', 'eff wordlist', 'memorable password'],
    icon: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M16 8h.01"/><path d="M8 8h.01"/><path d="M8 16h.01"/><path d="M16 16h.01"/><path d="M12 12h.01"/>',
    status: 'live',
  },
  {
    slug: 'hash-generator',
    name: 'Hash Generator',
    tagline: 'MD5, SHA-256 and SHA-512 over text or a file.',
    description:
      'Compute MD5, SHA-256 and SHA-512 digests of text or a file, entirely in your browser. All three are shown at once, so you never have to guess which one a checksum came from.',
    keywords: ['hash generator', 'md5', 'sha256', 'sha512', 'checksum'],
    icon: '<line x1="4" x2="20" y1="9" y2="9"/><line x1="4" x2="20" y1="15" y2="15"/><line x1="10" x2="8" y1="3" y2="21"/><line x1="16" x2="14" y1="3" y2="21"/>',
    status: 'live',
  },
  {
    slug: 'subnet-calculator',
    name: 'Subnet Calculator',
    tagline: 'Type an IP and prefix, get the whole network.',
    description:
      'Work out the subnet mask, network and broadcast address, usable host range and host count for any IPv4 network. Type an address with a prefix and everything updates as you go.',
    keywords: ['subnet calculator', 'cidr calculator', 'ipv4 subnet', 'netmask', 'network address'],
    icon: '<rect width="20" height="8" x="2" y="2" rx="2"/><rect width="20" height="8" x="2" y="14" rx="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
    status: 'live',
  },
  {
    slug: 'epoch-converter',
    name: 'Epoch Converter',
    tagline: 'Unix time in, every calendar reading out.',
    description:
      'Convert Unix timestamps to dates and back, in seconds, milliseconds, microseconds or nanoseconds. Read any log line in UTC, your own zone or any other, with the ISO week and day of year alongside.',
    keywords: [
      'epoch converter',
      'unix timestamp',
      'unix time converter',
      'epoch to date',
      'timestamp to date',
    ],
    icon: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    status: 'live',
  },
  {
    slug: 'uuid-generator',
    name: 'UUID Generator',
    tagline: 'v4 and v7 identifiers, in bulk.',
    description: 'Generate RFC 4122 UUIDs locally in your browser.',
    keywords: ['uuid', 'guid', 'identifier'],
    icon: '<path d="M4 7V5a1 1 0 0 1 1-1h2"/><path d="M17 4h2a1 1 0 0 1 1 1v2"/><path d="M20 17v2a1 1 0 0 1-1 1h-2"/><path d="M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M8 12h8"/>',
    status: 'planned',
  },
  {
    slug: 'base64',
    name: 'Base64 Encoder & Decoder',
    tagline: 'Round-trip text safely, including non-ASCII.',
    description:
      'Encode and decode Base64 in your browser, with correct UTF-8 handling and a URL-safe variant. Decoding accepts wrapped, unpadded and URL-safe input.',
    keywords: ['base64', 'encode', 'decode', 'base64url'],
    icon: '<path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/>',
    status: 'live',
  },
  {
    slug: 'json-formatter',
    name: 'JSON Formatter',
    tagline: 'Pretty-print, minify and validate.',
    description:
      'Format, minify and validate JSON in your browser. Parse errors are reported with the line and column that broke.',
    keywords: ['json formatter', 'json beautifier', 'json validator', 'minify json'],
    icon: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"/><path d="M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>',
    status: 'live',
  },
  {
    slug: 'yaml-formatter',
    name: 'YAML Formatter',
    tagline: 'Tidy YAML, or convert to and from JSON.',
    description:
      'Reindent and validate YAML, or convert between YAML and JSON, in your browser. Errors are reported with the line and column that broke.',
    keywords: ['yaml formatter', 'yaml to json', 'json to yaml', 'yaml validator'],
    icon: '<path d="M4 7V5a1 1 0 0 1 1-1h2"/><path d="M17 4h2a1 1 0 0 1 1 1v2"/><path d="M20 17v2a1 1 0 0 1-1 1h-2"/><path d="M7 20H5a1 1 0 0 1-1-1v-2"/><path d="m8 9 4 4 4-4"/><path d="M12 13v4"/>',
    status: 'live',
  },
  {
    slug: 'jwt-decoder',
    name: 'JWT Decoder',
    tagline: 'Inspect header, payload and expiry.',
    description: 'Decode and inspect JSON Web Tokens locally in your browser.',
    keywords: ['jwt', 'json web token', 'decode'],
    icon: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    status: 'planned',
  },
];

export const LIVE_TOOLS = TOOLS.filter((t) => t.status === 'live');
export const PLANNED_TOOLS = TOOLS.filter((t) => t.status === 'planned');

export function toolBySlug(slug: string): Tool {
  const found = TOOLS.find((t) => t.slug === slug);
  if (!found) throw new Error(`Unknown tool: ${slug}`);
  return found;
}

export function toolHref(tool: Tool): string {
  return `/tools/${tool.slug}/`;
}
