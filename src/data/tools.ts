/**
 * The tool registry — the single source of truth for the site.
 *
 * The home page grid, the header navigation, the sitemap and the "other tools"
 * footer all derive from this array. Adding a tool means adding one entry here
 * and one page under `src/pages/tools/<slug>.astro`; nothing else needs to know.
 */

import type { Lang } from './i18n';

export type ToolStatus = 'live' | 'planned';

export type ToolGroupId = 'network' | 'security' | 'data' | 'time';

export interface ToolGroup {
  readonly id: ToolGroupId;
  readonly name: string;
  readonly vi: string;
}

/**
 * Display order of the groups. The home page renders one section per group,
 * the header links to each, and tool pages show their group's siblings.
 */
export const TOOL_GROUPS: readonly ToolGroup[] = [
  { id: 'network', name: 'Network', vi: 'Mạng' },
  { id: 'security', name: 'Security', vi: 'Bảo mật' },
  { id: 'data', name: 'Data formats', vi: 'Định dạng dữ liệu' },
  { id: 'time', name: 'Date & time', vi: 'Ngày giờ' },
];

/** A tool's own words, in one language. */
export interface ToolText {
  readonly name: string;
  readonly tagline: string;
  readonly description: string;
}

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
  readonly group: ToolGroupId;
  /**
   * Vietnamese name and tagline, for pages rendered in Vietnamese. The
   * description is only needed for a tool whose own page is Vietnamese.
   */
  readonly vi: { readonly name: string; readonly tagline: string; readonly description?: string };
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
    group: 'security',
    vi: { name: 'Tạo mật khẩu', tagline: 'Mật khẩu ngẫu nhiên, hiện độ mạnh tức thì.' },
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
    group: 'security',
    vi: { name: 'Tạo cụm mật khẩu', tagline: 'Cụm từ kiểu diceware, dễ nhớ.' },
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
    group: 'security',
    vi: { name: 'Tạo mã băm', tagline: 'MD5, SHA-256 và SHA-512 cho văn bản hoặc tệp.' },
  },
  {
    slug: 'certificate-generator',
    name: 'Certificate & CSR Generator',
    tagline: 'Your own CA, and the certificates under it.',
    description:
      'Generate a root CA, sign server and client certificates with it, or build a CSR to send to a real CA. Pick what each certificate is for, then export as PEM, PKCS#12 or a Java keystore. Keys are generated in your browser and never leave it.',
    keywords: [
      'certificate generator',
      'csr generator',
      'self signed certificate',
      'create root ca',
      'openssl alternative',
      'pkcs12 p12 keystore',
      'java keystore jks',
      'x509',
    ],
    icon: '<path d="M12 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z"/><path d="M8.5 11.5 7 22l5-3 5 3-1.5-10.5"/>',
    status: 'live',
    group: 'security',
    vi: {
      name: 'Tạo chứng thư số / CSR',
      tagline: 'Tự tạo CA và cấp chứng thư bên dưới nó.',
    },
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
    group: 'network',
    vi: { name: 'Tính subnet', tagline: 'Nhập IP và prefix, ra toàn bộ thông số mạng.' },
  },
  {
    slug: 'ip-range-to-cidr',
    name: 'IP Range to CIDR',
    tagline: 'Any address range as the fewest prefixes.',
    description:
      'Convert IPv4 or IPv6 address ranges into the smallest list of CIDR blocks that covers them exactly, as prefixes, masks or ACL wildcards.',
    keywords: ['ip range to cidr', 'range to cidr', 'cidr converter', 'ipv6 range to cidr', 'acl wildcard'],
    icon: '<path d="M4 12h16"/><path d="m8 8-4 4 4 4"/><path d="m16 8 4 4-4 4"/>',
    status: 'live',
    group: 'network',
    vi: { name: 'Đổi dải IP sang CIDR', tagline: 'Một dải địa chỉ thành ít prefix nhất.' },
  },
  {
    slug: 'cidr-aggregator',
    name: 'CIDR Aggregator',
    tagline: 'Merge a prefix list, or find its supernet.',
    description:
      'Merge overlapping and adjacent IPv4 or IPv6 prefixes into the fewest CIDR blocks, or summarise them into one supernet and see exactly how much extra space it covers.',
    keywords: ['cidr aggregator', 'supernet calculator', 'route summarization', 'merge cidr', 'ip list consolidation'],
    icon: '<path d="M4 6h6"/><path d="M4 12h6"/><path d="M4 18h6"/><path d="M10 6c4 0 4 6 8 6"/><path d="M10 18c4 0 4-6 8-6"/><path d="M10 12h10"/>',
    status: 'live',
    group: 'network',
    vi: { name: 'Gộp CIDR', tagline: 'Gộp danh sách prefix, hoặc tìm supernet.' },
  },
  {
    slug: 'cidr-splitter',
    name: 'CIDR Splitter',
    tagline: 'Cut a network into equal subnets.',
    description:
      'Split an IPv4 or IPv6 network into equal subnets, by count or by prefix length, with every subnet listed and exportable as CSV.',
    keywords: ['cidr splitter', 'subnet splitter', 'divide network', 'ipv6 subnetting', 'subnet list'],
    icon: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/><path d="M3 12h18"/>',
    status: 'live',
    group: 'network',
    vi: { name: 'Chia CIDR', tagline: 'Chia một mạng thành các subnet bằng nhau.' },
  },
  {
    slug: 'ipv6-calculator',
    name: 'IPv6 Calculator',
    tagline: 'Prefix, range, type and reverse DNS for IPv6.',
    description:
      'Work out the network, address range and size of any IPv6 prefix, with the RFC 5952 canonical and expanded forms, address type, embedded IPv4, EUI-64 MAC and ip6.arpa name.',
    keywords: ['ipv6 calculator', 'ipv6 subnet calculator', 'ipv6 prefix', 'ipv6 compress', 'ip6.arpa'],
    icon: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20"/><path d="M12 2a15 15 0 0 0 0 20"/>',
    status: 'live',
    group: 'network',
    vi: { name: 'Tính IPv6', tagline: 'Prefix, dải địa chỉ, loại và reverse DNS cho IPv6.' },
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
    group: 'time',
    vi: { name: 'Đổi epoch', tagline: 'Đổi Unix time sang ngày giờ và ngược lại.' },
  },
  {
    slug: 'lunar-calendar',
    name: 'Lunar Calendar Converter',
    tagline: 'Âm lịch to dương lịch and back, by Vietnamese rules.',
    description:
      'Convert between the Vietnamese lunar calendar and the Gregorian one, with leap months, Can Chi names and every month of a lunar year. Computed for Hanoi time, as the Vietnamese calendar is.',
    keywords: [
      'lunar calendar converter',
      'am lich',
      'doi ngay am duong',
      'vietnamese lunar calendar',
      'can chi',
      'tet date',
    ],
    icon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    status: 'live',
    group: 'time',
    vi: {
      name: 'Đổi lịch âm dương',
      tagline: 'Âm lịch sang dương lịch và ngược lại, theo lịch Việt Nam.',
      description:
        'Đổi ngày giữa âm lịch Việt Nam và dương lịch, có tháng nhuận, Can Chi và bảng các tháng trong năm. Tính theo giờ Hà Nội, đúng như lịch Việt Nam.',
    },
  },
  {
    slug: 'uuid-generator',
    name: 'UUID Generator',
    tagline: 'v4 and v7 identifiers, in bulk.',
    description: 'Generate RFC 4122 UUIDs locally in your browser.',
    keywords: ['uuid', 'guid', 'identifier'],
    icon: '<path d="M4 7V5a1 1 0 0 1 1-1h2"/><path d="M17 4h2a1 1 0 0 1 1 1v2"/><path d="M20 17v2a1 1 0 0 1-1 1h-2"/><path d="M7 20H5a1 1 0 0 1-1-1v-2"/><path d="M8 12h8"/>',
    status: 'planned',
    group: 'data',
    vi: { name: 'Tạo UUID', tagline: 'Mã định danh v4 và v7, tạo hàng loạt.' },
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
    group: 'data',
    vi: { name: 'Mã hoá Base64', tagline: 'Mã hoá và giải mã, giữ đúng tiếng Việt có dấu.' },
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
    group: 'data',
    vi: { name: 'Định dạng JSON', tagline: 'Làm đẹp, rút gọn và kiểm tra JSON.' },
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
    group: 'data',
    vi: { name: 'Định dạng YAML', tagline: 'Chỉnh YAML, hoặc chuyển qua lại với JSON.' },
  },
  {
    slug: 'jwt-decoder',
    name: 'JWT Decoder',
    tagline: 'Inspect header, payload and expiry.',
    description: 'Decode and inspect JSON Web Tokens locally in your browser.',
    keywords: ['jwt', 'json web token', 'decode'],
    icon: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
    status: 'planned',
    group: 'security',
    vi: { name: 'Giải mã JWT', tagline: 'Xem header, payload và thời hạn.' },
  },
];

export const LIVE_TOOLS = TOOLS.filter((t) => t.status === 'live');

export function liveToolsIn(group: ToolGroupId): Tool[] {
  return LIVE_TOOLS.filter((t) => t.group === group);
}

export function groupById(id: ToolGroupId): ToolGroup {
  return TOOL_GROUPS.find((g) => g.id === id)!;
}
export const PLANNED_TOOLS = TOOLS.filter((t) => t.status === 'planned');

export function toolBySlug(slug: string): Tool {
  const found = TOOLS.find((t) => t.slug === slug);
  if (!found) throw new Error(`Unknown tool: ${slug}`);
  return found;
}

/** The tool's name, tagline and description in `lang`, falling back to English. */
export function toolText(tool: Tool, lang: Lang): ToolText {
  if (lang === 'vi') {
    return {
      name: tool.vi.name,
      tagline: tool.vi.tagline,
      description: tool.vi.description ?? tool.description,
    };
  }
  return { name: tool.name, tagline: tool.tagline, description: tool.description };
}

export function toolHref(tool: Tool): string {
  return `/tools/${tool.slug}/`;
}
